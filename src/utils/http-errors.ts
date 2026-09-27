import status from 'http-status';
import { Response } from 'express';

export interface HttpError {
  statusCode: number;
  type: string;
  because: string | null;
  stack?: unknown;
}

export const httpErrors = {
  requestTimeout: {
    statusCode: 408,
    type: status['408_NAME'].toLowerCase(),
    because: null
  },
  badRequest: {
    statusCode: 400,
    type: status['400_NAME'].toLowerCase(),
    because: null
  },
  unauthorized: {
    statusCode: 401,
    type: status['401_NAME'].toLowerCase(),
    because: null
  },
  forbidden: {
    statusCode: 403,
    type: status['403_NAME'].toLowerCase(),
    because: null
  },
  notFound: {
    statusCode: 404,
    type: status['404_NAME'].toLowerCase(),
    because: null
  },
  conflict: {
    statusCode: 409,
    type: status['409_NAME'].toLowerCase(),
    because: null
  },
  unprocessableEntity: {
    statusCode: 422,
    type: status['422_NAME'].toLowerCase(),
    because: null
  },
  tooManyRequests: {
    statusCode: 429,
    type: status['429_NAME'].toLowerCase(),
    because: null
  },
  serverError: (error: unknown) => {
    return {
      statusCode: 500,
      type: status['500_NAME'].toLowerCase(),
      stack: error,
      because: null
    };
  }
};

export enum Reason {
  LoginRequired = 'login_required',
  NoPermission = 'no_permission'
}

export const throwHttpError = (
  error: Record<string, unknown> | HttpError,
  reason?: Reason | null,
  res?: Response
) => {
  if (!error?.statusCode) {
    error = httpErrors.serverError(error);

    if (res) {
      res.status(error.statusCode as number).json(error);
      return;
    }

    throw error;
  }

  error = { ...error, because: reason ?? null };

  if (res) {
    res.status(error.statusCode as number).json(error);
    return;
  }

  throw error;
};
