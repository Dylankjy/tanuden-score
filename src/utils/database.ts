import mongoose from 'mongoose';
import { DB } from '../constants';

const options: mongoose.ConnectOptions = {};

// Explicitly awaitable connect, for callers that need to guarantee a real
// connection before issuing queries rather than relying on Mongoose's
// implicit command-buffering timing — worker_threads in particular run in an
// isolated module registry and never see the side-effecting Database
// singleton below, so they must establish their own connection via this.
export const connectDatabase = (): Promise<typeof mongoose> =>
  mongoose.connect(`${DB.DATABASE_CONNECTION_STRING}`, options);

class Database {
  constructor() {
    this._connect();
  }

  async _connect() {
    try {
      await mongoose.connect(`${DB.DATABASE_CONNECTION_STRING}`, options);
      console.info(`Database connection successful`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Database connection error: ${message}`);
    }
  }
}

export default new Database();
