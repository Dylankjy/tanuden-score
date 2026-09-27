import { mean } from 'stats-lite';
import { Evaluation } from './abstract-evaluation';
import { round, sum } from 'lodash';

export class EcoDriveEvaluation extends Evaluation {
  wattageAllowedPerKm = 1.75; // in kWh
  xpMaxEcoDriving = 500;
  xpPer1KWh = 100;
  evaluate() {
    // Bug fix: on short (<=2 station) runs, skip the whole calculation up
    // front rather than computing wattUsedPerKm/percentage from a near-empty
    // sample and then only suppressing scoreBreakdown — the old code left
    // additionalData.percentage/totalWattage populated from a meaningless
    // computation even when scoreBreakdown was suppressed.
    // Same reasoning extended to two more zero-denominator cases: a route
    // with no recorded length yet, or a consist with no motor cars — either
    // would otherwise divide by zero (0/0 = NaN) further down and produce a
    // score Mongoose's Number schema rejects outright at save time.
    const motorCarCount = this.consist.filter((car) => car.hasMotor).length;
    if (
      this.stations.length <= 2 ||
      this.diagramLength <= 0 ||
      motorCarCount === 0
    ) {
      return {
        additionalData: {
          percentage: 0,
          totalWattage: 0
        },
        scoreBreakdown: []
      };
    }

    const ecoDrivingRecords = this.driveData.filter(
      (frame) => this.totalAmperage(frame) !== 0
    );

    const effectiveRecords = ecoDrivingRecords.filter(
      (_record, index) => index % this.framesInOneSecond === 0
    );

    const gradientRecords = effectiveRecords.map(
      (frame) => frame.physics.gradient ?? 0
    );
    let averageGradient = mean(gradientRecords);

    // For extreme downhill, cap value
    if (averageGradient < -10) {
      averageGradient = -10;
    }

    const drivingEnergyRecords = effectiveRecords.map((frame) => {
      const regenBrakeEfficiency = 0.88;
      const powerW = this.totalAmperage(frame) * 1500; // in W
      let powerkW = powerW / 1000; // in kW

      if (powerkW < 0) {
        powerkW = regenBrakeEfficiency * powerkW;
      }

      const time = 1 / 3600; // in h

      const energykWh = powerkW * time; // in kWh

      return energykWh;
    });

    const drivingEnergyConsumed = sum(drivingEnergyRecords);
    let energyPerCar = drivingEnergyConsumed / motorCarCount;

    // Account for gradient
    // If climbing hills, penalise less for usage. If going downhill, penalise more
    const gradientFactor = 5;
    energyPerCar = energyPerCar - (averageGradient / 100) * gradientFactor;
    const wattUsedPerKm = energyPerCar / (this.diagramLength / 1000);
    let wattDifference = wattUsedPerKm - this.wattageAllowedPerKm;

    // Prevent negative values
    wattDifference = wattDifference < 0 ? 0 : wattDifference;
    let scoreEcoDriving =
      this.xpMaxEcoDriving - wattDifference * this.xpPer1KWh;

    // Prevent negative values
    scoreEcoDriving = scoreEcoDriving < 0 ? 0 : scoreEcoDriving;

    this.scoreBreakdown.push({
      reason: 'eco-driving',
      data: [
        round(drivingEnergyConsumed, 2),
        this.wattageAllowedPerKm * (this.diagramLength / 1000)
      ],
      score: scoreEcoDriving,
      maxPossibleScore: this.xpMaxEcoDriving,
      type: 'Bonus'
    });

    return {
      additionalData: {
        percentage: round((1 / wattUsedPerKm) * this.wattageAllowedPerKm, 3),
        totalWattage: round(drivingEnergyConsumed, 2)
      },
      scoreBreakdown: this.scoreBreakdown
    };
  }
}
