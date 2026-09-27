import { round } from 'lodash';
import { OutputDataFrame } from '@tanuden/rudolf';
import { Evaluation } from './abstract-evaluation';

export class RollPreventionEvaluation extends Evaluation {
  noRollTolerance = 5; // in seconds
  xpPerNoRollPrevention = -100;

  private isAtRisk(frame: OutputDataFrame): boolean {
    // Gate on Rudolf's canonical doors.allClosed (TC TrainState.AllClose), not
    // the pilot lamp: TrainCrew has no Pilot lamp, so lamps.values.pilot is
    // absent on every frame and !lampOn('pilot') was always true — turning this
    // into a per-station false trigger during normal running.
    return !frame.doors.allClosed && this.minBcPressure(frame) < 150;
  }

  // Contiguous runs of at-risk frames (same shape as BrakeRegimeEvaluation's
  // findStoppingWindows). Bug fix: the previous version bucketed matching
  // frames by nextStationIndex across the WHOLE drive rather than by
  // contiguous episode, so two brief, unrelated dips at the same station
  // (each well under noRollTolerance on its own) got merged into one bucket
  // whose first-to-last span looked like a single sustained violation. That
  // was a rare no-op under the old, sparser sampling rate, but today's much
  // denser ~100ms frame cadence makes separate short dips far more likely to
  // each register at least one frame — turning this into a real false-trigger
  // source. Measuring tolerance per contiguous run (not per station overall)
  // fixes it. Unlike the live-streaming brake-regime windows, a run still open
  // at the end of driveData IS closed and counted here — this runs over a
  // complete, already-finished drive, so there is no later pass to catch it.
  private findAtRiskRuns(): OutputDataFrame[][] {
    const runs: OutputDataFrame[][] = [];
    let current: OutputDataFrame[] | null = null;

    for (const frame of this.driveData) {
      if (this.isAtRisk(frame)) {
        current ??= [];
        current.push(frame);
      } else if (current) {
        runs.push(current);
        current = null;
      }
    }
    if (current) {
      runs.push(current);
    }

    return runs;
  }

  evaluate() {
    const violatingRuns = this.findAtRiskRuns().filter((run) => {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const durationSec =
        (new Date(last.sentAt).getTime() - new Date(first.sentAt).getTime()) /
        1000;
      return durationSec >= this.noRollTolerance;
    });

    // One penalty per station, same as every other station-keyed evaluator —
    // takes the first violating run's opening frame per station.
    const noRollPreventionRecordsUnique = this.firstPerStation(
      violatingRuns.map((run) => run[0]!)
    );

    noRollPreventionRecordsUnique.forEach((frame) => {
      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex: this.nextStationIndex(frame),
        reason: 'insufficent-roll-prevention',
        data: [round(this.minBcPressure(frame))],
        score: this.xpPerNoRollPrevention,
        maxPossibleScore: 0,
        type: 'Bad'
      });
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
