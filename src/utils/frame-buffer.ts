import { Types } from 'mongoose';
import driveRecordDataCollection from '../models/drive-record-data.collection';
import { LiveSession } from './live-sessions';

export const flushFrameBuffer = async (
  recordId: string,
  session: LiveSession
): Promise<void> => {
  if (session.frameBuffer.length === 0) {
    return;
  }

  const rows = session.frameBuffer.map((frame) => ({
    parentRecord: new Types.ObjectId(recordId),
    frame,
    capturedAt: new Date(frame.sentAt)
  }));

  session.frameBuffer = [];
  session.lastFlushAt = Date.now();

  await driveRecordDataCollection.insertMany(rows);
};
