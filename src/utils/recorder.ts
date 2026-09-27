import { Types } from 'mongoose';
import ms from 'ms';
import driveRecordCollection from '../models/drive-record.collection';
import driveRecordDataCollection from '../models/drive-record-data.collection';
import { LiveSession, deleteLiveSession } from './live-sessions';
import { computeDriveScore } from './compute-drive-score';
import { WithheldReason } from '../types/drive-evaluation';
import { flushFrameBuffer } from './frame-buffer';
import {
  checkClockDrift,
  checkDuplicateSubmission,
  checkPhysicsInconsistencyRatio,
  checkStatisticalOutlier,
  computeFrameFingerprint
} from './anticheat-checks';

// -- Finalization (drive:complete and the disconnect-timeout path) --------

export const finalizeSession = async (
  recordId: string,
  session: LiveSession,
  options: { forceWithheldReason?: Extract<WithheldReason, 'timed-out'> } = {}
): Promise<void> => {
  // Checked and set with no await between them, so a second caller for the
  // same session (drive:complete racing the disconnect-timeout path, or a
  // client that emitted drive:complete more than once) always sees this
  // before finalizeSession's own first await yields — without it, both runs
  // load the same Mongoose document version and the second one's record.save()
  // fails with a VersionError once the first has already saved.
  if (session.finalizing) {
    return;
  }
  session.finalizing = true;

  try {
    await finalizeSessionBody(recordId, session, options);
  } catch (err) {
    // A genuine failure (e.g. a transient Mongo error) shouldn't permanently
    // strand the session in a finalizing state no future retry can clear —
    // only a run that actually reached the end clears it via deleteLiveSession.
    session.finalizing = false;
    throw err;
  }
};

const finalizeSessionBody = async (
  recordId: string,
  session: LiveSession,
  options: { forceWithheldReason?: Extract<WithheldReason, 'timed-out'> }
): Promise<void> => {
  await flushFrameBuffer(recordId, session);

  const record = await driveRecordCollection.findById(recordId);
  if (!record) {
    deleteLiveSession(recordId);
    return;
  }

  const frameRows = await driveRecordDataCollection
    .find({ parentRecord: new Types.ObjectId(recordId) })
    .sort({ capturedAt: 1 })
    .lean();
  const frames = frameRows.map((row) => row.frame);
  const { stations, consist } = record;

  const { scoreBreakdown, aggregateScore, wattageSpent, totalScore } =
    computeDriveScore(frames, stations, consist);

  record.aggregateScore = aggregateScore;
  record.wattageSpent = wattageSpent;
  record.scoreBreakdown = scoreBreakdown;
  record.frameFingerprint = computeFrameFingerprint(frames);

  if (options.forceWithheldReason) {
    record.withheldReason = options.forceWithheldReason;
  } else {
    // Priority order: most concrete/certain signal first, most fuzzy last —
    // the first hit wins, later checks are skipped once withheldReason is set.
    const lastFrame = frames[frames.length - 1];
    const anticheat =
      (await checkDuplicateSubmission(
        recordId,
        record.diagramNumber,
        record.frameFingerprint
      )) ??
      (lastFrame ? checkClockDrift(session, lastFrame) : null) ??
      checkPhysicsInconsistencyRatio(session) ??
      (await checkStatisticalOutlier(
        record.owner.toString(),
        record.diagramNumber,
        totalScore
      ));

    record.withheldReason = anticheat ? 'anticheat-violation' : null;
    record.anticheatStatus = anticheat;
  }

  await record.save();

  // Finished — disable the abandoned-'in-progress' TTL entirely and extend
  // this record's frame retention from 24h to 30 days, regardless of outcome.
  await driveRecordCollection.updateOne(
    { _id: recordId },
    { $unset: { incompleteDeleteAt: 1 } }
  );
  await driveRecordDataCollection.updateMany(
    { parentRecord: new Types.ObjectId(recordId) },
    { $set: { expiresAt: new Date(Date.now() + ms('30d')) } }
  );

  deleteLiveSession(recordId);
};
