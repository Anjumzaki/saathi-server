import { Schema, model } from 'mongoose';
import { DOC_KINDS, VERIFICATION_STATUSES } from '../services/verification';

const docSchema = new Schema(
  {
    kind: { type: String, enum: DOC_KINDS, required: true },
    /** Reference: a FileStore key, or an object-storage key written by another uploader. */
    ref: { type: String, required: true, maxlength: 500 },
    /** Set when this service stored the bytes itself, so a download can answer with the right type. */
    mime: { type: String, maxlength: 100, default: null },
    bytes: { type: Number, default: null },
    /** Which FileStore driver holds it ('local', 's3'), so a migration can tell them apart. */
    storedBy: { type: String, maxlength: 40, default: null },
    flaggedForDeletion: { type: Boolean, default: false },
    deleteAfter: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const schemaDef = new Schema(
  {
    /**
     * The link to the account, held on this side. A dietitian is just a user with an approved profile:
     * the `dietitian` role is added to the user record when the reviewer approves (routes/admin.ts),
     * and this document is the record of why.
     */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    displayName: { type: String, required: true, maxlength: 100 },
    bio: { type: String, maxlength: 2000 },
    credentials: { type: String, maxlength: 500 },
    specialties: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    yearsOfPractice: { type: Number, min: 0, max: 60, default: null },
    countries: { type: [String], default: [] },
    /** The cities she actually serves, inside those countries. */
    cities: { type: [String], default: [] },
    /** PackageConfig bandIds she works in. The prices themselves stay with the band. */
    bandIds: { type: [String], default: [] },
    photoRef: { type: String },
    payoutAccountRef: { type: String },
    status: { type: String, enum: VERIFICATION_STATUSES, default: 'draft', index: true },
    reviewNote: { type: String, maxlength: 1000 },
    /**
     * Why a rejection happened: 'changes_requested' is "answer this and send it again", 'declined' is a
     * final no. Null on records the reviewer has not set it on, where the note decides which is shown.
     */
    reviewOutcome: { type: String, enum: ['changes_requested', 'declined'], default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    documents: { type: [docSchema], default: [] },
  },
  { timestamps: true },
);
export const DietitianProfile = model('DietitianProfile', schemaDef);
