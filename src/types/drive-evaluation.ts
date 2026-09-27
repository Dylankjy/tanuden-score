import { Types } from 'mongoose';
import { CarStaticInfo, LineDirection, Station } from '@tanuden/rudolf';

export type ScoreBreakdownReason =
  | 'insufficent-roll-prevention'
  | 'power-while-doors-opened'
  | 'overspeeding'
  | 'stop-overrun'
  | 'stop-overrun-large'
  | 'ats-triggered'
  | 'ats-eb-triggered'
  | 'stop-overrun-corrected'
  | 'stop-ok'
  | 'stop-perfect'
  | 'stop-within-bonus'
  | 'timeliness-arrival'
  | 'timeliness-departure'
  | 'timeliness-passing'
  | 'timeliness-departure-minute-early'
  | 'eco-driving'
  | 'consistency-arrival'
  | 'consistency-departure'
  | 'erratic-braking'
  | 'basic-braking-clean'
  | 'basic-braking-2-3'
  | 'stopping-smoothness'
  | 'stopping-jolt'
  | 'ride-quality'
  | 'line-speed-limit-compliance'
  | 'signal-speed-limit-compliance'
  | 'reacceleration-near-stop';

export interface ScoreBreakdown {
  timeframe?: Date;
  stationIndex?: number;
  reason: ScoreBreakdownReason;
  data: Array<string | number>;
  score: number;
  maxPossibleScore: number;
  type: 'Good' | 'Bad' | 'VeryBad' | 'Bonus';
}

// 'interrupted' (user-cancelled) is deliberately absent: a drive:cancel purges
// the drive_record and its drive_record_data entirely rather than persisting
// it in a withheld state — there is nothing to display for a deliberately
// cancelled run, so no terminal value is needed for it.
export type WithheldReason =
  'in-progress' | 'timed-out' | 'anticheat-violation';

export type AnticheatReason =
  | 'statistical-outlier'
  | 'physics-correlation-anomaly'
  | 'clock-drift'
  | 'duplicate-submission';

export interface AnticheatStatus {
  reason: AnticheatReason;
  detail?: Record<string, unknown>;
}

// drive_record is fully Rudolf-native: stations/consist/direction are stored
// exactly as Rudolf shapes them (Station[], CarStaticInfo[], LineDirection) —
// there is no legacy-compat translation anywhere in this document.
export interface DriveRecord {
  _id: string;
  owner: Types.ObjectId;
  aggregateScore: {
    score?: number;
    stopAccuracy?: number;
    timeliness?: number;
    ecoDriving?: number;
  };
  scoreBreakdown: ScoreBreakdown[];
  runNumber: string | null;
  diagramNumber: string | null;
  direction: LineDirection | null;
  boundFor: string | null;
  serviceType: string | null;
  length: number;
  consist: CarStaticInfo[];
  wattageSpent?: number;
  withheldReason: WithheldReason | null;
  anticheatStatus: AnticheatStatus | null;
  // TTL: expires 24h after creation while still 'in-progress' (guards against
  // a crashed/orphaned live session never reaching a terminal withheldReason);
  // unset once the drive reaches drive:complete or the disconnect-timeout
  // finalization, disabling auto-deletion entirely for a finished record.
  incompleteDeleteAt?: Date;
  // Populated at drive:complete only — hash of the normalized frame sequence,
  // used to catch a literal replay-and-resubmit of a captured recording (see
  // the duplicate-submission anti-cheat check).
  frameFingerprint?: string;
  stations: Station[];
  createdAt: Date;
  updatedAt: Date;
}
