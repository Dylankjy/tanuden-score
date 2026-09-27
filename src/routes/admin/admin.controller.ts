import { Router } from 'express';
import driveRecordCollection from '../../models/drive-record.collection';
import { requireLogin } from '../../middleware/permission-handler';
import { httpErrors, Reason, throwHttpError } from '../../utils/http-errors';

const router = Router();

// Staff-only. This is the one place anticheatStatus is ever returned —
// everywhere else (records/rankings/stats controllers) strips it explicitly.
// Closes the loop on flagged runs otherwise having nowhere to be reviewed.
router.get('/flagged-records', requireLogin, async (req, res) => {
  if (!req.user?.flags?.includes('staff')) {
    throwHttpError(httpErrors.forbidden, Reason.NoPermission, res);
    return;
  }

  const page = Number(req.query.page) || 0;
  const limit = Number(req.query.limit) || 30;

  const records = await driveRecordCollection
    .find({ withheldReason: 'anticheat-violation' })
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .skip(page * limit)
    .exec();

  let hasMore = false;
  if (records.length > limit) {
    hasMore = true;
    records.pop();
  }

  res.json({
    items: records,
    currentPage: page,
    hasMore
  });
});

export { router as adminController };
