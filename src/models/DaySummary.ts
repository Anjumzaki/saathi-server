import { Schema, model } from 'mongoose';

/**
 * What the phone computed for one of her days (effort score, counts), kept only so someone she shares with can be shown
 * the parts she ticked. One per user per local date. Holds no cycle dates, no symptoms and no food names.
 */
const daySummarySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // her local YYYY-MM-DD
    summary: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
daySummarySchema.index({ userId: 1, date: 1 }, { unique: true });
export const DaySummary = model('DaySummary', daySummarySchema);
