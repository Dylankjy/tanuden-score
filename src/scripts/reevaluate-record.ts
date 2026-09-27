import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { connectDatabase } from '../utils/database';
import driveRecordCollection from '../models/drive-record.collection';
import driveRecordDataCollection from '../models/drive-record-data.collection';
import { computeDriveScore } from '../utils/compute-drive-score';
import { ScoreBreakdown } from '../types/drive-evaluation';

// Offline re-scoring of an already-finalized drive_record: reloads its stored
// frames and re-runs the full evaluator suite (utils/compute-drive-score.ts —
// the exact same core the live drive:complete finalizer uses), then overwrites
// ONLY the scoring fields (scoreBreakdown, aggregateScore, wattageSpent).
// Everything else — withheldReason, anticheatStatus, frameFingerprint, the
// retention TTL — is left untouched: this is a pure re-score, never a
// re-finalization, so it can't flip a record's eligibility or cheat status.
//
// Dry-run by default (prints an old-vs-new comparison, writes nothing) per this
// repo's script norms — pass --execute to persist.
//
// Usage:
//   npm run reevaluate -- <recordId>              # dry run
//   npm run reevaluate -- <recordId> --execute    # write

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const recordId = args.find((arg) => !arg.startsWith('--'));

// Summarize a breakdown into per-reason { count, score } so the old-vs-new
// diff stays readable regardless of how many stops the drive had.
const summarize = (breakdown: ScoreBreakdown[]) => {
  const byReason = new Map<string, { count: number; score: number }>();
  for (const entry of breakdown) {
    const current = byReason.get(entry.reason) ?? { count: 0, score: 0 };
    current.count += 1;
    current.score += entry.score;
    byReason.set(entry.reason, current);
  }
  return byReason;
};

const printComparison = (
  before: ScoreBreakdown[],
  after: ScoreBreakdown[]
): void => {
  const oldByReason = summarize(before);
  const newByReason = summarize(after);
  const reasons = [
    ...new Set([...oldByReason.keys(), ...newByReason.keys()])
  ].sort();

  console.info('\nPer-reason breakdown (old -> new):');
  console.info(
    '  reason'.padEnd(34) + 'old (n, score)'.padEnd(22) + 'new (n, score)'
  );
  for (const reason of reasons) {
    const before = oldByReason.get(reason);
    const after = newByReason.get(reason);
    const beforeText = before ? `${before.count}, ${before.score}` : '—';
    const afterText = after ? `${after.count}, ${after.score}` : '—';
    const changed =
      (before?.count ?? 0) !== (after?.count ?? 0) ||
      (before?.score ?? 0) !== (after?.score ?? 0);
    console.info(
      `  ${reason.padEnd(32)}${beforeText.padEnd(22)}${afterText}${changed ? '   <-- changed' : ''}`
    );
  }
};

const main = async () => {
  if (!recordId || !Types.ObjectId.isValid(recordId)) {
    console.error(
      'Usage: npm run reevaluate -- <recordId> [--execute]\n' +
        'A valid drive_record ObjectId is required.'
    );
    process.exitCode = 1;
    return;
  }

  console.info(
    EXECUTE
      ? `Re-scoring ${recordId} in EXECUTE mode — this WILL overwrite its scoring fields.`
      : `Re-scoring ${recordId} in DRY-RUN mode — nothing will be written. Pass --execute to persist.`
  );

  await connectDatabase();

  try {
    const record = await driveRecordCollection.findById(recordId);
    if (!record) {
      console.error(`No drive_record found with _id ${recordId}.`);
      process.exitCode = 1;
      return;
    }

    const frameRows = await driveRecordDataCollection
      .find({ parentRecord: new Types.ObjectId(recordId) })
      .sort({ capturedAt: 1 })
      .lean();
    const frames = frameRows.map((row) => row.frame);

    if (frames.length === 0) {
      // Retention TTL may have already culled this record's frames — without
      // them there is nothing to re-score, and blindly writing an empty
      // breakdown would destroy the existing scores. Refuse rather than wipe.
      console.error(
        `Record ${recordId} has 0 stored frames — cannot re-score (frames may have expired). Aborting without changes.`
      );
      process.exitCode = 1;
      return;
    }

    const { stations, consist } = record;
    const computed = computeDriveScore(frames, stations, consist);

    const oldTotal = record.aggregateScore?.score ?? 0;
    const newTotal = computed.aggregateScore.score;

    console.info(
      `\nLoaded ${frames.length} frames across ${stations.length} stations.`
    );
    console.info(
      `Breakdown entries: ${record.scoreBreakdown.length} -> ${computed.scoreBreakdown.length}`
    );
    console.info(`Total score:       ${oldTotal} -> ${newTotal}`);

    printComparison(record.scoreBreakdown, computed.scoreBreakdown);

    if (!EXECUTE) {
      console.info(
        '\nThis was a dry run — nothing was written. Re-run with --execute to persist.'
      );
      return;
    }

    record.scoreBreakdown = computed.scoreBreakdown;
    record.aggregateScore = computed.aggregateScore;
    record.wattageSpent = computed.wattageSpent;
    await record.save();

    // Bug fix: Mongoose silently backfills incompleteDeleteAt's schema
    // default into memory on findById() even when the field is genuinely
    // absent from the stored document, and record.save() above persists
    // that phantom default — re-arming a 24h auto-delete on an
    // already-finalized record despite this script's "TTL left untouched"
    // intent. Mirrors recorder.ts's finalizeSessionBody, which clears the
    // same field the same way after its own record.save().
    await driveRecordCollection.updateOne(
      { _id: recordId },
      { $unset: { incompleteDeleteAt: 1 } }
    );

    console.info(`\nDone — ${recordId} re-scored and saved.`);
  } finally {
    await mongoose.connection.close();
  }
};

main().catch((err) => {
  console.error('Re-evaluation failed:', err);
  process.exitCode = 1;
});
