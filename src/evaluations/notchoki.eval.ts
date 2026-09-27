import { OutputDataFrame } from '@tanuden/rudolf';
import { Evaluation } from './abstract-evaluation';

export class NotchOkiEvaluation extends Evaluation {
  xpForPowerAppliedWhenDoorsOpened = -200;
  // Bug fix: this used to penalize a single matching frame with no minimum
  // duration at all. Under the old, sparser sampling rate a fleeting one-tick
  // coincidence rarely landed on a sampled frame; today's much denser ~100ms
  // cadence makes a driver's momentary/transitional controller movement while
  // the pilot lamp is off far more likely to be caught, with nothing to
  // absorb it. Mirrors RollPreventionEvaluation's contiguous-run tolerance
  // fix, with a shorter window since applying power with doors open is a more
  // immediate safety concern than insufficient roll prevention.
  powerAppliedTolerance = 2; // in seconds

  private isViolating(frame: OutputDataFrame): boolean {
    // Gate on Rudolf's canonical doors.allClosed (TC TrainState.AllClose), not
    // the pilot lamp: TrainCrew has no Pilot lamp, so lamps.values.pilot is
    // absent on every frame and !lampOn('pilot') was always true — turning this
    // into a per-station false trigger during normal running.
    return !frame.doors.allClosed && frame.controllers.powerNotch > 0;
  }

  // Contiguous runs of violating frames (same shape as RollPreventionEvaluation
  // / BrakeRegimeEvaluation). A run still open at the end of driveData IS
  // closed and counted — this runs over a complete, already-finished drive.
  private findViolatingRuns(): OutputDataFrame[][] {
    const runs: OutputDataFrame[][] = [];
    let current: OutputDataFrame[] | null = null;

    for (const frame of this.driveData) {
      if (this.isViolating(frame)) {
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
    const violatingRuns = this.findViolatingRuns().filter((run) => {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const durationSec =
        (new Date(last.sentAt).getTime() - new Date(first.sentAt).getTime()) /
        1000;
      return durationSec >= this.powerAppliedTolerance;
    });

    // One penalty per station, taking the first violating run's opening frame.
    const powerAppliedWhenDoorsOpenedRecordsUnique = this.firstPerStation(
      violatingRuns.map((run) => run[0]!)
    );

    powerAppliedWhenDoorsOpenedRecordsUnique.forEach((frame) => {
      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex: this.nextStationIndex(frame),
        data: [],
        reason: 'power-while-doors-opened',
        score: this.xpForPowerAppliedWhenDoorsOpened,
        maxPossibleScore: 0,
        type: 'VeryBad'
      });
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
