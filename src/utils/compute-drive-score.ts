import { round } from 'lodash';
import { CarStaticInfo, OutputDataFrame, Station } from '@tanuden/rudolf';
import { ATSEvaluation } from '../evaluations/ats.eval';
import { BrakeRegimeEvaluation } from '../evaluations/brake-regime.eval';
import { EcoDriveEvaluation } from '../evaluations/eco-drive.eval';
import { NotchOkiEvaluation } from '../evaluations/notchoki.eval';
import { OverspeedingEvaluation } from '../evaluations/overspeed.eval';
import { ReaccelerationEvaluation } from '../evaluations/reacceleration.eval';
import { RideQualityEvaluation } from '../evaluations/ride-quality.eval';
import { RollPreventionEvaluation } from '../evaluations/rollprevention.eval';
import { SpeedLimitDecreaseEvaluation } from '../evaluations/speed-limit-decrease.eval';
import { StopPositionEvaluation } from '../evaluations/stop-position.eval';
import { StoppingJoltEvaluation } from '../evaluations/stopping-jolt.eval';
import { TimelinessEvaluation } from '../evaluations/timeliness.eval';
import { ScoreBreakdown } from '../types/drive-evaluation';

export interface ComputedDriveScore {
  scoreBreakdown: ScoreBreakdown[];
  aggregateScore: {
    score: number;
    stopAccuracy: number;
    timeliness: number;
    ecoDriving: number;
  };
  wattageSpent: number;
  // The raw pre-round sum, needed by the live finalizer's statistical-outlier
  // anti-cheat check (which grades against the distribution of totals).
  totalScore: number;
}

// Pure scoring core shared by the live drive:complete finalizer
// (utils/recorder.ts) and the offline re-scoring script
// (scripts/reevaluate-record.ts): runs every evaluator over a complete frame
// timeline and folds the results into the stored breakdown + aggregates.
// Deliberately free of any session / anti-cheat / persistence concern so both
// callers produce identical scoring — re-scoring an old record can never
// disagree with what a fresh drive would have produced.
export const computeDriveScore = (
  frames: OutputDataFrame[],
  stations: Station[],
  consist: CarStaticInfo[]
): ComputedDriveScore => {
  const evaluations = {
    ats: new ATSEvaluation(frames, stations, consist).evaluate(),
    brakeRegime: new BrakeRegimeEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    ecoDrive: new EcoDriveEvaluation(frames, stations, consist).evaluate(),
    notchOki: new NotchOkiEvaluation(frames, stations, consist).evaluate(),
    overspeed: new OverspeedingEvaluation(frames, stations, consist).evaluate(),
    reacceleration: new ReaccelerationEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    rideQuality: new RideQualityEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    rollPrevention: new RollPreventionEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    // stoppingJolt is placed before stopPosition so that, since both key off
    // the same arrival frame (identical timeframe), the frontend's stable
    // chronological sort renders the jolt item above the stop-position item.
    stoppingJolt: new StoppingJoltEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    speedLimitDecrease: new SpeedLimitDecreaseEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    stopPosition: new StopPositionEvaluation(
      frames,
      stations,
      consist
    ).evaluate(),
    timeliness: new TimelinessEvaluation(frames, stations, consist).evaluate()
  };

  // Last-resort guard: an evaluator producing a non-finite score (a divide-
  // by-zero edge case) must never reach Mongoose's Number schema as NaN — the
  // whole document's validation fails on save, discarding every other
  // evaluator's legitimate result along with it.
  const finite = (value: number): number =>
    Number.isFinite(value) ? value : 0;

  const overallBreakdown = Object.values(evaluations)
    .flatMap((evaluation) => evaluation.scoreBreakdown)
    .map((breakdown) => ({
      ...breakdown,
      score: finite(round(breakdown.score, 0))
    }));

  const totalScore = overallBreakdown.reduce((acc, cur) => acc + cur.score, 0);

  return {
    scoreBreakdown: overallBreakdown,
    aggregateScore: {
      score: finite(round(totalScore, 1)),
      stopAccuracy: finite(
        evaluations.stopPosition.additionalData?.averageAccuracy as number
      ),
      timeliness: finite(
        evaluations.timeliness.additionalData?.averageTimeliness as number
      ),
      ecoDriving: finite(
        evaluations.ecoDrive.additionalData?.percentage as number
      )
    },
    wattageSpent: finite(
      evaluations.ecoDrive.additionalData?.totalWattage as number
    ),
    totalScore
  };
};
