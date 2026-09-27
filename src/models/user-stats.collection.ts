import { model, Schema } from 'mongoose';
import { UserStats } from '../types/stats';

const UserStatsSchema = new Schema<UserStats>(
  {
    user: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true
    },
    ranking: { type: Number, required: false, default: null },
    accuracy: { type: Number, required: true, default: 0 },
    timeliness: { type: Number, required: true, default: 0 },
    stopAccuracy: { type: Number, required: true, default: 0 },
    ecoDriving: { type: Number, required: true, default: 0 },
    score: { type: Number, required: true, default: 0 },
    totalDistance: { type: Number, required: true, default: 0 },
    totalRecords: { type: Number, required: true, default: 0 },
    type: {
      type: String,
      enum: ['monthly', 'weekly', 'all']
    }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
    versionKey: false
  }
);

export { UserStatsSchema };

export default model('user_stats', UserStatsSchema);
