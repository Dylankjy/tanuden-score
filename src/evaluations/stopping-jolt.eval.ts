import { round } from 'lodash';
import { OutputDataFrame } from '@tanuden/rudolf';
import { Evaluation } from './abstract-evaluation';

export class StoppingJoltEvaluation extends Evaluation {
  jerkWindowSec = 2; // real seconds of history to measure the final jerk over

  minJerkForMaxScore = 1.5; // km/h/s
  neutralJerk = 2.5;
  maxJerkForFloor = 5;

  xpForSmoothStop = 400;
  xpFloorForJolt = -200;

  // Backward-scans driveData from the arrival frame for the first frame at
  // least jerkWindowSec (by time.elapsed) before it. time.elapsed — the sim's
  // own monotonic seconds — is used rather than sentAt, matching
  // checkPhysicsPlausibility's convention for physics-rate math (sentAt is
  // wall-clock, reserved for real-time tolerance windows like
  // RollPreventionEvaluation's). Falls back to the earliest meaningful frame
  // (index 1) when less than a full window of history exists, degrading to a
  // shorter window rather than dropping the stop.
  private windowStartFrame(arrivalIndex: number): OutputDataFrame {
    const arrivalElapsed = this.driveData[arrivalIndex]!.time.elapsed;
    let windowStart = this.driveData[1]!;
    for (let i = arrivalIndex - 1; i >= 1; i--) {
      windowStart = this.driveData[i]!;
      if (arrivalElapsed - windowStart.time.elapsed >= this.jerkWindowSec) {
        break;
      }
    }
    return windowStart;
  }

  evaluate() {
    const arrivalRecords = this.arrivalRecords().uniqueSkipFirst;

    arrivalRecords.forEach((frame) => {
      const arrivalIndex = this.driveData.indexOf(frame);
      if (arrivalIndex <= 0) {
        return;
      }

      const windowStart = this.windowStartFrame(arrivalIndex);
      const elapsedSec = frame.time.elapsed - windowStart.time.elapsed;
      // No usable window (only one frame of history, or non-advancing elapsed)
      // — skip this stop rather than risk a NaN/Infinity reaching Mongoose.
      if (elapsedSec <= 0) {
        return;
      }

      const stationIndex = this.nextStationIndex(frame);
      // Arrival speed is 0, so this is the average deceleration magnitude over
      // the final window — km/h per second.
      const jerk =
        Math.abs(frame.physics.speed - windowStart.physics.speed) / elapsedSec;

      // base smoothness grade, always emitted (mirrors stop-ok)
      let smoothnessScore = this.xpForSmoothStop;
      if (jerk > this.minJerkForMaxScore) {
        smoothnessScore =
          (this.xpForSmoothStop * (this.neutralJerk - jerk)) /
          (this.neutralJerk - this.minJerkForMaxScore);
      }
      if (smoothnessScore < 0) {
        smoothnessScore = 0;
      }

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'stopping-smoothness',
        data: [round(jerk, 2)],
        score: smoothnessScore,
        maxPossibleScore: this.xpForSmoothStop,
        type: 'Good'
      });

      // harsh-stop penalty, only when the stop was actually abrupt
      if (jerk > this.neutralJerk) {
        let joltScore =
          (this.xpFloorForJolt * (jerk - this.neutralJerk)) /
          (this.maxJerkForFloor - this.neutralJerk);
        if (joltScore < this.xpFloorForJolt) {
          joltScore = this.xpFloorForJolt;
        }

        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          reason: 'stopping-jolt',
          data: [round(jerk, 2)],
          score: joltScore,
          maxPossibleScore: 0,
          type: 'Bad'
        });
      }
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
