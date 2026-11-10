import { Schema, model } from 'mongoose';
import { ORDER_STATUSES } from '../services/orderState';

const orderSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dietitianId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packageKey: { type: String, required: true },
    bandId: { type: String, required: true },
    variant: { type: String, enum: ['full', 'premium', 'followUp'], required: true },
    productId: { type: String, required: true },
    country: { type: String, required: true },
    currency: { type: String, required: true },
    pricePaid: { type: Number, required: true }, // minor units
    status: { type: String, enum: ORDER_STATUSES, default: 'requested', index: true },
    settlement: {
      type: new Schema(
        {
          playFee: Number,
          net: Number,
          platform: Number,
          dietitian: Number,
          playFeePercent: Number,
          platformFeePercent: Number,
        },
        { _id: false },
      ),
      default: null,
    },
    purchaseToken: { type: String },
    playOrderId: { type: String },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', default: null },
    paidAt: Date,
    startedAt: Date,
    deliveredAt: Date,
    releasedAt: Date,
    refundedAt: Date,
    refundReason: String,
  },
  { timestamps: true },
);
orderSchema.index({ purchaseToken: 1 }, { unique: true, partialFilterExpression: { purchaseToken: { $type: 'string' } } });
export const Order = model('Order', orderSchema);
