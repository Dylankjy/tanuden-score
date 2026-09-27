import { Router } from 'express';
import userStatsCollection from '../../models/user-stats.collection';
import { InferType, string } from 'yup';
import { httpErrors, throwHttpError } from '../../utils/http-errors';
import driveRecordCollection from '../../models/drive-record.collection';

const router = Router();

const SortBySchema = string()
  .oneOf(['timeliness', 'stop-accuracy', 'eco-driving', 'score', 'accuracy'])
  .default('score');

const FilterBySchema = string().oneOf(['global', 'diagram']).default('global');

const DurationWithinSchema = string()
  .oneOf(['monthly', 'weekly', 'all'])
  .default('all');

const kebabToCamel = (str: string): string => {
  return str.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
};

const durationWithinToDate = (duration: string): Date => {
  const now = new Date();
  switch (duration) {
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'weekly':
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - now.getDay()
      );
    case 'all':
    default:
      return new Date(0); // Return epoch for all time
  }
};

router.get('/:filter/:sort', async (req, res) => {
  const { filter, sort } = req.params;

  const page = Number(req.query.page) || 0;
  const limit = Number(req.query.limit) || 30;
  const duration = req.query.duration;
  const diagram = req.query.diagram;

  let sortBy: string;
  let filterBy: string;
  let durationWithin: InferType<typeof DurationWithinSchema>;
  try {
    sortBy = kebabToCamel(SortBySchema.validateSync(sort));
    filterBy = kebabToCamel(FilterBySchema.validateSync(filter));
    durationWithin = DurationWithinSchema.validateSync(duration);
  } catch {
    throwHttpError(httpErrors.badRequest, null, res);
    return;
  }

  // Anti-cheat posture: flagged/session-interrupted records are excluded
  // from leaderboards regardless of filter, pending review — see Phase C.
  if (filterBy === 'global') {
    const userStats = await userStatsCollection
      .find({
        type: durationWithin
      })
      .where('totalRecords')
      .gte(5)
      .skip(page * limit)
      .limit(limit + 1)
      .sort({ [sortBy]: -1 })
      .lean();

    let hasMore = false;
    if (userStats.length > limit) {
      hasMore = true;
      userStats.pop();
    }

    res.json({
      items: userStats,
      currentPage: page,
      hasMore
    });
    return;
  }

  if (filterBy === 'diagram') {
    // Treat accuracy same as score
    if (sortBy === 'accuracy') {
      sortBy = 'score';
    }

    const diagramStats = await driveRecordCollection
      .find({
        diagramNumber: diagram as string,
        withheldReason: null
      })
      .where('createdAt')
      .gte(durationWithinToDate(durationWithin).getTime())
      .skip(page * limit)
      .limit(limit + 1)
      .sort({ [`aggregateScore.${sortBy}`]: -1 })
      .select('-_id owner aggregateScore')
      .lean();

    let hasMore = false;
    if (diagramStats.length > limit) {
      hasMore = true;
      diagramStats.pop();
    }

    res.json({
      items: diagramStats,
      currentPage: page,
      hasMore
    });
    return;
  }

  throwHttpError(httpErrors.badRequest, null, res);
});

export { router as rankingsController };
