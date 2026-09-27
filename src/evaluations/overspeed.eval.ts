import { round } from 'lodash';
import { Evaluation } from './abstract-evaluation';

export class OverspeedingEvaluation extends Evaluation {
  xpPerEffectiveOverspeedPerKmh = -8;
  evaluate() {
    const overspeedRecords = this.driveData.filter(
      (frame) => frame.physics.speed > this.effectiveSpeedLimit(frame) + 0.99
    );

    const overspeedRecordsEffective = overspeedRecords.filter(
      (_record, index) => index % this.framesInOneSecond === 0
    );

    overspeedRecordsEffective.forEach((frame) => {
      const speedOver = frame.physics.speed - this.effectiveSpeedLimit(frame);
      const score = round(this.xpPerEffectiveOverspeedPerKmh * speedOver);

      this.scoreBreakdown.push({
        timeframe: new Date(frame.sentAt),
        stationIndex: this.nextStationIndex(frame),
        reason: 'overspeeding',
        data: [round(frame.physics.speed, 1), this.effectiveSpeedLimit(frame)],
        score: score,
        maxPossibleScore: 0,
        type: 'Bad'
      });
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
