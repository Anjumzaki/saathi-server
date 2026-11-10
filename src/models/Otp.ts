import { Schema, model } from 'mongoose';

/** One live code per key ("email:<addr>" or "phone:<userId>:<e164>"). Only the peppered hash is stored. */
const otpSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastSentAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true },
);
otpSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const Otp = model('Otp', otpSchema);
