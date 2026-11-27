import { Schema, model } from 'mongoose';
import { THREAD_KINDS } from './Message';

export const CALL_STATUSES = ['requested', 'confirmed', 'cancelled', 'completed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * How the call actually happens. No voice or video provider is wired in, so a booking is a time plus a
 * note about who rings whom; nothing here claims the call takes place inside the app.
 */
export const CALL_CHANNELS = ['they_call', 'she_calls'] as const;
export type CallChannel = (typeof CALL_CHANNELS)[number];

const callSchema = new Schema(
  {
    threadId: { type: Schema.Types.ObjectId, ref: 'Thread', default: null, index: true },
    kind: { type: String, enum: THREAD_KINDS, default: 'order' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The other side: the dietitian she bought from, or the Saathi dietitian on her thread. */
    dietitianId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The offered slot she booked, so it can go back on offer if the call is moved or called off. */
    slotId: { type: String, default: null },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    status: { type: String, enum: CALL_STATUSES, default: 'requested' },
    channel: { type: String, enum: CALL_CHANNELS, default: 'they_call' },
    /** What she is shown about joining: a number she already shares, or that she will be rung. */
    channelNote: { type: String, maxlength: 300, default: '' },
    /** Who called it off, so the screen can say so plainly instead of just "cancelled". */
    cancelledBy: { type: String, enum: ['client', 'other'], default: null },
    cancelReason: { type: String, maxlength: 300, default: '' },
    /** Set when this booking replaced an earlier time, so she can see it moved. */
    rescheduledFrom: { type: Date, default: null },
    /** Older bookings on the marketplace carried a meeting link; kept so those still render. */
    joinLink: { type: String },
    phone: { type: String },
  },
  { timestamps: true },
);
export const CallBooking = model('CallBooking', callSchema);
