import { Schema, model } from 'mongoose';

export const STORE_EVENT_OUTCOMES = ['applied', 'ignored', 'no_account', 'refused', 'failed'] as const;
export type StoreEventOutcome = (typeof STORE_EVENT_OUTCOMES)[number];

/**
 * Every store notification we accept, written down.
 *
 * It does two jobs. It is the audit trail for the one part of Saathi where being wrong costs money: when
 * she says she was charged after cancelling, or a renewal did not open Premium, this is the record of what
 * Google or Apple actually told us and what we did about it.
 *
 * It is also the thing that makes a replay harmless. Both stores retry until they get a 2xx, so the same
 * notification arrives again and again; the unique index on (provider, eventId) means the second arrival
 * loses the race to insert and nothing else happens. The row is therefore written BEFORE the change is
 * applied, not after.
 */
const storeEventSchema = new Schema(
  {
    provider: { type: String, enum: ['google_play', 'app_store'], required: true },
    /** The store's own id: Pub/Sub's messageId, or Apple's notificationUUID. */
    eventId: { type: String, required: true, maxlength: 200 },
    notificationType: { type: String, required: true, maxlength: 100 },
    subtype: { type: String, default: null, maxlength: 100 },
    /** How the account was found. Kept because a notification can arrive for a purchase we never stored. */
    purchaseToken: { type: String, default: null, maxlength: 4096 },
    originalTransactionId: { type: String, default: null, maxlength: 200 },
    productId: { type: String, default: null, maxlength: 200 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: { type: String, enum: ['refresh', 'revoke', 'none'], required: true },
    notice: { type: String, enum: ['renewed', 'payment_problem', 'trial_ending', 'refunded'], default: null },
    environment: { type: String, enum: ['production', 'sandbox'], default: null },
    outcome: { type: String, enum: STORE_EVENT_OUTCOMES, default: null },
    /** The status we ended up storing, so the trail reads without joining anything. */
    statusAfter: { type: String, default: null, maxlength: 40 },
    /** One short line when something went wrong. Never a token, never anything of hers. */
    note: { type: String, default: null, maxlength: 300 },
    occurredAt: { type: Date, default: null },
    handledAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// The idempotency guard. A retried notification fails to insert here, and that is the whole mechanism.
storeEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
storeEventSchema.index({ purchaseToken: 1 });
storeEventSchema.index({ createdAt: -1 });

export const StoreEvent = model('StoreEvent', storeEventSchema);

/** Mongo's duplicate-key error, which here means "this notification has already been handled". */
export const isDuplicateKey = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: number }).code === 11000;
