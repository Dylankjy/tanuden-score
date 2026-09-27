/* eslint-disable no-process-env */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
dotenv.config();

export const DEBUG_MODE = process.env.NODE_ENV === 'development' ? true : false;

export const WEBSERVER = {
  SERVICE_URL: process.env.WEBSERVER_SERVICE_URL || 'localhost',
  PORT: process.env.WEBSERVER_PORT || 5005,

  JWT_PUBLIC_KEY: readFileSync(process.env.WEBSERVER_JWT_PUBLIC_KEY_PATH!),
  JWT_ISSUER: 'tanuden-gateway',
  JWT_AUDIENCE: 'tanuden-services',

  // Shared gateway/upstream secret — sent as x-internal-secret when polling
  // auth's internal deletion-event feed.
  INTERNAL_SECRET: process.env.INTERNAL_SECRET || ''
};

// tanuden-auth base URL (direct, not via the gateway) for internal RPC —
// currently the deletion-event sync feed polled by src/jobs/deletion-sync.job.
export const AUTH = {
  SERVICE_URL: process.env.AUTH_SERVICE_URL || ''
};

export const DB = {
  DATABASE_CONNECTION_STRING:
    process.env.DB_CONNECTION_STRING ||
    'mongodb://localhost:27017/tanuden-score',
  // Only read by scripts/migrate-from-myuntendai.ts — the source database for
  // the one-time historical-data migration.
  LEGACY_CONNECTION_STRING:
    process.env.LEGACY_DB_CONNECTION_STRING ||
    'mongodb://localhost:27017/tanuden-myuntendai'
};

export const API = {
  SERVICE_NAME: process.env.API_SERVICE_NAME || 'Tanuden Score',
  OWNER: 'Haruyuki Tanukiji <Twitter @haruyukitanuki>',
  ENVIRONMENT: DEBUG_MODE ? 'development' : 'production'
};
