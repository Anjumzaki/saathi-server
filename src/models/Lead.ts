import { Schema, model } from 'mongoose';

/** A website form: someone who asked to hear about the launch, or a dietitian who applied for Saathi Pro. */
export const LEAD_KINDS = ['waitlist', 'pro_application'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

const leadSchema = new Schema(
  {
    kind: { type: String, enum: LEAD_KINDS, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: null },
    platform: { type: String, default: null },
    note: { type: String, default: null },
    registration: { type: String, default: null },
    source: { type: String, default: null },
  },
  { timestamps: true },
);
// Sending the form twice updates the same record.
leadSchema.index({ kind: 1, email: 1 }, { unique: true });
export const Lead = model('Lead', leadSchema);
