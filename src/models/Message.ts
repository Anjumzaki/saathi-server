import { Schema, model } from 'mongoose';

/** Two products, one chat: a marketplace order she bought, or Saathi's own dietitians (Premium Plus). */
export const THREAD_KINDS = ['order', 'representative'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** A time the other side offers. She books one of these rather than proposing a time of her own. */
const offeredSlotSchema = new Schema(
  {
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    offeredBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    taken: { type: Boolean, default: false },
  },
  { _id: true },
);

/**
 * A thread and its messages are one module, so they share this file.
 *
 * For a Premium Plus thread the staff link lives here (`assignedStaffId` with `queuedAt`) rather than on
 * the user record: the waiting queue is then read and written in one place, and nothing about a woman's
 * account changes when a dietitian picks her thread up.
 */
const threadSchema = new Schema(
  {
    kind: { type: String, enum: THREAD_KINDS, required: true },
    /** Always her: a thread has exactly two sides and she is one of them. */
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Order threads only. */
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    /** Order threads: the dietitian she bought the plan from. */
    dietitianId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Representative threads: the Saathi dietitian who picked the thread up. Null while it waits. */
    assignedStaffId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    queuedAt: { type: Date, default: null },
    assignedAt: { type: Date, default: null },
    /** Read marks per side, so unread counts never need a per-message read record. */
    clientReadAt: { type: Date, default: null },
    otherReadAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    offeredSlots: { type: [offeredSlotSchema], default: [] },
  },
  { timestamps: true },
);
// One thread per order, and the queue is read oldest-first.
threadSchema.index({ orderId: 1 }, { unique: true, partialFilterExpression: { orderId: { $type: 'objectId' } } });
threadSchema.index({ clientId: 1, kind: 1 });
threadSchema.index({ kind: 1, assignedStaffId: 1, queuedAt: 1 });
export const Thread = model('Thread', threadSchema);

const messageSchema = new Schema(
  {
    threadId: { type: Schema.Types.ObjectId, ref: 'Thread', default: null },
    /** Kept so the plan-update card an order writes is still found before that order has a thread. */
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
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
messageSchema.index({ threadId: 1, createdAt: 1 });
export const Message = model('Message', messageSchema);
