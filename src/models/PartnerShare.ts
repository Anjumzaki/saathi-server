import { Schema, model } from 'mongoose';

const shareSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    inviteTokenHash: { type: String, unique: true, sparse: true },
    inviteExpiresAt: { type: Date },
    status: { type: String, enum: ['pending', 'active', 'paused', 'revoked'], default: 'pending' },
    /** When the invite was accepted, and when the free preview that started then runs out. Server time only. */
    acceptedAt: { type: Date, default: null },
    previewEndsAt: { type: Date, default: null },
    /** Set when the preview ran out with no package. The share and its cheers stay; paying clears this. */
    pausedAt: { type: Date, default: null },
    permissions: {
      type: new Schema(
        {
          effortRing: { type: Boolean, default: false },
          mealsLogged: { type: Boolean, default: false },
          waterWalk: { type: Boolean, default: false },
          weight: { type: Boolean, default: false },
          togetherNudgesOnly: { type: Boolean, default: false },
          together: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      required: true,
    },
    lastCheerAt: { type: Date, default: null },
  },
  { timestamps: true },
);
export const PartnerShare = model('PartnerShare', shareSchema);

/** Shares she accepted that still hold a live or spent preview; 'revoked' ones are left out. */
export const VIEWER_STATUSES = ['active', 'paused'] as const;

/**
 * The end of this viewer's free partner preview, or null when they have never accepted an invite.
 * GET /subscription reports it as `previewEndsAt` so the app can show the days left anywhere.
 * With more than one share the latest window wins: one package covers every person she is cheering on.
 */
export async function previewEndsAtForViewer(userId: string): Promise<Date | null> {
  return findPreviewEnd(userId, -1);
}

/** The window this viewer's FIRST acceptance opened, so a second invite cannot hand them three fresh days. */
export async function earliestPreviewEndsAtForViewer(userId: string): Promise<Date | null> {
  return findPreviewEnd(userId, 1);
}

async function findPreviewEnd(userId: string, order: 1 | -1): Promise<Date | null> {
  const share = await PartnerShare.findOne({ partnerId: userId, status: { $in: VIEWER_STATUSES }, previewEndsAt: { $ne: null } })
    .sort({ previewEndsAt: order })
    .select('previewEndsAt')
    .lean();
  return share?.previewEndsAt ?? null;
}

const cheerSchema = new Schema(
  {
    shareId: { type: Schema.Types.ObjectId, ref: 'PartnerShare', required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    emoji: { type: String, maxlength: 8, default: '👏' },
    seenAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const Cheer = model('Cheer', cheerSchema);
