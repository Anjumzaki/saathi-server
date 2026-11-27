/** Pure order state machine for dietitian orders. */
import { HOUR } from '../utils/time';

export const ORDER_STATUSES = ['requested', 'paid', 'in_progress', 'delivered', 'released', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  requested: ['paid'],
  paid: ['in_progress', 'delivered', 'refunded'],
  in_progress: ['delivered', 'refunded'],
  delivered: ['released', 'refunded'], // refund after delivery only via admin (dispute)
  released: [],
  refunded: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => TRANSITIONS[from].includes(to);

export interface OrderTimes {
  status: OrderStatus;
  paidAt?: Date | null;
  deliveredAt?: Date | null;
}

/** Refund is automatically eligible when nothing has been delivered within the refund window after payment. */
export function isRefundEligible(o: OrderTimes, now: Date, refundWindowHours: number): boolean {
  if (o.status !== 'paid' && o.status !== 'in_progress') return false;
  if (o.deliveredAt || !o.paidAt) return false;
  return now.getTime() - o.paidAt.getTime() >= refundWindowHours * HOUR;
}

/**
 * When the automatic refund opens: `refundWindowHours` after payment, while nothing has been delivered.
 * null when there is nothing to wait for (never paid, already delivered, or a finished order). The app shows
 * the time left from this, so it never has to know the fee config.
 */
export function refundOpensAt(o: OrderTimes, refundWindowHours: number): Date | null {
  if (!o.paidAt || o.deliveredAt) return null;
  if (o.status !== 'paid' && o.status !== 'in_progress') return null;
  return new Date(o.paidAt.getTime() + refundWindowHours * HOUR);
}

/** Release: the client can release a delivered order any time; otherwise it auto-releases after the payout delay. */
export function canRelease(o: OrderTimes, now: Date, payoutDelayHours: number, byClient: boolean): boolean {
  if (o.status !== 'delivered' || !o.deliveredAt) return false;
  return byClient || now.getTime() - o.deliveredAt.getTime() >= payoutDelayHours * HOUR;
}
