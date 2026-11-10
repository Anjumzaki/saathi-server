import { Schema, model } from 'mongoose';
import { DOC_KINDS, VERIFICATION_STATUSES } from '../services/verification';

const docSchema = new Schema(
  {
    kind: { type: String, enum: DOC_KINDS, required: true },
    /** Reference (e.g. object-storage key). The file itself never lives in this service. */
    ref: { type: String, required: true, maxlength: 500 },
    flaggedForDeletion: { type: Boolean, default: false },
    deleteAfter: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const schemaDef = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    displayName: { type: String, required: true, maxlength: 100 },
    bio: { type: String, maxlength: 2000 },
    credentials: { type: String, maxlength: 500 },
    specialties: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    countries: { type: [String], default: [] },
    photoRef: { type: String },
    payoutAccountRef: { type: String },
    status: { type: String, enum: VERIFICATION_STATUSES, default: 'draft', index: true },
    reviewNote: { type: String, maxlength: 1000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    documents: { type: [docSchema], default: [] },
  },
  { timestamps: true },
);
export const DietitianProfile = model('DietitianProfile', schemaDef);
