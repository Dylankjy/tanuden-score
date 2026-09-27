import { Types } from 'mongoose';
import deletionCursorCollection from '../models/deletion-cursor.collection';
import { AUTH, WEBSERVER } from '../constants';

const POLL_INTERVAL_MS = 60_000;

const isDeletionEventsPayload = (
  value: unknown
): value is { events: { id: string; userId: string }[] } =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { events: unknown }).events);

// A fresh subscriber only sees deletions from its own deployment on — it never
// replays history it was not there for.
const bootstrapCursor = (): string =>
  Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000)).toString();

const readLastEventId = async (): Promise<string> => {
  const cursor = await deletionCursorCollection.findOne().lean();
  if (cursor?.lastEventId) {
    return cursor.lastEventId;
  }
  // First run: bootstrap to "now" AND persist it — recomputing per poll would
  // push the cursor past events created since boot and silently skip them.
  const bootstrap = bootstrapCursor();
  await deletionCursorCollection.findOneAndUpdate(
    { _id: 'deletion-cursor' },
    { $set: { lastEventId: bootstrap, updatedAt: new Date() } },
    { upsert: true }
  );
  return bootstrap;
};

const handleUserDeleted = (userId: string): void => {
  // Extension point: erase or anonymize anything this service derived from the
  // deleted user. MUST stay idempotent — feed delivery is at-least-once.
  console.info(`[deletion-sync] user deleted: ${userId}`);
};

const poll = async (): Promise<void> => {
  if (!AUTH.SERVICE_URL) {
    console.warn('[deletion-sync] AUTH_SERVICE_URL is not set; skipping');
    return;
  }

  const since = await readLastEventId();
  const response = await fetch(
    `${AUTH.SERVICE_URL}/rpc/deletion-events?since=${encodeURIComponent(since)}`,
    { headers: { 'x-internal-secret': WEBSERVER.INTERNAL_SECRET } }
  );

  if (!response.ok) {
    throw new Error(`deletion feed returned ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isDeletionEventsPayload(payload)) {
    throw new Error('deletion feed returned an unexpected payload');
  }

  // Serial, in _id order — the cursor is a high-water mark, so handling events
  // out of order (or in parallel) would break "cursor covers everything
  // before it". Checkpoint immediately after each action: a crash replays at
  // most the one event in flight.
  for (const event of payload.events) {
    handleUserDeleted(event.userId);
    await deletionCursorCollection.findOneAndUpdate(
      { _id: 'deletion-cursor' },
      { $set: { lastEventId: event.id, updatedAt: new Date() } },
      { upsert: true }
    );
  }
};

export const startDeletionSyncJob = (): void => {
  console.info('[deletion-sync] job started (polling every 60s)');
  const run = () => {
    poll().catch((error: unknown) => {
      // Auth down / transient failure: skip the cycle, keep the cursor. The
      // missed events are still in the feed and arrive on a later poll.
      console.error('[deletion-sync] poll failed:', error);
    });
  };
  run();
  setInterval(run, POLL_INTERVAL_MS);
};
