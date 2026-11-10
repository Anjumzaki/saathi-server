import { Schema, model } from 'mongoose';
import { SYNC_COLLECTIONS } from '../services/syncLogic';

const syncSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  /** API name is "collection"; stored as `coll` because `collection` is reserved by Mongoose. */
  coll: { type: String, enum: SYNC_COLLECTIONS, required: true },
  clientId: { type: String, required: true, maxlength: 64 },
  /** Client-supplied last-modified time; drives last-write-wins. */
  updatedAt: { type: Date, required: true },
  /** Server receipt time; drives the pull cursor so late/offline pushes are still delivered. */
  serverUpdatedAt: { type: Date, required: true },
  deleted: { type: Boolean, default: false },
  payload: { type: Schema.Types.Mixed, default: {} },
});
syncSchema.index({ userId: 1, coll: 1, clientId: 1 }, { unique: true });
syncSchema.index({ userId: 1, serverUpdatedAt: 1 });
export const SyncRecord = model('SyncRecord', syncSchema);
