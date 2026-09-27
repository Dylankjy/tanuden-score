import { parentPort } from 'worker_threads';
import { connectDatabase } from '../utils/database';
import { populateUserStats } from '../utils/user-stats';

(async () => {
  if (!parentPort) {
    throw new Error('No parent port!');
  }

  try {
    await connectDatabase();
    await populateUserStats();
    parentPort.postMessage('done');
  } catch (err) {
    if (err instanceof Error) {
      parentPort.postMessage({ error: err.message });
    }

    throw err;
  }
})();
