import { Evaluation } from './abstract-evaluation';

export class ATSEvaluation extends Evaluation {
  xpForEB = -500;
  xpForB = -250;
  evaluate() {
    const atsRecords = this.driveData
      .filter(
        (frame) => frame.ats.state === 'B動作' || frame.ats.state === 'EB'
      )
      .toReversed();

    // Collapse consecutive frames with the same state into one triggering event.
    const atsRecordsUnique = atsRecords.filter((frame, index, array) => {
      if (index === 0) {
        return true;
      }

      const previousFrame = array[index - 1];

      return previousFrame!.ats.state !== frame.ats.state;
    });

    atsRecordsUnique.forEach((frame) => {
      const stationIndex = this.nextStationIndex(frame);

      if (frame.ats.state === 'B動作') {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          data: [],
          reason: 'ats-triggered',
          score: this.xpForB,
          maxPossibleScore: 0,
          type: 'Bad'
        });
      } else if (
        frame.ats.state === 'EB' &&
        frame.physics.speed > 0 &&
        [0, 25, 40].includes(this.effectiveSpeedLimit(frame))
      ) {
        this.scoreBreakdown.push({
          timeframe: new Date(frame.sentAt),
          stationIndex,
          data: [],
          reason: 'ats-eb-triggered',
          score: this.xpForEB,
          maxPossibleScore: 0,
          type: 'VeryBad'
        });
      }
    });

    return {
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
