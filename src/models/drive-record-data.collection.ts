import { model, Schema, Types } from 'mongoose';
import { OutputDataFrame } from '@tanuden/rudolf';
import ms from 'ms';

export interface DriveRecordFrame {
  parentRecord: Types.ObjectId;
  // The full Rudolf OutputDataFrame, stored as-is rather than re-declared
  // field-by-field in Mongoose. Rudolf's own TS/C# types are the schema of
  // record for this payload — duplicating its ~40 nested fields here would
  // only drift out of sync as Rudolf's spec evolves. Evaluators read this
  // shape directly (see evaluations/abstract-evaluation.ts) — no translation
  // layer.
  frame: OutputDataFrame;
  // Hoisted out of frame.sentAt purely so Mongo can index/sort on it without
  // reaching into the Mixed blob — mirrors the old schema's top-level
  // `timeframe` field.
  capturedAt: Date;
  expiresAt: Date;
}

export const DriveRecordDataSchema = new Schema<DriveRecordFrame>(
  {
    parentRecord: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'drive_record',
      index: true
    },
    frame: { type: Schema.Types.Mixed, required: true },
    capturedAt: { type: Date, required: true, index: true },

    expiresAt: {
      type: Date,
      required: false,
      expires: 0,
      default: () => ms('24h') + Date.now()
    }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
    versionKey: false
  }
);

export default model(
  'drive_record_data',
  DriveRecordDataSchema,
  'drive_record_data'
);
