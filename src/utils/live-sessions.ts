import { Socket } from 'socket.io';
import { OutputDataFrame, Station } from '@tanuden/rudolf';

// Keyed by drive_record _id, not socket.id — a reconnect gets a new socket.id
// but must resume the same session (see drive:resume in events/drive.event.ts).
export interface LiveSession {
  recordId: string;
  ownerId: string;
  socket: Socket;
  stations: Station[];
  lastFrame: OutputDataFrame | null;

  // Pending Mongo flush (time-based, ~5s) — cleared independently of station
  // boundaries.
  frameBuffer: OutputDataFrame[];
  lastFlushAt: number;

  // Live score-event feed. segmentBuffer trims down to a trailing overlap
  // (not cleared to empty) when the train departs/passes a station, bounding
  // the live-scoring evaluators' cost to "one station leg" without severing
  // the stopped/departing frame pair departure detection needs.
  segmentBuffer: OutputDataFrame[];
  runningScoreTotal: number;
  runningMaxPossibleTotal: number;
  emittedEventKeys: Set<string>;

  lastActivityAt: number;
  timeoutTimer: NodeJS.Timeout | null;

  // Set synchronously (no await before it) the instant finalizeSession
  // starts, so a concurrent drive:complete/disconnect-timeout/drive:cancel
  // for the same recordId always sees it before finalizeSession's own first
  // await yields — prevents two finalizeSession runs racing on the same
  // record (a duplicate save loses Mongoose's optimistic-concurrency check)
  // and stops drive:cancel from deleting a record that's already completed.
  finalizing: boolean;

  // Anti-cheat expansion:
  scenarioId: string;
  sessionStartedAt: number;
  firstFrameElapsed: number | null;
  physicsInconsistencyCount: number;
  frameCount: number;
  recentFrameArrivals: number[];
}

const sessions = new Map<string, LiveSession>();
// One active session per account — checked at drive:profile before a second
// concurrent session for the same user can be created.
const sessionsByOwner = new Map<string, string>();

export const getLiveSessionByOwner = (
  ownerId: string
): LiveSession | undefined => {
  const recordId = sessionsByOwner.get(ownerId);
  return recordId ? sessions.get(recordId) : undefined;
};

export const createLiveSession = (
  recordId: string,
  ownerId: string,
  socket: Socket,
  scenarioId: string
): LiveSession => {
  const now = Date.now();
  const session: LiveSession = {
    recordId,
    ownerId,
    socket,
    stations: [],
    lastFrame: null,
    frameBuffer: [],
    lastFlushAt: now,
    segmentBuffer: [],
    runningScoreTotal: 0,
    runningMaxPossibleTotal: 0,
    emittedEventKeys: new Set(),
    lastActivityAt: now,
    timeoutTimer: null,
    finalizing: false,
    scenarioId,
    sessionStartedAt: now,
    firstFrameElapsed: null,
    physicsInconsistencyCount: 0,
    frameCount: 0,
    recentFrameArrivals: []
  };
  sessions.set(recordId, session);
  sessionsByOwner.set(ownerId, recordId);
  return session;
};

export const getLiveSession = (recordId: string): LiveSession | undefined =>
  sessions.get(recordId);

export const deleteLiveSession = (recordId: string): void => {
  const session = sessions.get(recordId);
  if (session?.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
  }
  if (session && sessionsByOwner.get(session.ownerId) === recordId) {
    sessionsByOwner.delete(session.ownerId);
  }
  sessions.delete(recordId);
};
