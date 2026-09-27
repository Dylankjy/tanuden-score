import { createHash } from 'crypto';
import { OutputDataFrame } from '@tanuden/rudolf';
import { mean, stdev } from 'stats-lite';
import { round } from 'lodash';
import driveRecordCollection from '../models/drive-record.collection';
import { LiveSession } from './live-sessions';
import { AnticheatStatus } from '../types/drive-evaluation';
import {
  MAX_CLOCK_DRIFT_RATIO,
  MAX_PHYSICS_INCONSISTENCY_RATIO,
  OUTLIER_MIN_RECORDS,
  OUTLIER_Z_SCORE_THRESHOLD
} from '../anti-cheat-constants';

// Normalizes each frame (rounds distance/speed so trivial floating-point
// jitter doesn't change the hash) before hashing the whole ordered sequence.
// Exact-match only — catches literally replaying a captured frame sequence,
// not a fuzzy/near-duplicate similarity search (a materially bigger build).
export const computeFrameFingerprint = (frames: OutputDataFrame[]): string => {
  const hash = createHash('sha256');
  for (const frame of frames) {
    hash.update(
      `${round(frame.physics.fromStartDistance, 0)}|${round(frame.physics.speed, 1)}|${frame.controllers.powerNotch}|${frame.controllers.brakeNotch};`
    );
  }
  return hash.digest('hex');
};

export const checkDuplicateSubmission = async (
  recordId: string,
  diagramNumber: string | null,
  frameFingerprint: string
): Promise<AnticheatStatus | null> => {
  if (!diagramNumber) {
    return null;
  }

  const match = await driveRecordCollection
    .findOne({
      diagramNumber,
      frameFingerprint,
      _id: { $ne: recordId }
    })
    .select('_id')
    .lean();

  if (!match) {
    return null;
  }

  return {
    reason: 'duplicate-submission',
    detail: { matchedRecordId: match._id.toString() }
  };
};

// Session-wide (not per-frame) so a single network hiccup can't false-positive
// — compares the drive's claimed simulated duration against the server's own
// observed wall-clock duration for the whole session.
export const checkClockDrift = (
  session: LiveSession,
  lastFrame: OutputDataFrame
): AnticheatStatus | null => {
  if (session.firstFrameElapsed === null) {
    return null;
  }

  const simElapsedSec = lastFrame.time.elapsed - session.firstFrameElapsed;
  const realElapsedSec = (Date.now() - session.sessionStartedAt) / 1000;
  if (realElapsedSec <= 0) {
    return null;
  }

  const ratio = simElapsedSec / realElapsedSec;
  if (ratio <= MAX_CLOCK_DRIFT_RATIO) {
    return null;
  }

  return {
    reason: 'clock-drift',
    detail: {
      simElapsedSec: round(simElapsedSec, 1),
      realElapsedSec: round(realElapsedSec, 1),
      ratio: round(ratio, 3)
    }
  };
};

export const checkPhysicsInconsistencyRatio = (
  session: LiveSession
): AnticheatStatus | null => {
  if (session.frameCount === 0) {
    return null;
  }

  const ratio = session.physicsInconsistencyCount / session.frameCount;
  if (ratio <= MAX_PHYSICS_INCONSISTENCY_RATIO) {
    return null;
  }

  return {
    reason: 'physics-correlation-anomaly',
    detail: {
      inconsistentFrames: session.physicsInconsistencyCount,
      totalFrames: session.frameCount,
      ratio: round(ratio, 4)
    }
  };
};

export const checkStatisticalOutlier = async (
  ownerId: string,
  diagramNumber: string | null,
  score: number
): Promise<AnticheatStatus | null> => {
  if (!diagramNumber) {
    return null;
  }

  const checkBaseline = (
    scores: number[],
    baseline: 'own' | 'population'
  ): AnticheatStatus | null => {
    if (scores.length < OUTLIER_MIN_RECORDS) {
      return null;
    }

    const baselineStdev = stdev(scores);
    if (baselineStdev === 0) {
      return null;
    }

    const zScore = (score - mean(scores)) / baselineStdev;
    if (Math.abs(zScore) <= OUTLIER_Z_SCORE_THRESHOLD) {
      return null;
    }

    return {
      reason: 'statistical-outlier',
      detail: { zScore: round(zScore, 2), baseline }
    };
  };

  const ownRecords = await driveRecordCollection
    .find({ owner: ownerId, diagramNumber, withheldReason: null })
    .select('aggregateScore.score')
    .lean();
  const ownOutlier = checkBaseline(
    ownRecords.map((r) => r.aggregateScore?.score ?? 0),
    'own'
  );
  if (ownOutlier) {
    return ownOutlier;
  }

  const populationRecords = await driveRecordCollection
    .find({ diagramNumber, withheldReason: null })
    .select('aggregateScore.score')
    .lean();
  return checkBaseline(
    populationRecords.map((r) => r.aggregateScore?.score ?? 0),
    'population'
  );
};
