import { Types } from 'mongoose';

export interface UserStats {
  _id: string;
  user: Types.ObjectId;
  ranking: number | null;
  accuracy: number;
  timeliness: number;
  stopAccuracy: number;
  ecoDriving: number;
  score: number;
  totalDistance: number;
  totalRecords: number;
  type: 'monthly' | 'weekly' | 'all';
}
