import { Schema, model } from 'mongoose';

export const ROLES = ['client', 'dietitian', 'partner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const subscriptionSchema = new Schema(
  {
    status: { type: String, enum: ['none', 'trialing', 'active', 'expired', 'canceled'], default: 'none' },
    // Null on records written before Premium Plus existed; those count as "premium".
    tier: { type: String, enum: ['premium', 'plus'], default: null },
    plan: { type: String, enum: ['monthly', 'yearly'], default: null },
    trialEndsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    source: { type: String, enum: ['google_play', 'app_store'], default: null },
    productId: { type: String, default: null },
    purchaseToken: { type: String, default: null },
    playOrderId: { type: String, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    displayName: { type: String, trim: true, maxlength: 100 },
    country: { type: String, uppercase: true, minlength: 2, maxlength: 2 },
    timezone: { type: String, maxlength: 64 },
    roles: { type: [String], enum: ROLES, default: ['client'] },
    // Sign-in password (scrypt hash). Never serialised; accounts created before passwords existed have none.
    passwordHash: { type: String, select: false },
    failedLogins: { type: Number, default: 0 },
    loginLockedUntil: { type: Date, default: null },
    googleSub: { type: String, unique: true, sparse: true },
    appleSub: { type: String, unique: true, sparse: true },
    phone: { type: String },
    phoneVerified: { type: Boolean, default: false },
    // Set the moment control of the mailbox is proven: an emailed code is entered, a password is
    // reset with one, or Google/Apple assert the address is verified. Null = sign-in is refused.
    emailVerifiedAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null },
    subscription: { type: subscriptionSchema, default: () => ({ status: 'none' }) },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// A Play purchase token can entitle only one account.
userSchema.index({ 'subscription.purchaseToken': 1 }, { unique: true, partialFilterExpression: { 'subscription.purchaseToken': { $type: 'string' } } });

export const User = model('User', userSchema);
