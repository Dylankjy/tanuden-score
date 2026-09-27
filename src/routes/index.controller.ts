import { Router, type Request, type Response } from 'express';
import { API } from '../constants';
import { httpErrors } from '../utils/http-errors';

const router = Router();

router.get('/', (_: Request, res: Response) => {
  res.json({
    service_name: API.SERVICE_NAME,
    owner: API.OWNER,
    environment: API.ENVIRONMENT,
    timestamp: new Date().toISOString()
  });
});

router.all('/{*all}', (_: Request, res: Response) => {
  res.status(404).json(httpErrors.notFound);
});

export { router as indexController };
