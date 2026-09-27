import { round } from 'lodash';
import { Evaluation } from './abstract-evaluation';

export class ReaccelerationEvaluation extends Evaluation {
  xpPenaltyForReacceleration = -100;
  arrivalRangeMetres = 5.0; // matches abstract-evaluation's arrivalRecords() definition

  evaluate() {
    const stoppedStations = new Set<number>();
    const occurrenceCounts = new Map<number, number>();

    for (let i = 1; i < this.driveData.length; i++) {
      const prev = this.driveData[i - 1]!;
      const curr = this.driveData[i]!;
      const stationIndex = this.nextStationIndex(curr);
      const station = this.stations[stationIndex];
      const distance = this.distanceFromNextStation(curr);

      if (
        curr.physics.speed === 0 &&
        Math.abs(distance) < this.arrivalRangeMetres
      ) {
        stoppedStations.add(stationIndex);
        continue;
      }

      const isStopStation =
        station?.stopType === 'PassengerStop' ||
        station?.stopType === 'OperationStop';

      if (
        isStopStation &&
        !stoppedStations.has(stationIndex) &&
        distance >= 0 &&
        distance <= this.nearStopPositionMetres &&
        curr.controllers.powerNotch > 0 &&
        prev.controllers.powerNotch === 0
      ) {
        const occurrence = (occurrenceCounts.get(stationIndex) ?? 0) + 1;
        occurrenceCounts.set(stationIndex, occurrence);

        this.scoreBreakdown.push({
          timeframe: new Date(curr.sentAt),
          stationIndex,
          reason: 'reacceleration-near-stop',
          data: [occurrence, round(distance, 1), round(curr.physics.speed, 1)],
          score: this.xpPenaltyForReacceleration,
          maxPossibleScore: 0,
          type: 'Bad'
        });
      }
    }

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
