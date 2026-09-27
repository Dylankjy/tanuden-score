import { round } from 'lodash';
import { Evaluation } from './abstract-evaluation';

export class SpeedLimitDecreaseEvaluation extends Evaluation {
  xpForCompliance = 100;

  evaluate() {
    for (let i = 1; i < this.driveData.length; i++) {
      const prev = this.driveData[i - 1]!;
      const curr = this.driveData[i]!;

      // -1 is the "no posted limit" sentinel — never a real decrease target.
      if (curr.speedLimit.current === -1) {
        continue;
      }
      if (curr.speedLimit.current >= prev.speedLimit.current) {
        continue;
      }
      // Restriction / null-type transitions are not civil or signal limits.
      if (
        curr.speedLimit.currentType !== 'SpeedLimit' &&
        curr.speedLimit.currentType !== 'Signal'
      ) {
        continue;
      }

      const compliant = curr.physics.speed <= curr.speedLimit.current;

      this.scoreBreakdown.push({
        timeframe: new Date(curr.sentAt),
        stationIndex: this.nextStationIndex(curr),
        reason:
          curr.speedLimit.currentType === 'Signal'
            ? 'signal-speed-limit-compliance'
            : 'line-speed-limit-compliance',
        data: [
          prev.speedLimit.current,
          curr.speedLimit.current,
          round(curr.physics.speed, 1)
        ],
        score: compliant ? this.xpForCompliance : 0,
        maxPossibleScore: this.xpForCompliance,
        type: 'Good'
      });
    }

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
