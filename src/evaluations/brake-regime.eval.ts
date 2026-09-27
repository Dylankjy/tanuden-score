import { AtsRichStateType, OutputDataFrame } from '@tanuden/rudolf';
import { Evaluation } from './abstract-evaluation';

type SwoopDirection = 'increase' | 'decrease';

interface Swoop {
  direction: SwoopDirection;
  notchBefore: number;
  notchAfter: number;
}

interface SwoopAssessment {
  tier1Pass: boolean;
  hadReadjustment: boolean;
  increaseCount: number;
  decreaseCount: number;
}

export class BrakeRegimeEvaluation extends Evaluation {
  xpForErraticBraking = -100;
  erraticSwoopThreshold = 10;
  xpForCleanBraking = 50;
  xpForCorrectBraking = 100;
  swoopMergeWindowMs = 500;
  fallbackApproachMetres = 300;

  // Whether driveData is the complete, final frame timeline (default) or a
  // still-growing live segment buffer. Only utils/live-score-events.ts's
  // emitLiveScoreEvents sets this false: closing a still-open window there
  // would commit to a verdict based on an incomplete swoop shape (the reason
  // — erratic/2-3/clean — depends on the WHOLE regime, unlike a simple
  // duration-threshold check), and that verdict can't be corrected once
  // emitted since events are deduplicated by reason+station. Waiting for a
  // later pass once the pattern truly clears is safe there. The offline/final
  // paths (computeDriveScore's two callers: live drive:complete finalization
  // and the offline reevaluate script) have no later pass — a run still open
  // at the last frame there IS the real, final approach and must be graded,
  // not silently dropped.
  dataIsComplete = true;

  evaluate() {
    // Pattern-based windows first: contiguous StopP/TerminalP runs.
    const patternWindows = this.findStoppingWindows();
    const patternStations = new Set<number>();
    for (const window of patternWindows) {
      patternStations.add(this.nextStationIndex(window[0]!));
      this.evaluateWindow(window);
    }

    // Fallback: a scheduled stop with no pattern window is judged on the last
    // `fallbackApproachMetres` of its approach instead. Keyed on explicit stop
    // types — a distance window is synthesized, so we need positive evidence
    // the station is a real stop — and skips the origin, which is departed, not
    // approached.
    this.stations.forEach((station, index) => {
      if (index === 0) {
        return;
      }
      if (
        station.stopType !== 'PassengerStop' &&
        station.stopType !== 'OperationStop'
      ) {
        return;
      }
      if (patternStations.has(index)) {
        return;
      }

      const window = this.approachWindow(index);
      if (window.length > 0) {
        this.evaluateWindow(window);
      }
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }

  private isStoppingPattern(frame: OutputDataFrame): boolean {
    const types = frame.ats.richState?.type;
    if (!types) {
      return false;
    }
    return (
      types.includes(AtsRichStateType.StopP) ||
      types.includes(AtsRichStateType.TerminalP)
    );
  }

  // Contiguous runs of stopping-pattern frames, coalesced per stop. The ATS
  // StopP/TerminalP pattern is intermittent — it can drop out mid-approach — so
  // one stop can produce several runs that all resolve to the same next station.
  // Consecutive runs for the same station are merged into a single span that
  // includes the intervening gap frames (the braking done while the pattern was
  // absent is part of the same regime), so each stop is graded exactly once
  // rather than once per run.
  //
  // A run still open at the end of driveData is only closed and counted when
  // dataIsComplete — see that field's doc comment for why the live path must
  // instead drop it and wait for a later pass.
  private findStoppingWindows(): OutputDataFrame[][] {
    const runs: { station: number; start: number; end: number }[] = [];
    let start: number | null = null;

    this.driveData.forEach((frame, index) => {
      if (this.isStoppingPattern(frame)) {
        start ??= index;
        return;
      }
      if (start !== null) {
        runs.push({
          station: this.nextStationIndex(this.driveData[start]!),
          start,
          end: index - 1
        });
        start = null;
      }
    });

    if (start !== null && this.dataIsComplete) {
      runs.push({
        station: this.nextStationIndex(this.driveData[start]!),
        start,
        end: this.driveData.length - 1
      });
    }

    const merged: typeof runs = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && last.station === run.station) {
        last.end = run.end;
      } else {
        merged.push({ ...run });
      }
    }

    return merged.map((run) => this.driveData.slice(run.start, run.end + 1));
  }

  // The last `fallbackApproachMetres` of approach to a station: frames whose
  // next station is this one and which lie within that distance ahead of it
  // (through the stop/dwell). Used only when no StopP/TerminalP window covered
  // the stop.
  private approachWindow(stationIndex: number): OutputDataFrame[] {
    return this.driveData.filter(
      (frame) =>
        this.nextStationIndex(frame) === stationIndex &&
        this.distanceFromNextStation(frame) <= this.fallbackApproachMetres
    );
  }

