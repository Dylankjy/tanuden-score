import { NextFunction, Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { httpErrors, throwHttpError } from '../utils/http-errors';

export const validateId =
  (params: string[]) => (req: Request, res: Response, next: NextFunction) => {
    for (const param of params) {
      if (!req.params[param] || !isValidObjectId(req.params[param])) {
        throwHttpError(httpErrors.notFound, null, res);
        return;
      }
    }
    next();
  };
