import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { round } from 'lodash';
import {
  CarStaticInfo,
  Direction,
  LineDirection,
  OutputDataFrame,
  PantographDirection,
  PantographType,
  SCHEMA_VERSION,
  Station,
  emptyAts,
  emptyCars,
  emptyControllers,
  emptyDoors,
  emptyGameState,
  emptyPhysics,
  emptySignals,
  emptySpeedLimit,
  emptySwitches,
  emptyTime
} from '@tanuden/rudolf';
import { DB } from '../constants';
import { connectDatabase } from '../utils/database';
import driveRecordCollection from '../models/drive-record.collection';
import driveRecordDataCollection from '../models/drive-record-data.collection';
import { DriveRecord } from '../types/drive-evaluation';

// One-time migration of historical data from tanuden-myuntendai's legacy
// flat/OpenTetsu-shaped schema into tanuden-score's Rudolf-native schema.
// Dry-run by default (reads + transforms + prints a summary, writes nothing)
// per this workspace's migration norms — pass --execute to actually write.
// Re-runnable safely: records whose _id already exists in tanuden-score are
// skipped rather than duplicated or overwritten.
//
// Usage:
//   npm run migrate:myuntendai                  # dry run
//   npm run migrate:myuntendai -- --execute        # actually write
//   npm run migrate:myuntendai -- --execute --limit=50   # only first N records

const EXECUTE = process.argv.includes('--execute');
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  return arg ? Number(arg.split('=')[1]) : undefined;
})();

// -- Legacy shapes (myuntendai's schema, read via the raw driver — this
// service has no dependency on myuntendai's models, so we don't import them,
// just describe the fields we actually read) --------------------------------

interface LegacyStation {
  distance: number;
  index: number;
  name: string;
  positionName: string;
  stopType: string;
  timings: { arrival: Date; departure: Date };
}

interface LegacyCarProperties {
  driverCab: boolean;
  conductorCab: boolean;
  motor: boolean;
  cabDirection: 'Inbound' | 'Outbound';
  pantograph: boolean;
  pantographDirection: 'Inbound' | 'Outbound' | 'Both' | null;
  pantographType: 'SingleArm' | 'ScissorArm';
}

interface LegacyCarState {
  carNo: number;
  model: string;
  properties: LegacyCarProperties;
}

interface LegacyDriveRecord {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  aggregateScore: DriveRecord['aggregateScore'];
  scoreBreakdown: DriveRecord['scoreBreakdown'];
  runNumber: string;
  diagramNumber: string;
  direction: 'Inbound' | 'Outbound';
  boundFor: string;
  serviceType: string;
  length: number;
  consist: LegacyCarState[];
  wattageSpent?: number;
  isComplete: boolean;
  stations: LegacyStation[];
  createdAt: Date;
  updatedAt: Date;
}

interface LegacyDriveRecordData {
  parentRecord: Types.ObjectId;
  timeframe: Date;
  speed: number;
  speedLimit: number;
  nextStationIndex: number;
  distance: { fromNextStation: number; fromStart: number };
  notch: { p: number; b: number };
  gradient: number;
  amperage: number;
  bcPressure: number;
  atsState: string;
  lamps: {
    eBrake: boolean;
    ebTimer: boolean;
    pilot: boolean;
    regenBrake: boolean;
  };
}

// -- Direction mapping --------------------------------------------------

// Confirmed via OpenTetsu's TrainCrewAdapter.cs and Rudolf's own TrainCrew
// FieldMapper.cs: both derive line direction from the same diagram-number
// parity rule (even last digit = Inbound/Upbound, odd = Outbound/Downbound).
// Every historical Inbound/Outbound value already IS the corresponding
// Upbound/Downbound value — a straight rename, not a re-derivation.
const mapLineDirection = (legacy: 'Inbound' | 'Outbound'): LineDirection =>
  legacy === 'Inbound' ? 'Upbound' : 'Downbound';

// Car-facing direction (cab/pantograph orientation) is a SEPARATE,
// TIMS-screen-relative vocabulary in Rudolf (Left/Right, or Left/Right/Both
// for pantographs) — no equivalent derivation rule exists for legacy's line-
// relative Inbound/Outbound values. Flagged for manual review rather than
// guessed; 'Both' is the one value safe to carry across unchanged, since
// it isn't directionally ambiguous in either vocabulary.
interface CarDirectionFlag {
  recordId: string;
  carNo: number;
  field: 'cabDirection' | 'pantographDirection';
  legacyValue: string;
}

const mapCabDirection = (
  legacy: 'Inbound' | 'Outbound',
  recordId: string,
  carNo: number,
  flags: CarDirectionFlag[]
): Direction | null => {
  flags.push({ recordId, carNo, field: 'cabDirection', legacyValue: legacy });
  return null;
};

const mapPantographDirection = (
  legacy: 'Inbound' | 'Outbound' | 'Both' | null,
  recordId: string,
  carNo: number,
  flags: CarDirectionFlag[]
): PantographDirection | null => {
  if (legacy === null) {
    return null;
  }
  if (legacy === 'Both') {
    return 'Both';
  }
  flags.push({
    recordId,
    carNo,
    field: 'pantographDirection',
    legacyValue: legacy
  });
  return null;
};

