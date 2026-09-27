import { Router } from 'express';
import zip from 'jszip';
import { isValidObjectId } from 'mongoose';
import { httpErrors, throwHttpError } from '../../utils/http-errors';
import driveRecordCollection from '../../models/drive-record.collection';
import driveRecordDataCollection from '../../models/drive-record-data.collection';
import userStatsCollection from '../../models/user-stats.collection';

const router = Router();

// Called by tanuden-auth's POST /account/data-package (server-to-server,
// internal network). Auth merges the returned entries — by filename — into
// the user's download, so the three names below are a hard contract.
// internalOnly is enforced at the /rpc mount (see routes.ts).
router.post('/data-package', async (req, res) => {
  const userIdHeader = req.headers['x-user-id'];
  const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader;

  if (!userId || !isValidObjectId(String(userId))) {
    throwHttpError(httpErrors.badRequest, null, res);
    return;
  }

  const driveRecords = await driveRecordCollection
    .find({ owner: userId })
    // anticheatStatus must never leave the service — see the model comment.
    .select('-anticheatStatus')
    .lean();
  const driveRecordData = await driveRecordDataCollection
    .find({
      parentRecord: { $in: driveRecords.map((r) => r._id) }
    })
    .lean();
  const userStats = await userStatsCollection.find({ user: userId }).lean();

  const zipFile = new zip();

  zipFile.file('drive-records.json', JSON.stringify(driveRecords, null, 2));
  zipFile.file(
    'drive-record-data.json',
    JSON.stringify(driveRecordData, null, 2)
  );
  zipFile.file('user-stats.json', JSON.stringify(userStats, null, 2));

  const packedDataPackage = await zipFile.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE'
  });

  res.setHeader('Content-Type', 'application/zip');
  res.send(packedDataPackage);
});

export { router as rpcController };
