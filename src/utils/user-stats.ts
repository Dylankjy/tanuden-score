import { round } from 'lodash';
import mongoose, { model, Types } from 'mongoose';
import driveRecordCollection from '../models/drive-record.collection';
import { UserStatsSchema } from '../models/user-stats.collection';
import { UserStats } from '../types/stats';
import { DriveRecord } from '../types/drive-evaluation';

// Users processed per Promise.all wave — bounds worker memory (one unbounded
// fan-out used to hold every record document in the heap at once).
const USER_BATCH_SIZE = 25;

const getStagingCollection = () => {
  // Each rebuild runs in a fresh worker thread, so one registration per
  // process is guaranteed.
  return (
    mongoose.models.user_stats_next ??
    model('user_stats_next', UserStatsSchema, 'user_stats_next')
  );
};

const processUserStats = (
  driveRecords: DriveRecord[],
  ownerId: Types.ObjectId
): Partial<UserStats> => {
  const totalRecords = driveRecords.length;
  const totalDistance = driveRecords.reduce(
    (acc, record) => acc + record.length,
    0
  );

  const timeliness =
    driveRecords.reduce(
      (acc, record) => acc + (record.aggregateScore?.timeliness || 0),
      0
    ) / totalRecords;

  const stopAccuracy =
    driveRecords.reduce(
      (acc, record) => acc + (record.aggregateScore?.stopAccuracy || 0),
      0
    ) / totalRecords;

  const ecoDriving =
    driveRecords.reduce(
      (acc, record) => acc + (record.aggregateScore?.ecoDriving || 0),
      0
    ) / totalRecords;

  const totalScore = driveRecords.reduce(
    (acc, record) => acc + (record.aggregateScore?.score || 0),
    0
  );

  const averageAccuracy =
    totalRecords === 0
      ? 0
      : driveRecords.reduce((acc, record) => {
          const maxXp = record.scoreBreakdown.reduce(
            (acc, score) => acc + score.maxPossibleScore,
            0
          );

          const percent = (record.aggregateScore?.score || 0) / maxXp;
          return acc + percent;
        }, 0) / totalRecords;

  return {
    user: ownerId,
    timeliness: round(timeliness, 5) || 0,
    accuracy: round(averageAccuracy, 5) || 0,
    stopAccuracy: round(stopAccuracy, 5) || 0,
    ecoDriving: round(ecoDriving, 5) || 0,
    score: round(totalScore, 3) || 0,
    totalDistance: round(totalDistance, 1) || 0,
    totalRecords: totalRecords || 0
  };
};

export const processRanking = (userStatsData: Partial<UserStats>[]) => {
  const sortedUserStatsData = userStatsData.sort((a, b) => b.score! - a.score!);

  sortedUserStatsData.forEach((userStat, index) => {
    if (userStat.totalRecords === 0) {
      userStat.ranking = null;
      return;
    }

    userStat.ranking = index + 1;
  });
};

export const populateUserStats = async () => {
  // Enumerate distinct owner userIds from completed drive records. This
  // service owns no users collection — identity is the auth userId stored
  // on drive_record.owner.
  const ownerIds = await driveRecordCollection.distinct('owner', {
    withheldReason: null
  });

  const monthlyStats: Partial<UserStats>[] = [];
  const weeklyStats: Partial<UserStats>[] = [];
  const allTimeStats: Partial<UserStats>[] = [];

  for (let i = 0; i < ownerIds.length; i += USER_BATCH_SIZE) {
    const batch = ownerIds.slice(i, i + USER_BATCH_SIZE);
    const batchStats = await Promise.all(
      batch.map(
        async (
          ownerId
        ): Promise<{
          monthlyStats: Partial<UserStats>;
          weeklyStats: Partial<UserStats>;
          allTimeStats: Partial<UserStats>;
        }> => {
          const driveRecordsThisMonth = await driveRecordCollection
            .find({ owner: ownerId, withheldReason: null })
            .where('createdAt')
            .gte(
              new Date(
                new Date().getFullYear(),
                new Date().getMonth(),
                1
              ).getTime()
            )
            .lean();
          const driveRecordsThisWeek = await driveRecordCollection
            .find({ owner: ownerId, withheldReason: null })
            .where('createdAt')
            .gte(
              new Date(
                new Date().getFullYear(),
                new Date().getMonth(),
                new Date().getDate() - new Date().getDay()
              ).getTime()
            )
            .lean();

          const driveRecordsAllTime = await driveRecordCollection
            .find({ owner: ownerId, withheldReason: null })
            .lean();

          const monthlyStats = processUserStats(driveRecordsThisMonth, ownerId);
          const weeklyStats = processUserStats(driveRecordsThisWeek, ownerId);
          const allTimeStats = processUserStats(driveRecordsAllTime, ownerId);

          return {
            monthlyStats: {
              ...monthlyStats,
              user: ownerId,
              type: 'monthly'
            },
            weeklyStats: {
              ...weeklyStats,
              user: ownerId,
              type: 'weekly'
            },
            allTimeStats: {
              ...allTimeStats,
              user: ownerId,
              type: 'all'
            }
          };
        }
      )
    );

    monthlyStats.push(...batchStats.map((s) => s.monthlyStats));
    weeklyStats.push(...batchStats.map((s) => s.weeklyStats));
    allTimeStats.push(...batchStats.map((s) => s.allTimeStats));
  }

  // Rank across ALL users of a period, then insert.
  processRanking(monthlyStats);
  processRanking(weeklyStats);
  processRanking(allTimeStats);

  // Build into a staging collection, then swap atomically — readers see the
  // old leaderboard until the instant the new one replaces it.
  const staging = getStagingCollection();
  await staging.deleteMany({});
  const rows = [
    ...monthlyStats,
    ...weeklyStats,
    ...allTimeStats
  ] as UserStats[];
  if (rows.length === 0) {
    throw new Error('Stats rebuild produced zero rows');
  }
  await staging.insertMany(rows);
  await staging.syncIndexes();

  const stagedCount = await staging.countDocuments({});
  if (stagedCount !== rows.length) {
    throw new Error(
      `Stats rebuild staging mismatch: expected ${rows.length} rows, found ${stagedCount}`
    );
  }

  await mongoose.connection.db!.renameCollection(
    'user_stats_next',
    'user_stats',
    { dropTarget: true }
  );

  console.log(
    `User stats populated successfully - ${ownerIds.length} users processed`
  );
};
