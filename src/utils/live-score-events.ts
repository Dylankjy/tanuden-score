import { OutputDataFrame } from '@tanuden/rudolf';
import { LiveSession } from './live-sessions';
import { resolveNextStationIndex } from './rudolf-station';
import { ATSEvaluation } from '../evaluations/ats.eval';
import { BrakeRegimeEvaluation } from '../evaluations/brake-regime.eval';
import { NotchOkiEvaluation } from '../evaluations/notchoki.eval';
import { OverspeedingEvaluation } from '../evaluations/overspeed.eval';
import { RideQualityEvaluation } from '../evaluations/ride-quality.eval';
import { RollPreventionEvaluation } from '../evaluations/rollprevention.eval';
import { StopPositionEvaluation } from '../evaluations/stop-position.eval';
import { StoppingJoltEvaluation } from '../evaluations/stopping-jolt.eval';
import { SEGMENT_OVERLAP_WINDOW_MS } from '../anti-cheat-constants';

// Only the evaluators whose formulas operate within a single station leg or
// need no history at all — eco-drive (whole-diagram energy) and timeliness's
// consistency bonuses (need every station visited so far) are diagram-wide
// running aggregates and are deliberately excluded; they only ever appear in
// the final drive:complete result.
const SEGMENT_SCOPED_EVALUATORS = [
  StopPositionEvaluation,
  RollPreventionEvaluation,
  NotchOkiEvaluation,
  ATSEvaluation,
  OverspeedingEvaluation,
  BrakeRegimeEvaluation,
  StoppingJoltEvaluation,
  RideQualityEvaluation
];

export const emitLiveScoreEvents = (session: LiveSession): void => {
  for (const EvaluatorClass of SEGMENT_SCOPED_EVALUATORS) {
    // consist is unused by every segment-scoped evaluator (only eco-drive
    // reads it, and it's excluded above) — safe to pass an empty array.
    const evaluator = new EvaluatorClass(
      session.segmentBuffer,
      session.stations,
      []
    );

    // The segment buffer keeps growing until the station is departed/passed —
    // never treat it as the final timeline (see BrakeRegimeEvaluation's
    // dataIsComplete doc comment for why closing a still-open window early
    // here could commit to a wrong, unfixable verdict).
    if (evaluator instanceof BrakeRegimeEvaluation) {
      evaluator.dataIsComplete = false;
    }

    const result = evaluator.evaluate();

    for (const entry of result.scoreBreakdown) {
      const key = `${entry.reason}:${entry.stationIndex}`;
      if (session.emittedEventKeys.has(key)) {
        continue;
      }

      session.emittedEventKeys.add(key);
      session.runningScoreTotal += entry.score;
      session.runningMaxPossibleTotal += entry.maxPossibleScore;

      const runningAccuracyPercent =
        session.runningMaxPossibleTotal > 0
          ? (session.runningScoreTotal / session.runningMaxPossibleTotal) * 100
          : 0;

      // One emit per entry — never batched/merged, even when a single
      // evaluator pass produces several new entries at once (e.g. a station
      // arrival can simultaneously trigger stop-ok + stop-perfect +
      // stop-within-bonus).
      session.socket.emit('drive:score-event', {
        ...entry,
        runningAccuracyPercent
      });
    }
  }
};

// Trims (not clears) the segment buffer when the train departs/passes a
// station, keeping a trailing overlap so a "stopped" frame and the
// "departing" frame that follows it are never split across the reset —
// departRecords() needs both present in the same array to detect a
// departure at all.
export const maybeResetSegment = (
  session: LiveSession,
  previousFrame: OutputDataFrame | null,
  currentFrame: OutputDataFrame
): void => {
  if (!previousFrame) {
    return;
  }

  const previousIndex = resolveNextStationIndex(
    previousFrame,
    session.stations
  );
  const currentIndex = resolveNextStationIndex(currentFrame, session.stations);
  if (previousIndex === currentIndex) {
    return;
  }

  const cutoff =
    new Date(currentFrame.sentAt).getTime() - SEGMENT_OVERLAP_WINDOW_MS;
  session.segmentBuffer = session.segmentBuffer.filter(
    (frame) => new Date(frame.sentAt).getTime() >= cutoff
  );
};
