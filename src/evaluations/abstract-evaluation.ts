import { CarStaticInfo, OutputDataFrame, Station } from '@tanuden/rudolf';
import { ScoreBreakdown } from '../types/drive-evaluation';
import { resolveNextStationIndex } from '../utils/rudolf-station';

export interface EvaluationResult {
  additionalData?: Record<string, string | number>;
  scoreBreakdown: ScoreBreakdown[];
}

export abstract class Evaluation {
  // Matches the console's ~100ms fast-plane ingestion cadence (see Phase C) —
  // used to downsample "once per second" checks (overspeed, eco-drive).
  protected frameFrequency = 100;
  protected framesInOneSecond = 1000 / this.frameFrequency;

  // Shared "close enough to the physical stop marker to judge/trigger
  // against" radius. Distinct from arrivalRecords()'s stricter 5.0m "has
  // actually arrived" gate (speed === 0 required there) — this is the wider
  // proximity check evaluators use for a still-moving approach (e.g. a
  // reacceleration near the platform) or for validating that a graded window
  // really ended at the stop rather than somewhere unrelated. Centralized so
  // evaluators judging the same physical concept can't drift apart.
  protected nearStopPositionMetres = 10;

  protected consist: CarStaticInfo[];
  protected driveData: OutputDataFrame[];
  protected stations: Station[];
  protected scoreBreakdown: ScoreBreakdown[] = [];
  protected diagramLength: number = 0;

  constructor(
    driveData: OutputDataFrame[],
    stations: Station[],
    consist: CarStaticInfo[]
  ) {
    this.driveData = driveData;
    this.stations = stations;
    this.consist = consist;
    this.diagramLength = stations[stations.length - 1]?.fromStartDistance || 0;
  }

  // -- Rudolf field helpers -------------------------------------------------
  // Small derivations needed by the scoring formulas below but not stored by
  // Rudolf directly (or requiring a sentinel/fallback). These are evaluation
  // logic, not a translation layer — there is no function here that takes a
  // whole OutputDataFrame and returns a differently-shaped document.

  // -1 is a real Rudolf sentinel meaning "no posted limit" — never compare it
  // against speed as if it were a real, low limit (that would flag overspeed
  // on every frame).
  protected effectiveSpeedLimit(frame: OutputDataFrame): number {
    return frame.speedLimit.current === -1
      ? Infinity
      : frame.speedLimit.current;
  }

  protected totalAmperage(frame: OutputDataFrame): number {
    return frame.cars.list.reduce((acc, car) => acc + (car.amperage ?? 0), 0);
  }

  protected minBcPressure(frame: OutputDataFrame): number {
    const pressures = frame.cars.list
      .map((car) => car.bcPressure)
      .filter((p): p is number => p !== null);
    return pressures.length > 0 ? Math.min(...pressures) : 0;
  }

  protected lampOn(frame: OutputDataFrame, key: string): boolean {
    return (frame.lamps.values[key] ?? 0) !== 0;
  }

  // nextIndex is null at the terminus (no station ahead) or before the
  // diagram's station list is populated — fall back to currentIndex, then the
  // last station, so station-array lookups always stay in bounds.
  protected nextStationIndex(frame: OutputDataFrame): number {
    return resolveNextStationIndex(frame, this.stations);
  }

  // Not stored by Rudolf at all — the distance to the next station has to be
  // computed from the (static) station list and the current frame's position.
  protected distanceFromNextStation(frame: OutputDataFrame): number {
    const station = this.stations[this.nextStationIndex(frame)];
    return station
      ? station.fromStartDistance - frame.physics.fromStartDistance
      : 0;
  }

  // Keeps only the first occurrence of each nextStationIndex value.
  protected firstPerStation(frames: OutputDataFrame[]): OutputDataFrame[] {
    return frames.filter(
      (v, i, a) =>
        a.findIndex(
          (t) => this.nextStationIndex(t) === this.nextStationIndex(v)
        ) === i
    );
  }

  // -- Shared record derivation ---------------------------------------------

  protected passingStations(): Station[] {
    return this.stations.filter((station) => station.stopType === 'Passing');
  }

  protected arrivalRecords() {
    const arrivalRecords = this.driveData.filter((frame) => {
      const nextIdx = this.nextStationIndex(frame);
      return (
        frame.physics.speed === 0 &&
        Math.abs(this.distanceFromNextStation(frame)) < 5.0 &&
        (['OperationStop', 'PassengerStop'] as (string | null)[]).includes(
          this.stations[nextIdx]?.stopType ?? null
        )
      );
    });

    const arrivalRecordsUnique = this.firstPerStation(arrivalRecords);

    // Station 0 has no preceding leg, so it can never be a real arrival.
    const arrivalRecordsUniqueOnlyStop = arrivalRecordsUnique.filter(
      (v) => this.nextStationIndex(v) !== 0
    );

    return {
      all: arrivalRecords,
      unique: arrivalRecordsUnique,
      uniqueSkipFirst: arrivalRecordsUniqueOnlyStop
    };
  }

  protected departRecords() {
    const departRecords = this.driveData.filter((frame, index, array) => {
      // Frame 0 has no prior frame to compare against, and the last station
      // has no departure — neither can be a real departure transition.
      if (index === 0 || index === array.length - 1) {
        return false;
      }

      const nextIdx = this.nextStationIndex(frame);
      if (nextIdx === 0) {
        return false;
      }

      const previousFrame = array[index - 1]!;
      const previousStation = this.stations[nextIdx - 1];
      const stationDistance =
        frame.physics.fromStartDistance -
        (previousStation?.fromStartDistance ?? 0);

      return (
        frame.physics.speed !== 0 &&
        previousFrame.physics.speed === 0 &&
        Math.abs(stationDistance) < 5.0 &&
        (['OperationStop', 'PassengerStop'] as (string | null)[]).includes(
          previousStation?.stopType ?? null
        )
      );
    });

    const departRecordsUnique = this.firstPerStation(departRecords);

    let departRecordsUniqueSkipLast = departRecordsUnique;
    if (departRecordsUnique.length > 1) {
      departRecordsUniqueSkipLast = departRecordsUnique.filter(
        (v) => this.nextStationIndex(v) !== this.stations.length - 1
      );
    }

    return {
      all: departRecords,
      unique: departRecordsUnique,
      uniqueSkipLast: departRecordsUniqueSkipLast
    };
  }

  protected passingRecords() {
    const passRecords = this.driveData.filter(
      (frame) =>
        this.stations[this.nextStationIndex(frame)]?.stopType === 'Passing'
    );

    // Sort newest-first so firstPerStation keeps the LATEST pass through each
    // station, then flip back to chronological order for consumers.
    const passRecordsBackwardsSorted = passRecords.sort(
      (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
    );

    const passRecordsUnique = this.firstPerStation(passRecordsBackwardsSorted);

    return {
      all: passRecords,
      unique: passRecordsUnique.sort(
        (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()
      )
    };
  }

  protected evaluatePost(): void {}

  abstract evaluate(): EvaluationResult;
}
