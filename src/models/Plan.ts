import { Schema, model } from 'mongoose';

const versionSchema = new Schema(
  {
    number: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: ['own', 'ai_import', 'dietitian'], required: true },
    note: { type: String, maxlength: 1000 },
    items: { type: Schema.Types.Mixed, default: [] },
    rules: { type: Schema.Types.Mixed, default: [] },
    recipes: { type: Schema.Types.Mixed, default: [] },
    /** added/changed/removed versus the previous version */
    diff: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const planSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, maxlength: 200 },
    dietitianId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    currentVersion: { type: Number, default: 1 },
    versions: { type: [versionSchema], default: [] },
  },
  { timestamps: true },
);
export const Plan = model('Plan', planSchema);
