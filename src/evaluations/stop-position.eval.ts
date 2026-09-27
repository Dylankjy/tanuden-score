import { round } from 'lodash';
import { Evaluation } from './abstract-evaluation';

export class StopPositionEvaluation extends Evaluation {
  stopPosRange = 300; // in cm
  largeOverrunDistance = -10.0; // in m

  xpForWithinBonusRange = 100;
  xpForPerfectStop = 100;
  xpPer1cmStop = 2;
  xpForOverrunBase = -250;
  xpForBigOverrun = -150;
  xpPer1cmOverrun = -1;
  evaluate() {
    const arrivalRecords = this.arrivalRecords().uniqueSkipFirst;

    const overrunRecords = this.driveData.filter((frame, index) => {
      if (index === 0) {
        return false;
      }

      return (
        this.distanceFromNextStation(frame) < -5.0 && frame.physics.speed === 0
      );
    });

    const overrunRecordsUnique = this.firstPerStation(overrunRecords);

    const stationsOverran: number[] = [];
    overrunRecordsUnique.forEach((frame) => {
      const overrunDistance = this.distanceFromNextStation(frame); // in m
      // xpPer1cmOverrun is a per-centimeter rate but overrunDistance is in
      // meters — convert to cm before applying it, matching the *100
      // conversion the stop-accuracy calc below already applies.
      const overrunDistanceCm = Math.abs(overrunDistance) * 100; // in cm

      const scoreOverrun =
        this.xpForOverrunBase + overrunDistanceCm * this.xpPer1cmOverrun;

      const stationIndex = this.nextStationIndex(frame);
      stationsOverran.push(stationIndex);

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'stop-overrun',
        data: [round(overrunDistance, 4)],
        score: scoreOverrun,
        maxPossibleScore: 0,
        type: 'Bad'
      });

      if (overrunDistance < this.largeOverrunDistance) {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          reason: 'stop-overrun-large',
          data: [round(overrunDistance, 4)],
          score: this.xpForBigOverrun,
          maxPossibleScore: 0,
          type: 'VeryBad'
        });
      }
    });

    arrivalRecords.forEach((frame) => {
      const stationIndex = this.nextStationIndex(frame);
      const stopAccuracy = round(
        Math.abs(this.distanceFromNextStation(frame)),
        4
      ); // in meters
      const scoreStopPos =
        (this.stopPosRange - stopAccuracy * 100) * this.xpPer1cmStop;

      const maxPossibleScore = this.stopPosRange * this.xpPer1cmStop;

      // Penalty for overrun
      if (stationsOverran.includes(stationIndex)) {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          reason: 'stop-overrun-corrected',
          data: [round(stopAccuracy, 4)],
          score: scoreStopPos,
          maxPossibleScore: maxPossibleScore,
          type: 'Good'
        });
      } else {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          reason: 'stop-ok',
          data: [round(stopAccuracy, 4)],
          score: scoreStopPos,
          maxPossibleScore: maxPossibleScore,
          type: 'Good'
        });
      }

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'stop-perfect',
        data: [round(stopAccuracy, 4)],
        score: stopAccuracy < 0.01 ? this.xpForPerfectStop : 0,
        maxPossibleScore: this.xpForPerfectStop,
        type: 'Bonus'
      });

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex,
        reason: 'stop-within-bonus',
        data: [round(stopAccuracy, 4)],
        score: stopAccuracy < 0.3 ? this.xpForWithinBonusRange : 0,
        maxPossibleScore: this.xpForWithinBonusRange,
        type: 'Bonus'
      });
    });

    // A drive with no recorded arrivals (e.g. cancelled/completed before
    // reaching a stop) would otherwise divide by zero and produce NaN, which
    // Mongoose's Number schema rejects outright at save time.
    const averageStopPos =
      arrivalRecords.length === 0
        ? 0
        : arrivalRecords.reduce(
            (acc, frame) => acc + Math.abs(this.distanceFromNextStation(frame)),
            0
          ) / arrivalRecords.length;

    return {
      additionalData: {
        averageAccuracy: round(averageStopPos, 4)
      },
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
