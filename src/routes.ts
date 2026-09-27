import { Application } from 'express';
import { indexController } from './routes/index.controller';
import { statsController } from './routes/stats/stats.controller';
import { recordsController } from './routes/records/records.controller';
import { rankingsController } from './routes/rankings/rankings.controller';
import { adminController } from './routes/admin/admin.controller';
import { rpcController } from './routes/rpc/rpc.controller';
import { internalOnly } from './middleware/internal-only';

// REST reads only, mounted under the same paths as myuntendai for a
// low-friction UI cutover — record creation/append/completion moved to the
// live socket protocol (see Phase C).
export const routes = (app: Application) => {
  app.use('/stats', statsController);
  app.use('/drive-recorder', recordsController);
  app.use('/rankings', rankingsController);
  app.use('/admin', adminController);
  // Mount-level internal guard: every /rpc route is internal-only by default,
  // so a future route can't silently ship unguarded.
  app.use('/rpc', internalOnly, rpcController);
  app.use(indexController);
};
