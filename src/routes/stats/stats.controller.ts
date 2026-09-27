import { Router, type Request, type Response } from 'express';
import driveRecordCollection from '../../models/drive-record.collection';
import ms from 'ms';
import { round } from 'lodash';
import userStatsCollection from '../../models/user-stats.collection';

const router = Router();

router.get('/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  const driveRecords = await driveRecordCollection
    .find({
      owner: userId,
      // Public-eligible only — the same filter the leaderboard uses, so the
      // profile panel can't show totals the leaderboards exclude.
      withheldReason: null
    })
    .select('-anticheatStatus')
    .lean();

  // NOTE: a user with zero completed drives is still a valid user — return
  // zeroed stats, never 404. Identity is owned by auth now; this service has
  // no users collection, so "no drives" must NOT be read as "no such user".

  // Calculate account statistics
  const totalScore = driveRecords.reduce(
    (acc, record) => acc + (record.aggregateScore?.score || 0),
    0
  );
  const totalDistance = driveRecords.reduce(
    (acc, record) => acc + record.length,
    0
  );
  const totalDrives = driveRecords.length;
  const averageAccuracy = totalDrives
    ? driveRecords.reduce((acc, record) => {
        const maxXp = record.scoreBreakdown.reduce(
          (acc, score) => acc + score.maxPossibleScore,
          0
        );

        const percent = (record.aggregateScore?.score || 0) / maxXp;
        return acc + percent;
      }, 0) / totalDrives
    : 0;

  const driveRecordsInPastYear = driveRecords.filter(
    (record) => record.createdAt > new Date(Date.now() - ms('1y'))
  );

  // Sort drive records by date
  const driveRecordDates = driveRecordsInPastYear.map(
    (record) => record.createdAt.toISOString().split('T')[0]
  );

  // Unique list of dates
  // Add 1 year ago and today's date for UI to always show the past year
  const uniqueDates = [
    ...new Set(driveRecordDates),
    new Date(Date.now() - ms('1y')).toISOString(),
    new Date().toISOString()
  ];

  // Count the number of records for each date
  const dateCounts = uniqueDates
    .map((date) => {
      return {
        // Format in YYYY-MM-DD
        date: date?.split('T')[0],
        count: driveRecordDates.filter((d) => d === date).length,
        level: 0
      };
    })
    .sort((a, b) => a.date!.localeCompare(b.date!));

  // Get the user's overall ranking
  const userStats = await userStatsCollection
    .findOne({
      user: userId,
      type: 'all'
    })
    .select('ranking')
    .lean();

  res.json({
    _id: userId,
    activity: dateCounts,
    stats: {
      ranking: userStats?.ranking,
      totalScore,
      totalDistance,
      totalDrives,
      averageAccuracy: round(averageAccuracy, 4)
    }
  });
});

export { router as statsController };