const mapPantographType = (
  legacy: 'SingleArm' | 'ScissorArm'
): PantographType => (legacy === 'ScissorArm' ? 'Scissor' : 'SingleArm');

// -- Station / consist transforms ---------------------------------------

const mapStation = (legacy: LegacyStation): Station => ({
  index: legacy.index,
  name: legacy.name,
  fromStartDistance: legacy.distance,
  // Rudolf fields legacy never captured — left at their documented "unknown"
  // defaults, never fabricated.
  absoluteDistance: null,
  doorSide: 0, // DoorSide.None — legacy never captured door side
  stopType: legacy.stopType as Station['stopType'],
  arrival: legacy.timings.arrival ? legacy.timings.arrival.toISOString() : null,
  departure: legacy.timings.departure
    ? legacy.timings.departure.toISOString()
    : null,
  stopPositionName: legacy.positionName,
  isTimeTaken: null,
  stopPositions: null
});

const mapCarStaticInfo = (
  legacy: LegacyCarState,
  recordId: string,
  flags: CarDirectionFlag[]
): CarStaticInfo => ({
  carNo: legacy.carNo,
  model: legacy.model,
  hasDriverCab: legacy.properties.driverCab,
  hasConductorCab: legacy.properties.conductorCab,
  hasMotor: legacy.properties.motor,
  hasPantograph: legacy.properties.pantograph,
  cabDirection: mapCabDirection(
    legacy.properties.cabDirection,
    recordId,
    legacy.carNo,
    flags
  ),
  pantographType: legacy.properties.pantograph
    ? mapPantographType(legacy.properties.pantographType)
    : null,
  pantographDirection: legacy.properties.pantograph
    ? mapPantographDirection(
        legacy.properties.pantographDirection,
        recordId,
        legacy.carNo,
        flags
      )
    : null,
  // Legacy never captured per-car length. -1 is Rudolf's own "unknown"
  // sentinel (see CarStaticInfo.length docs) — not fabricated.
  length: -1
});

// -- Frame transform -----------------------------------------------------

// Legacy amperage/bcPressure are single flat numbers (never genuinely
// per-car), but tanuden-score's evaluators derive their values by summing
// (amperage) / taking the min (bcPressure) across cars.list[] — a design
// valid for live Rudolf data where the aggregate naturally emerges from real
// per-car telemetry. To reproduce the original flat values exactly rather
// than fabricating per-car granularity that never existed, the legacy value
// is attached to exactly one car (the first in the consist) and every other
// car is left null — summing one non-null entry (+ zeros) or taking the min
// of one non-null entry reproduces the original flat value precisely.
const mapCars = (
  consist: CarStaticInfo[],
  amperage: number,
  bcPressure: number
): ReturnType<typeof emptyCars> => {
  const cars = emptyCars();
  cars.list = consist.map((car, index) => ({
    carNo: car.carNo,
    amperage: index === 0 ? amperage : null,
    bcPressure: index === 0 ? bcPressure : null,
    occupancyRate: null
  }));
  return cars;
};

const mapFrame = (
  legacy: LegacyDriveRecordData,
  record: {
    recordId: string;
    scenarioId: string;
    stations: Station[];
    consist: CarStaticInfo[];
    runNumber: string | null;
    diagramNumber: string | null;
    boundFor: string | null;
    serviceType: string | null;
    direction: LineDirection | null;
  },
  firstFrameTimeMs: number,
  tick: number
): OutputDataFrame => {
  const sentAt = legacy.timeframe.toISOString();
  const elapsedSec = (legacy.timeframe.getTime() - firstFrameTimeMs) / 1000;

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'OutputDataFrame',
    scenarioId: record.scenarioId,
    sentAt,
    time: {
      ...emptyTime(),
      sim: legacy.timeframe.toISOString().slice(11, 19),
      elapsed: round(elapsedSec, 3),
      tick
    },
    diagram: {
      trainNumber: record.diagramNumber,
      boundFor: record.boundFor,
      serviceType: record.serviceType,
      direction: record.direction,
      runNumber: record.runNumber
    },
    stations: {
      list: record.stations,
      currentIndex: null,
      nextIndex: legacy.nextStationIndex
    },
    physics: {
      ...emptyPhysics(),
      speed: legacy.speed,
      fromStartDistance: legacy.distance.fromStart,
      gradient: legacy.gradient
    },
    controllers: {
      ...emptyControllers(),
      powerNotch: legacy.notch.p,
      brakeNotch: legacy.notch.b
    },
    doors: emptyDoors(),
    lamps: {
      values: {
        emergencyBrake: legacy.lamps.eBrake ? 1 : 0,
        ebTimer: legacy.lamps.ebTimer ? 1 : 0,
        pilot: legacy.lamps.pilot ? 1 : 0,
        regenerative: legacy.lamps.regenBrake ? 1 : 0
      }
    },
    ats: {
      ...emptyAts(),
      state: legacy.atsState || null
    },
    signals: emptySignals(),
    speedLimit: {
      ...emptySpeedLimit(),
      current: legacy.speedLimit
    },
    cars: mapCars(record.consist, legacy.amperage, legacy.bcPressure),
    switches: emptySwitches(),
    // These are historical frames captured during real active driving —
    // 'MainGame' is more honest than the empty default ('NotRunning'), even
    // though no evaluator reads gameState today.
    gameState: { ...emptyGameState(), screen: 'MainGame' },
    extensions: null
  };
};

