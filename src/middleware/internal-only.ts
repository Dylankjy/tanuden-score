import { NextFunction, type Request, type Response } from 'express';
import { WEBSERVER } from '../constants';
import { httpErrors, Reason, throwHttpError } from '../utils/http-errors';

// Guards tanuden-auth's internal RPC calls (server-to-server, not via the
// gateway) — see src/routes/rpc/rpc.controller.
export const internalOnly = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const secret = req.headers['x-internal-secret'];

  if (!secret || secret !== WEBSERVER.INTERNAL_SECRET) {
    throwHttpError(httpErrors.forbidden, Reason.NoPermission, res);
    return;
  }

  next();
};
