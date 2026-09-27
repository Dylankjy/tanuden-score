import { round } from 'lodash';
import { OutputDataFrame } from '@tanuden/rudolf';
import { Evaluation } from './abstract-evaluation';

interface JerkSample {
  frame: OutputDataFrame;
  elapsed: number;
  speed: number;
  jerk: number; // km/h/s² (signed)
}

export class RideQualityEvaluation extends Evaluation {
  accelWindowSec = 0.5; // real-time smoothing window for each acceleration sample
  minSpeedKmh = 1; // only evaluate above this speed (<=1 km/h is StoppingJolt's)
  // km/h/s² — |jerk| onset for a penalty. Calibrated from record 6a5fd279 (a
  // clean reference run): its peak jerk at accelWindowSec=0.5 is 3.51 km/h/s²
  // (p99 2.43, p95 1.14), so 3.6 sits just above it — that run scores zero and
  // anything sharper than its worst moment is penalised.
  jerkThreshold = 3.6;
  xpPerJerkOverThreshold = -36; // per km/h/s² of peak jerk above threshold
  xpMaxPenaltyPerEvent = -360; // per-event floor (clamp)

  // Jerk is the second derivative of speed; a single-frame second difference on
  // ~100ms-quantised speed is pure noise. Sample acceleration over fixed
  // real-time windows (>= accelWindowSec apart, located via time.elapsed — the
  // sim's monotonic seconds, the convention for physics-rate math per
  // physics-plausibility.ts / StoppingJoltEvaluation, never sentAt), then
  // difference consecutive acceleration samples to get jerk. Real-time
  // windowing (not frame count) makes the result identical at ~100ms and
  // ~250ms sampling cadence. Single O(n) pass.
  private jerkSamples(): JerkSample[] {
    const accel: {
      frame: OutputDataFrame;
      elapsed: number;
      speed: number;
      accel: number;
    }[] = [];

    let last = this.driveData[0];
    if (!last) {
      return [];
    }
    for (let i = 1; i < this.driveData.length; i++) {
      const frame = this.driveData[i]!;
      const dt = frame.time.elapsed - last.time.elapsed;
      if (dt >= this.accelWindowSec) {
        accel.push({
          frame,
          elapsed: frame.time.elapsed,
          speed: frame.physics.speed,
          accel: (frame.physics.speed - last.physics.speed) / dt
        });
        last = frame;
      }
    }

    const samples: JerkSample[] = [];
    for (let k = 1; k < accel.length; k++) {
      const dt = accel[k]!.elapsed - accel[k - 1]!.elapsed;
      // Δt <= 0 can't happen given the accelWindowSec spacing, but guard so no
      // NaN/Infinity can ever reach Mongoose's Number schema.
      if (dt <= 0) {
        continue;
      }
      samples.push({
        frame: accel[k]!.frame,
        elapsed: accel[k]!.elapsed,
        speed: accel[k]!.speed,
        jerk: (accel[k]!.accel - accel[k - 1]!.accel) / dt
      });
    }
    return samples;
  }

  evaluate() {
    const samples = this.jerkSamples();

    // Group contiguous over-threshold samples (while moving) into discrete
    // events — one slam = one event — keeping each run's peak-|jerk| sample. A
    // non-violating sample closes the current event.
    const events: JerkSample[] = [];
    let peak: JerkSample | null = null;
    for (const sample of samples) {
      const violating =
        sample.speed > this.minSpeedKmh &&
        Math.abs(sample.jerk) > this.jerkThreshold;
      if (violating) {
        if (!peak || Math.abs(sample.jerk) > Math.abs(peak.jerk)) {
          peak = sample;
        }
      } else if (peak) {
        events.push(peak);
        peak = null;
      }
    }
    if (peak) {
      events.push(peak);
    }

    events.forEach((event) => {
      const peakJerk = Math.abs(event.jerk);
      const over = peakJerk - this.jerkThreshold;
      let score = this.xpPerJerkOverThreshold * over;
      if (score < this.xpMaxPenaltyPerEvent) {
        score = this.xpMaxPenaltyPerEvent;
      }

      this.scoreBreakdown.push({
        timeframe: new Date(event.frame.sentAt),
        stationIndex: this.nextStationIndex(event.frame),
        reason: 'ride-quality',
        data: [round(peakJerk, 2)],
        score: round(score),
        maxPossibleScore: 0,
        type: 'Bad'
      });
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
