import { Server, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { OutputDataFrame, SimulatorProfile } from '@tanuden/rudolf';
import { isAuthenticated } from '../middleware/socket-auth';
import { crashPrevent, errorResponseData } from '../utils/socket-error-handler';
import driveRecordCollection from '../models/drive-record.collection';
import driveRecordDataCollection from '../models/drive-record-data.collection';
import {
  createLiveSession,
  deleteLiveSession,
  getLiveSession,
  getLiveSessionByOwner
} from '../utils/live-sessions';
import { finalizeSession } from '../utils/recorder';
import { flushFrameBuffer } from '../utils/frame-buffer';
import {
  checkFrameRateExceeded,
  checkPhysicsPlausibility,
  isPhysicsInconsistent
} from '../utils/physics-plausibility';
import {
  emitLiveScoreEvents,
  maybeResetSegment
} from '../utils/live-score-events';
import {
  FRAME_FLUSH_INTERVAL_MS,
  RECONNECT_GRACE_MS
} from '../anti-cheat-constants';

const ensureAuthenticated = async (
  socket: Socket,
  ack: (res: unknown) => void
): Promise<boolean> => {
  if (socket.user) {
    return true;
  }

  try {
    await isAuthenticated(socket);
    return true;
  } catch (err) {
    ack(
      errorResponseData(
        'AUTHENTICATION_ERROR',
        err instanceof Error ? err.message : undefined
      )
    );
    return false;
  }
};

// Live drive-submission protocol: drive:profile (once) -> drive:frame
// (repeated, ~100ms fast-plane cadence) -> drive:complete, with drive:resume
// covering a reconnect and drive:cancel covering a deliberate early stop.
export const driveEvents = (_io: Server, socket: Socket) => {
  socket.on(
    'drive:profile',
    crashPrevent(
      async (profile: SimulatorProfile, ack: (res: unknown) => void) => {
        if (!(await ensureAuthenticated(socket, ack))) {
          return;
        }

        // Scoring is TrainCrew-only, mirroring ARISU (see data.event.ts). The
        // frame carries no adapter identity, so the profile's sim name is the
        // gate — reject and disconnect anything else (e.g. BVE). The value is
        // the Rudolf spec-canonical sim.name (§8.1, "TRAIN CREW" — space,
        // all-caps), exactly as the TrainCrew adapter emits it; do NOT rewrite
        // it to 'TrainCrew' (that literal disconnected every real session).
        if (profile.sim?.name !== 'TRAIN CREW') {
          ack(
            errorResponseData(
              'ADAPTER_NOT_SUPPORTED',
              'Scoring only supports TrainCrew. スコアリングはTrainCrewのみ対応しています。'
            )
          );
          return socket.disconnect(true);
        }

        const existingSession = getLiveSessionByOwner(socket.user!._id!);
        if (existingSession) {
          return ack({
            ...errorResponseData(
              'ACTIVE_SESSION_EXISTS',
              'This account already has an active drive session'
            ),
            recordId: existingSession.recordId
          });
        }

        // stations/runNumber/direction are backfilled from the first frame —
        // SimulatorProfile.scenario has no runNumber/direction field at all,
        // and the station timetable only ever arrives per-frame (see Phase B).
        const record = new driveRecordCollection({
          owner: socket.user!._id,
          diagramNumber: profile.scenario.diagramNumber,
          boundFor: profile.scenario.boundFor,
          serviceType: profile.scenario.serviceType,
          consist: profile.vehicle.cars
        });
        await record.save();

        const recordId = record._id.toString();
        createLiveSession(
          recordId,
          socket.user!._id!,
          socket,
          profile.scenarioId
        );
        socket.driveRecordId = recordId;

        ack({ recordId });
      }
    )
  );

  socket.on(
    'drive:resume',
    crashPrevent(
      async (
        { recordId }: { recordId?: string },
        ack: (res: unknown) => void
      ) => {
        if (!(await ensureAuthenticated(socket, ack))) {
          return;
        }
        if (!recordId) {
          return ack(errorResponseData('MISSING_RECORD_ID'));
        }

        const session = getLiveSession(recordId);
        if (!session || session.ownerId !== socket.user!._id) {
          return ack(errorResponseData('SESSION_NOT_RESUMABLE'));
        }

        if (session.timeoutTimer) {
          clearTimeout(session.timeoutTimer);
          session.timeoutTimer = null;
        }

        session.socket = socket;
        session.lastActivityAt = Date.now();
        socket.driveRecordId = recordId;

        ack({ ok: true });
      }
    )
  );

  socket.on(
    'drive:frame',
    crashPrevent(
      async (
        { recordId, frame }: { recordId?: string; frame?: OutputDataFrame },
        ack: (res: unknown) => void
      ) => {
        if (!recordId || !frame) {
          return ack(errorResponseData('MISSING_FRAME_DATA'));
        }

        const session = getLiveSession(recordId);
        if (!session || session.ownerId !== socket.user?._id) {
          return ack(errorResponseData('SESSION_NOT_FOUND'));
        }

        // scenarioId ties every document of one play-session together (see
        // Rudolf's envelope spec) — reject anything that doesn't match what
        // drive:profile started this session with, preventing frames from a
        // different session/scenario being spliced into an ongoing one.
        if (frame.scenarioId !== session.scenarioId) {
          return ack(errorResponseData('SCENARIO_MISMATCH'));
        }

        // Rolling-window check (not a single-gap check) so a brief reconnect
        // catch-up burst doesn't false-positive as long as the following
        // frames return to normal cadence.
        if (checkFrameRateExceeded(session)) {
          return ack(errorResponseData('FRAME_RATE_EXCEEDED'));
        }

        // First frame of the session: backfill the station timetable Rudolf
        // never sends via the profile, and the identity fields that only
        // exist on the frame's diagram section — no translation, straight
        // copy of the Rudolf shape.
        if (session.stations.length === 0 && frame.stations.list.length > 0) {
          session.stations = frame.stations.list;
          await driveRecordCollection.updateOne(
            { _id: recordId },
            {
              $set: {
                stations: frame.stations.list,
                length:
                  frame.stations.list[frame.stations.list.length - 1]
                    ?.fromStartDistance ?? 0,
                runNumber: frame.diagram.runNumber,
                direction: frame.diagram.direction
              }
            }
          );
        }

        if (session.firstFrameElapsed === null) {
          session.firstFrameElapsed = frame.time.elapsed;
        }

        const violation = checkPhysicsPlausibility(session.lastFrame, frame);
        if (violation) {
          return ack(errorResponseData('PHYSICS_VIOLATION', violation));
        }

        // Cross-signal correlation: soft/cumulative, not a per-frame reject
        // (see utils/recorder.ts::isPhysicsInconsistent for why).
        if (
          session.lastFrame &&
          isPhysicsInconsistent(session.lastFrame, frame)
        ) {
          session.physicsInconsistencyCount++;
        }
        session.frameCount++;

        session.frameBuffer.push(frame);
        if (Date.now() - session.lastFlushAt >= FRAME_FLUSH_INTERVAL_MS) {
          await flushFrameBuffer(recordId, session);
        }

        maybeResetSegment(session, session.lastFrame, frame);
        session.segmentBuffer.push(frame);
        emitLiveScoreEvents(session);

        session.lastFrame = frame;
        session.lastActivityAt = Date.now();

        ack({ ok: true });
      }
    )
  );

  socket.on(
    'drive:cancel',
    crashPrevent(
      async (
        { recordId }: { recordId?: string },
        ack: (res: unknown) => void
      ) => {
        if (!recordId) {
          return ack(errorResponseData('MISSING_RECORD_ID'));
        }

        const session = getLiveSession(recordId);
        if (!session || session.ownerId !== socket.user?._id) {
          return ack(errorResponseData('SESSION_NOT_FOUND'));
        }

        // A drive that's already completed (or is mid-completion) must never
        // be purged — the session only clears finalizing/leaves the map once
        // finalizeSession has actually run, so this also rejects a cancel
        // that arrives while completion is still in flight, not just after.
        if (session.finalizing) {
          return ack(
            errorResponseData(
              'DRIVE_ALREADY_COMPLETED',
              'This drive has already been completed and cannot be cancelled. このドライブは既に完了しているためキャンセルできません。'
            )
          );
        }

        // Deliberate cancellation purges rather than withholds — there is
        // nothing worth keeping for a run the player chose to abandon.
        await Promise.all([
          driveRecordCollection.deleteOne({ _id: recordId }),
          driveRecordDataCollection.deleteMany({
            parentRecord: new Types.ObjectId(recordId)
          })
        ]);

        deleteLiveSession(recordId);
        ack({ ok: true });
      }
    )
  );

  socket.on(
    'drive:complete',
    crashPrevent(
      async (
        { recordId }: { recordId?: string },
        ack: (res: unknown) => void
      ) => {
        if (!recordId) {
          return ack(errorResponseData('MISSING_RECORD_ID'));
        }

        const session = getLiveSession(recordId);
        if (!session || session.ownerId !== socket.user?._id) {
          return ack(errorResponseData('SESSION_NOT_FOUND'));
        }

        await finalizeSession(recordId, session);

        const record = await driveRecordCollection
          .findById(recordId)
          .select('-anticheatStatus');

        ack({
          ok: true,
          aggregateScore: record?.aggregateScore,
          withheldReason: record?.withheldReason
        });
      }
    )
  );

  socket.on('disconnect', () => {
    const recordId = socket.driveRecordId;
    if (!recordId) {
      return;
    }

    const session = getLiveSession(recordId);
    if (!session || session.socket.id !== socket.id) {
      return;
    }

    session.timeoutTimer = setTimeout(() => {
      void finalizeSession(recordId, session, {
        forceWithheldReason: 'timed-out'
      }).catch((err: unknown) => {
        console.error('Failed to finalize timed-out drive session', err);
      });
    }, RECONNECT_GRACE_MS);
  });
};
