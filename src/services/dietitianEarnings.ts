/**
 * What she has earned. Pure arithmetic over order rows, in integer minor units.
 *
 * There is no payout method yet: nothing has ever left Saathi. So "cleared" means a client's money is
 * no longer on hold, not that it is on its way, and `paidOutMinor` is 0 by construction rather than
 * by accident. Anything that pays her out must set `payoutsLive` and start filling it.
 */
import { computeSettlement, type SettlementFees } from './money';
import type { OrderStatus } from './orderState';

export interface SettlementSnapshot {
  playFee?: number | null;
  platform?: number | null;
  dietitian?: number | null;
}

export interface EarningRow {
  status: OrderStatus;
  currency: string;
  pricePaid: number;
  /** Snapshotted when the client paid. Missing on old orders, where it is recomputed from the fees. */
  settlement?: SettlementSnapshot | null;
}

export interface CurrencyEarnings {
  currency: string;
  orders: number;
  /** Her share of every plan she has delivered: held + cleared. */
  earnedMinor: number;
  /** Delivered, still inside the hold window. Not hers to count on yet. */
  heldMinor: number;
  /** Off hold. Waiting for a way to pay her. */
  clearedMinor: number;
  /** Money actually sent to her. Zero until payouts exist. */
  paidOutMinor: number;
  /** The store's cut plus Saathi's, on the same orders. */
  feeMinor: number;
}

export interface EarningsSummary {
  /** False while there is no payout method. The app must say so rather than imply money is coming. */
  payoutsLive: boolean;
  currencies: CurrencyEarnings[];
}

/** Only delivered work counts. Nothing is owed for an order still in progress or refunded. */
export const EARNING_STATUSES: OrderStatus[] = ['delivered', 'released'];

const shareOf = (row: EarningRow, fees: SettlementFees): { dietitian: number; fee: number } => {
  const s = row.settlement;
  if (s && typeof s.dietitian === 'number') {
    return { dietitian: s.dietitian, fee: (s.playFee ?? 0) + (s.platform ?? 0) };
  }
  const c = computeSettlement(row.pricePaid, fees);
  return { dietitian: c.dietitian, fee: c.playFee + c.platform };
};

export function summariseEarnings(rows: EarningRow[], fees: SettlementFees): EarningsSummary {
  const byCurrency = new Map<string, CurrencyEarnings>();
  for (const row of rows) {
    if (!EARNING_STATUSES.includes(row.status)) continue;
    const currency = row.currency.toUpperCase();
    const c = byCurrency.get(currency) ?? { currency, orders: 0, earnedMinor: 0, heldMinor: 0, clearedMinor: 0, paidOutMinor: 0, feeMinor: 0 };
    const { dietitian, fee } = shareOf(row, fees);
    c.orders += 1;
    c.earnedMinor += dietitian;
    c.feeMinor += fee;
    if (row.status === 'released') c.clearedMinor += dietitian;
    else c.heldMinor += dietitian;
    byCurrency.set(currency, c);
  }
  return { payoutsLive: false, currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}

/** The line the app shows where a payout button would otherwise be. */
export const PAYOUT_NOTE = 'Saathi cannot pay you yet. There is no payout method set up, so nothing has been sent and nothing is on its way. Your earnings are recorded here and will be paid once payouts are live.';
