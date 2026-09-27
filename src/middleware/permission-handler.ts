import { NextFunction, type Request, type Response } from 'express';
import { httpErrors, Reason, throwHttpError } from '../utils/http-errors';

// req.user and req.authType are populated globally by Passport in server.ts
// before any route handler is invoked. These guards only check the presence
// of req.user / req.authType — they do not parse any tokens themselves.

export const requireLogin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    throwHttpError(httpErrors.unauthorized, Reason.LoginRequired, res);
    return;
  }
  next();
};

// Restricts a route to desktop client tokens only.
// Must be used after requireLogin so req.authType is guaranteed to be set.
export const requireClientAuth = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.authType !== 'token') {
    throwHttpError(httpErrors.forbidden, Reason.NoPermission, res);
    return;
  }
  next();
};
