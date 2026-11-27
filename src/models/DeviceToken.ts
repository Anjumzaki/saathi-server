import { Schema, model } from 'mongoose';

export const PUSH_PLATFORMS = ['android', 'ios'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * One row per phone, not per woman: she may have an old phone and a new one, and both should buzz until
 * she signs out of the old one. The token is the key, so a phone that is handed on or signed in to a
 * different account moves to that account rather than quietly buzzing for the previous owner.
 *
 * Nothing identifying the device is kept beyond the token itself and the app version, which only exists
 * so a payload shape can be retired safely.
 */
const deviceTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true, maxlength: 4096 },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    appVersion: { type: String, default: '', maxlength: 32 },
    /** Touched on every register; a token no phone has refreshed in months can be swept up later. */
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
deviceTokenSchema.index({ userId: 1, lastSeenAt: -1 });
export const DeviceToken = model('DeviceToken', deviceTokenSchema);
