import { Schema, model } from 'mongoose';

/** One counter per limiter key and time window. Removed by MongoDB shortly after the window ends. */
const rateHitSchema = new Schema({
  key: { type: String, required: true, unique: true },
  hits: { type: Number, default: 0 },
  resetAt: { type: Date, required: true },
});
rateHitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 60 });
export const RateHit = model('RateHit', rateHitSchema);
