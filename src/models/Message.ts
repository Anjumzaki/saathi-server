import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'photo', 'plan_update'], required: true },
    text: { type: String, maxlength: 4000 },
    photoRef: { type: String, maxlength: 500 },
    planUpdate: {
      type: new Schema({ planId: Schema.Types.ObjectId, version: Number, summary: Schema.Types.Mixed }, { _id: false }),
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageSchema.index({ orderId: 1, createdAt: 1 });
export const Message = model('Message', messageSchema);
