import { Schema, model } from 'mongoose';

const shareSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    inviteTokenHash: { type: String, unique: true, sparse: true },
    inviteExpiresAt: { type: Date },
    status: { type: String, enum: ['pending', 'active', 'revoked'], default: 'pending' },
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