  private evaluateWindow(window: OutputDataFrame[]): void {
    // The braking regime only grades an actual stop. If the target station is a
    // pass-through, the pattern is protecting against a mis-stop/overrun rather
    // than a stop being made here, so there is nothing to grade — skip the
    // window entirely (no penalty and no bonus).
    const stationIndex = this.nextStationIndex(window[0]!);
    if (this.stations[stationIndex]?.stopType === 'Passing') {
      return;
    }

    // Guard against grading a window that never actually reached the stop —
    // only the last frame (where the approach ends) needs to be this close;
    // earlier frames in the window are the approach itself. Same radius as
    // ReaccelerationEvaluation's proximity check (see nearStopPositionMetres).
    const distanceAtEnd = this.distanceFromNextStation(
      window[window.length - 1]!
    );
    if (Math.abs(distanceAtEnd) > this.nearStopPositionMetres) {
      return;
    }

    // Only the region after the last speed-limit tightening is judged — a
    // decrease in the posted limit means a new, closer stop target, so the
    // driver re-applies from scratch and earlier progress is discarded.
    const judged = this.judgedRegion(window);
    if (judged.length === 0) {
      return;
    }

    const swoops = this.groupSwoops(judged);

    const timeframe = new Date(window[window.length - 1]!.sentAt);
    const push = (
      reason: 'erratic-braking' | 'basic-braking-clean' | 'basic-braking-2-3',
      score: number,
      maxPossibleScore: number,
      type: 'Bad' | 'Bonus'
    ): void => {
      this.scoreBreakdown.push({
        timeframe,
        stationIndex,
        data: [],
        reason,
        score,
        maxPossibleScore,
        type
      });
    };

    if (swoops.length > this.erraticSwoopThreshold) {
      push('erratic-braking', this.xpForErraticBraking, 0, 'Bad');
      return;
    }

    const baselineNotch = judged[0]!.controllers.brakeNotch;
    const { tier1Pass, hadReadjustment, increaseCount, decreaseCount } =
      this.assessSwoops(swoops);

    if (!tier1Pass) {
      push('basic-braking-clean', 0, this.xpForCleanBraking, 'Bonus');
      return;
    }

    const tier2Pass =
      !hadReadjustment &&
      decreaseCount <= 3 &&
      (baselineNotch !== 0 || increaseCount <= 2);

    if (tier2Pass) {
      push(
        'basic-braking-2-3',
        this.xpForCorrectBraking,
        this.xpForCorrectBraking,
        'Bonus'
      );
    } else {
      push(
        'basic-braking-clean',
        this.xpForCleanBraking,
        this.xpForCleanBraking,
        'Bonus'
      );
    }
  }

  private judgedRegion(window: OutputDataFrame[]): OutputDataFrame[] {
    let startIdx = 0;
    for (let i = 1; i < window.length; i++) {
      if (
        this.effectiveSpeedLimit(window[i]!) <
        this.effectiveSpeedLimit(window[i - 1]!)
      ) {
        startIdx = i;
      }
    }
    return window.slice(startIdx);
  }

  private groupSwoops(frames: OutputDataFrame[]): Swoop[] {
    const swoops: Swoop[] = [];
    let dir: SwoopDirection | null = null;
    let notchBefore = 0;
    let notchAfter = 0;
    let lastChangeTime = 0;

    const flush = (): void => {
      if (dir) {
        swoops.push({ direction: dir, notchBefore, notchAfter });
        dir = null;
      }
    };

    for (let i = 1; i < frames.length; i++) {
      const before = frames[i - 1]!.controllers.brakeNotch;
      const after = frames[i]!.controllers.brakeNotch;
      if (after === before) {
        continue;
      }

      const changeDir: SwoopDirection =
        after > before ? 'increase' : 'decrease';
      const time = new Date(frames[i]!.sentAt).getTime();

      if (
        dir === changeDir &&
        time - lastChangeTime <= this.swoopMergeWindowMs
      ) {
        notchAfter = after;
      } else {
        flush();
        dir = changeDir;
        notchBefore = before;
        notchAfter = after;
      }
      lastChangeTime = time;
    }
    flush();

    return swoops;
  }

  private assessSwoops(swoops: Swoop[]): SwoopAssessment {
    let phase: 'application' | 'release' = 'application';
    let fullReleaseReadjustmentUsed = false;
    let hadReadjustment = false;
    let tier1Pass = true;
    let increaseCount = 0;
    let decreaseCount = 0;

    for (const swoop of swoops) {
      if (swoop.direction === 'increase') {
        increaseCount++;
        if (phase === 'release') {
          hadReadjustment = true;
          if (swoop.notchBefore === 0) {
            if (fullReleaseReadjustmentUsed) {
              tier1Pass = false;
              break;
            }
            fullReleaseReadjustmentUsed = true;
            phase = 'application';
          } else {
            tier1Pass = false;
            break;
          }
        }
      } else {
        decreaseCount++;
        phase = 'release';
      }
    }

    return { tier1Pass, hadReadjustment, increaseCount, decreaseCount };
  }
}
