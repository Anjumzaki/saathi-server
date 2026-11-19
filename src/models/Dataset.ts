import { Schema, model } from 'mongoose';

const optionSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    icon: String,
    tags: { type: [String], default: [] },
    regions: { type: [String], default: [] },
    source: { type: String, enum: ['seed', 'user', 'dietitian', 'promoted'], default: 'seed' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const datasetSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    question: { type: String, required: true },
    selection: { type: String, enum: ['single', 'multi'], required: true },
    allowCustom: { type: Boolean, default: false },
    minPick: { type: Number, default: 0 },
    showIf: { type: Schema.Types.Mixed, default: null },
    order: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
    options: { type: [optionSchema], default: [] },
  },
  { timestamps: true },
);
export const Dataset = model('Dataset', datasetSchema);

/** A user's own "+ Add your own" option. Private to that user until an admin promotes it. */
const userOptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    datasetKey: { type: String, required: true },
    optionId: { type: String, required: true },
    label: { type: String, required: true },
    labelKey: { type: String, required: true },
    country: String,
  },
  { timestamps: true },
);
userOptionSchema.index({ userId: 1, datasetKey: 1, labelKey: 1 }, { unique: true });
userOptionSchema.index({ datasetKey: 1, labelKey: 1 });
export const UserOption = model('UserOption', userOptionSchema);
