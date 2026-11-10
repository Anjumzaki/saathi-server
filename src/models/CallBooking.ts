import { Schema, model } from 'mongoose';

const callSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dietitianId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    status: { type: String, enum: ['requested', 'confirmed', 'cancelled', 'completed'], default: 'requested' },
    /** Provided by the dietitian: either a meeting link or a phone number. */
    joinLink: { type: String },
    phone: { type: String },
  },
  { timestamps: true },
);
export const CallBooking = model('CallBooking', callSchema);
