import { Router } from 'express';
import { Types } from 'mongoose';
import driveRecordCollection from '../../models/drive-record.collection';
import driveRecordDataCollection from '../../models/drive-record-data.collection';
import { httpErrors, throwHttpError } from '../../utils/http-errors';
import { validateId } from '../../middleware/id-validator';

const router = Router();

// The drive recorder captures at the console's ~100ms fast-plane cadence (10Hz).
// A chart only needs ~500ms resolution, so the single-record read returns every
// 5th frame. Sampling server-side (before JSON.stringify) is what keeps the
// response bounded — a full-resolution long drive overflows V8's max string
// length. Full-resolution frames stay in the DB for scoring (see finalizeSession).
const CHART_SAMPLE_STRIDE = 5;

// Read-only surface — record creation/append/completion moved to the live
// socket protocol (drive:profile/drive:frame/drive:complete, see Phase C).
// Two-tier visibility: owner (or staff) sees their records in any state;
// everyone else sees only public-eligible records (withheldReason null, the
// same filter the leaderboard uses).

const isStaffLike = (flags: string[] | undefined): boolean =>
  flags?.includes('staff') === true || flags?.includes('god') === true;

router.get('/:userId', validateId(['userId']), async (req, res) => {
  const { userId } = req.params;

  const isSelfOrStaff =
    req.user !== undefined &&
    (String(req.user._id) === userId || isStaffLike(req.user.flags));

  const complete = (req.query.complete ?? 'true') !== 'false';

  // In-progress drives are private, so a public reader gets an empty page.
  if (!isSelfOrStaff && complete === false) {
    res.json({ items: [], currentPage: 0, hasMore: false });
    return;
  }

  const page = Number(req.query.page) || 0;
  const limit = Number(req.query.limit) || 30;

  const records = await driveRecordCollection
    .find({
      owner: userId,
      withheldReason: isSelfOrStaff
        ? complete
          ? { $ne: 'in-progress' }
          : 'in-progress'
        : null
    })
    .select('-anticheatStatus')
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .skip(page * limit)
    .exec();

  let hasMore = false;
  if (records.length > limit) {
    hasMore = true;
    records.pop(); // Remove the last item to indicate more results
  }

  res.json({
    items: records,
    currentPage: page,
    hasMore
  });
});

router.get('/records/:recordId', validateId(['recordId']), async (req, res) => {
  const { recordId } = req.params;

  const record = await driveRecordCollection
    .findById(recordId)
    .select('-anticheatStatus');

  // Uniform 404 for missing and not-visible so record ids can't be probed.
  if (!record) {
    throwHttpError(httpErrors.notFound, null, res);
    return;
  }

  const isOwner =
    req.user !== undefined && record.owner.toString() === String(req.user._id);

  if (
    !isOwner &&
    !isStaffLike(req.user?.flags) &&
    record.withheldReason !== null
  ) {
    throwHttpError(httpErrors.notFound, null, res);
    return;
  }

  res.json(record.toObject());
});

// Split from the record fetch above so the (small, fast) record and the
// (large, aggregated) telemetry can be requested — and rendered — in
// parallel rather than making the whole page wait on the bigger dataset.
router.get(
  '/records/:recordId/data',
  validateId(['recordId']),
  async (req, res) => {
    const { recordId } = req.params;

    // Visibility rides the parent record so withheld frames stay private.
    const record = await driveRecordCollection
      .findById(recordId)
      .select('owner withheldReason');

    if (!record) {
      throwHttpError(httpErrors.notFound, null, res);
      return;
    }

    const isOwner =
      req.user !== undefined &&
      record.owner.toString() === String(req.user._id);

    if (
      !isOwner &&
      !isStaffLike(req.user?.flags) &&
      record.withheldReason !== null
    ) {
      throwHttpError(httpErrors.notFound, null, res);
      return;
    }

    // Downsample to ~500ms in the database so only the sampled frames cross the
    // wire. $documentNumber is 1-based, so `- 1` keeps indices 0, 5, 10… — the
    // first frame is always included (the client reads driveData[0].expiresAt).
    const recordData = await driveRecordDataCollection.aggregate([
      { $match: { parentRecord: new Types.ObjectId(String(recordId)) } },
      { $sort: { capturedAt: 1 } },
      {
        $setWindowFields: {
          sortBy: { capturedAt: 1 },
          output: { _idx: { $documentNumber: {} } }
        }
      },
      {
        $match: {
          $expr: {
            $eq: [
              { $mod: [{ $subtract: ['$_idx', 1] }, CHART_SAMPLE_STRIDE] },
              0
            ]
          }
        }
      },
      { $project: { _idx: 0 } }
    ]);

    res.json(recordData);
  }
);

export { router as recordsController };
