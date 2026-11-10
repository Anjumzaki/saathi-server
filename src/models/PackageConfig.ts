import { Schema, model } from 'mongoose';

const priceSchema = new Schema(
  { country: { type: String, required: true }, currency: { type: String, required: true }, amountMinor: { type: Number, required: true, min: 0 } },
  { _id: false },
);
const variantSchema = new Schema(
  { variant: { type: String, required: true }, productId: { type: String, required: true }, prices: { type: [priceSchema], default: [] } },
  { _id: false },
);

/**
 * kind "dietitian_plan": a price band; variants full | premium | followUp.
 * kind "premium": a Premium subscription package; variants monthly | yearly (+ trialDays).
 */
const packageSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['dietitian_plan', 'premium'], required: true },
    label: { type: String, required: true },
    bandId: { type: String },
    trialDays: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    variants: { type: [variantSchema], default: [] },
  },
  { timestamps: true },
);
export const PackageConfig = model('PackageConfig', packageSchema);

/** Single document (key "default"). */
const feeSchema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },
    playFeePercent: { type: Number, default: 15, min: 0, max: 100 },
    platformFeePercent: { type: Number, default: 20, min: 0, max: 100 },
    payoutDelayHours: { type: Number, default: 24, min: 0 },
    refundWindowHours: { type: Number, default: 72, min: 0 },
    premiumDiscountPercent: { type: Number, default: 30, min: 0, max: 100 },
    followUpDiscountPercent: { type: Number, default: 50, min: 0, max: 100 },
  },
  { timestamps: true },
);
export const FeeConfigModel = model('FeeConfig', feeSchema);
