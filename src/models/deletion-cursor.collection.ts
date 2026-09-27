import { model, Schema } from 'mongoose';

// One-doc collection: this service's bookmark into auth's deletion event feed.
// lastEventId is the hex _id of the last processed deletion_events row; the
// poller checkpoints it after each handled event (delivery is at-least-once,
// so consumers must keep their actions idempotent).
const DeletionCursorSchema = new Schema(
  {
    _id: { type: String, required: true },
    lastEventId: { type: String, required: true },
    updatedAt: { type: Date, required: true }
  },
  { versionKey: false }
);

export default model(
  'deletion_cursor',
  DeletionCursorSchema,
  'deletion_cursor'
);
