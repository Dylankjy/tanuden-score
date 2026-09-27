import { model, Schema } from 'mongoose';
import ms from 'ms';
import { DriveRecord, ScoreBreakdown } from '../types/drive-evaluation';

const DriveRecordSchema = new Schema<DriveRecord>(
  {
    owner: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true
    },

    aggregateScore: {
      score: { type: Number, required: false },
      stopAccuracy: { type: Number, required: false },
      timeliness: { type: Number, required: false },
      ecoDriving: { type: Number, required: false }
    },

    scoreBreakdown: [
      new Schema<ScoreBreakdown>({
        timeframe: { type: Date, required: false },
        stationIndex: { type: Number, required: false, default: null },
        reason: { type: String, required: true },
        data: { type: Array, required: false },
        score: { type: Number, required: true },
        maxPossibleScore: { type: Number, required: true },
        type: {
          type: String,
          required: true,
          default: 'Good',
          enum: ['Good', 'Bad', 'VeryBad', 'Bonus']
        }
      })
    ],

    // Identity fields are Rudolf-native: runNumber/direction only ever arrive
    // via the first frame's OutputDataFrame.diagram (SimulatorProfile.scenario
    // has no runNumber/direction field at all), diagramNumber/boundFor/
    // serviceType may come from either the profile or the frame.
    runNumber: { type: String, required: false, default: null, maxlength: 10 },
    diagramNumber: {
      type: String,
      required: false,
      default: null,
      maxlength: 10,
      index: true
    },
    direction: {
      type: String,
      required: false,
      default: null,
      enum: ['Upbound', 'Downbound', null]
    },
    boundFor: { type: String, required: false, default: null },
    serviceType: { type: String, required: false, default: null },
    length: { type: Number, required: true, min: 0, default: 0 },

    // Rudolf CarStaticInfo[], stored as-is (SimulatorProfile.vehicle.cars).
    consist: [
      new Schema(
        {
          carNo: { type: Number, required: true, min: 0 },
          model: { type: String, required: true },
          hasDriverCab: { type: Boolean, required: true },
          hasConductorCab: { type: Boolean, required: true },
          hasMotor: { type: Boolean, required: true },
          hasPantograph: { type: Boolean, required: true },
          cabDirection: {
            type: String,
            default: null,
            enum: ['Left', 'Right', null]
          },
          pantographType: {
            type: String,
            default: null,
            enum: ['SingleArm', 'Scissor', null]
          },
          pantographDirection: {
            type: String,
            default: null,
            enum: ['Left', 'Right', 'Both', null]
          },
          length: { type: Number, required: true }
        },
        { _id: false }
      )
    ],
    wattageSpent: { type: Number, required: false, default: 0 },

    // Single source of truth for public/leaderboard eligibility — see Phase C.
    // 'in-progress' is the only value stored while a drive is ongoing.
    withheldReason: {
      type: String,
      required: false,
      default: 'in-progress',
      enum: ['in-progress', 'timed-out', 'anticheat-violation', null]
    },
    // Structured anti-cheat diagnostic for a future staff-review workflow.
    // MUST NOT be returned by any public-facing endpoint — every REST read
    // that can return a drive_record document excludes this via .select().
    anticheatStatus: {
      reason: { type: String, required: false },
      detail: { type: Schema.Types.Mixed, required: false }
    },
    // Populated at drive:complete only — see the duplicate-submission check.
    frameFingerprint: { type: String, required: false, index: true },

    // TTL: expires 24h after creation while still 'in-progress' — guards
    // against a crashed/orphaned live session (see Phase C) that never
    // reaches a terminal withheldReason. The drive:complete / disconnect-
    // timeout finalization path must unset this field so a finished record's
    // auto-deletion is disabled entirely, regardless of outcome.
    incompleteDeleteAt: {
      type: Date,
      required: false,
      expires: 0,
      default: () => ms('24h') + Date.now()
    },

    // Rudolf Station[], stored as-is (from the first frame's stations.list).
    stations: [
      new Schema(
        {
          index: { type: Number, required: true, min: 0 },
          name: { type: String, required: true },
          fromStartDistance: { type: Number, required: true, min: 0 },
          absoluteDistance: { type: Number, required: false, default: null },
          doorSide: { type: Number, required: true },
          stopType: {
            type: String,
            required: false,
            default: null,
            enum: ['PassengerStop', 'OperationStop', 'Passing', null]
          },
          arrival: { type: String, required: false, default: null },
          departure: { type: String, required: false, default: null },
          stopPositionName: { type: String, required: false, default: null },
          isTimeTaken: { type: Boolean, required: false, default: null },
          stopPositions: { type: [Number], required: false, default: null }
        },
        { _id: false }
      )
    ]
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

export default model('drive_record', DriveRecordSchema);