// -- Main ------------------------------------------------------------------

const main = async () => {
  console.info(
    EXECUTE
      ? "Running migration in EXECUTE mode — this will write to tanuden-score's database."
      : 'Running migration in DRY-RUN mode — no data will be written. Pass --execute to write.'
  );

  await connectDatabase();
  const legacyConnection = await mongoose
    .createConnection(DB.LEGACY_CONNECTION_STRING)
    .asPromise();

  const legacyRecordsQuery = legacyConnection
    .collection<LegacyDriveRecord>('drive_records')
    .find({ isComplete: true });
  if (LIMIT) {
    legacyRecordsQuery.limit(LIMIT);
  }
  const legacyRecords = await legacyRecordsQuery.toArray();

  console.info(`Found ${legacyRecords.length} completed legacy drive records.`);

  const directionFlags: CarDirectionFlag[] = [];
  let recordsMigrated = 0;
  let recordsSkippedExisting = 0;
  let framesMigrated = 0;

  for (const legacy of legacyRecords) {
    const recordId = legacy._id.toString();

    const alreadyMigrated = await driveRecordCollection
      .exists({ _id: recordId })
      .lean();
    if (alreadyMigrated) {
      recordsSkippedExisting++;
      continue;
    }

    const stations = legacy.stations.map(mapStation);
    const consist = legacy.consist.map((car) =>
      mapCarStaticInfo(car, recordId, directionFlags)
    );
    const direction = mapLineDirection(legacy.direction);

    const legacyFrames = await legacyConnection
      .collection<LegacyDriveRecordData>('drive_record_data')
      .find({ parentRecord: legacy._id })
      .sort({ timeframe: 1 })
      .toArray();

    const firstFrameTimeMs = legacyFrames[0]?.timeframe.getTime() ?? 0;
    const scenarioId = `migrated-${recordId}`;

    const migratedFrames = legacyFrames.map((frame, index) =>
      mapFrame(
        frame,
        {
          recordId,
          scenarioId,
          stations,
          consist,
          runNumber: legacy.runNumber,
          diagramNumber: legacy.diagramNumber,
          boundFor: legacy.boundFor,
          serviceType: legacy.serviceType,
          direction
        },
        firstFrameTimeMs,
        index
      )
    );

    if (EXECUTE) {
      // Written via the native driver (.collection, bypassing Mongoose
      // entirely) rather than .create()/.insertMany() on the model. Mongoose's
      // `timestamps` schema option can silently override explicitly-passed
      // createdAt/updatedAt on insert — this workspace's other migration tool
      // (migration documents/migrations/, myuntendai -> auth identity move)
      // hit this exact risk and bypasses Mongoose for the same reason: we
      // need the *original* record dates preserved verbatim (stats.controller.ts's
      // activity heatmap reads createdAt directly), not today's date.
      await driveRecordCollection.collection.insertOne({
        _id: legacy._id,
        owner: legacy.owner,
        aggregateScore: legacy.aggregateScore,
        scoreBreakdown: legacy.scoreBreakdown,
        runNumber: legacy.runNumber,
        diagramNumber: legacy.diagramNumber,
        direction,
        boundFor: legacy.boundFor,
        serviceType: legacy.serviceType,
        length: legacy.length,
        consist,
        wattageSpent: legacy.wattageSpent,
        withheldReason: null,
        stations,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt
      });

      if (migratedFrames.length > 0) {
        await driveRecordDataCollection.collection.insertMany(
          migratedFrames.map((frame) => ({
            parentRecord: legacy._id,
            frame,
            capturedAt: new Date(frame.sentAt)
          }))
        );
      }
    }

    recordsMigrated++;
    framesMigrated += migratedFrames.length;
  }

  console.info('\n--- Migration summary ---');
  console.info(`Records migrated: ${recordsMigrated}`);
  console.info(`Records skipped (already migrated): ${recordsSkippedExisting}`);
  console.info(`Frames migrated: ${framesMigrated}`);
  console.info(
    `Car-direction values needing manual review (dropped to null): ${directionFlags.length}`
  );
  if (directionFlags.length > 0) {
    const sample = directionFlags.slice(0, 20);
    console.info(
      'Sample (first 20) — recordId / carNo / field / legacy value:'
    );
    for (const flag of sample) {
      console.info(
        `  ${flag.recordId} / car ${flag.carNo} / ${flag.field} / ${flag.legacyValue}`
      );
    }
  }

  if (!EXECUTE) {
    console.info(
      '\nThis was a dry run — nothing was written. Re-run with --execute to write.'
    );
  }

  await legacyConnection.close();
  await mongoose.connection.close();
};

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
