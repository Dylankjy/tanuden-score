'use strict';
import 'dotenv/config';
import GracefulShutdown from 'http-graceful-shutdown';
import { DEBUG_MODE, WEBSERVER } from './constants';
import { server } from './server';
import './utils/database';
import { schedule } from 'node-cron';
import { resolve } from 'path';
import { Worker } from 'worker_threads';
import { startDeletionSyncJob } from './jobs/deletion-sync.job';

// Runs user-stats population in an isolated worker thread rather than the
// main thread — a Worker's uncaught exception/unhandled rejection only ends
// that worker (fires 'error' below), it never crashes the parent process, so
// a MongoDB outage at boot can no longer take the whole service down with it.
const STATS_REBUILD_TIMEOUT_MS = 30 * 60 * 1000;
const STATS_REBUILD_RETRY_MS = 10 * 60 * 1000;
let statsRebuildRunning = false;

const runUserStatsWorker = (allowRetry = true): void => {
  if (statsRebuildRunning) {
    console.warn('User stats rebuild already running; skipping.');
    return;
  }
  statsRebuildRunning = true;

  const workerPath = resolve(__dirname, './workers/user-stats.worker.js');
  const worker = new Worker(workerPath);
  let settled = false;
  let failed = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    statsRebuildRunning = false;
  };

  const timeout = setTimeout(() => {
    if (settled) return;
    console.error('User stats rebuild timed out; terminating worker.');
    worker.terminate();
  }, STATS_REBUILD_TIMEOUT_MS);

  worker.on('message', (msg) => {
    console.log(`Worker message: ${msg}`);
  });

  worker.on('error', (err) => {
    console.error(`Worker error: ${err}`);
    failed = true;
  });

  worker.on('exit', (code) => {
    clearTimeout(timeout);
    if (code !== 0 || failed) {
      console.error(`Worker stopped with exit code ${code}`);
      // One retry instead of a broken leaderboard waiting up to 24h.
      if (allowRetry) {
        setTimeout(() => runUserStatsWorker(false), STATS_REBUILD_RETRY_MS);
      }
    } else {
      console.log('Worker finished successfully');
    }
    settle();
  });
};

(async () => {
  const { server: appServer } = server();
  const app = appServer.listen(WEBSERVER.PORT);

  if (DEBUG_MODE) {
    console.warn(
      '環境確認！: Running in DEBUG mode (with security features disabled).'
    );
  } else {
    console.info('環境確認！: Running in PRODUCTION mode.');
  }
  console.info(
    `サーバー起動完了: http://${WEBSERVER.SERVICE_URL}:${WEBSERVER.PORT}`
  );

  GracefulShutdown(app, {
    preShutdown: async () => console.log('終了中...'),
    onShutdown: async () => console.log('終了しました。')
  });

  runUserStatsWorker();

  startDeletionSyncJob();

  schedule('0 4 * * *', () => runUserStatsWorker(), { timezone: 'Asia/Tokyo' });
})();
