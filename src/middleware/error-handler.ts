import { NextFunction, Request, Response } from 'express';
import { HttpError, httpErrors } from '../utils/http-errors';
import { DEBUG_MODE } from '../constants';

const isHttpError = (value: unknown): value is HttpError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).statusCode === 'number';

export const errorHandler = async (
  error: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) => {
  let resolved: HttpError | Record<string, unknown> =
    error instanceof SyntaxError
      ? httpErrors.badRequest
      : (error as Record<string, unknown>);

  if (!isHttpError(resolved) || !isHttpError(resolved.stack)) {
    resolved = httpErrors.serverError(resolved);
  }

  if (isHttpError(resolved.stack)) {
    resolved = resolved.stack;
  }

  if (resolved.stack) {
    console.error(resolved.stack);
    if (!DEBUG_MODE) {
      delete resolved.stack;
    }
  }

  res.status(isHttpError(resolved) ? resolved.statusCode : 500).json(resolved);
};
