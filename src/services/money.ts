/**
 * Money helpers. All amounts are INTEGER MINOR UNITS (e.g. cents/paisa/fils).
 * Percentages are converted to basis points (1% = 100 bps) and rounded half-up with integer maths.
 */
export interface SettlementFees {
  playFeePercent: number;
  platformFeePercent: number;
}

export interface Settlement {
  pricePaid: number;
  playFee: number;
  net: number;
  platform: number;
  dietitian: number;
}

const toBps = (pct: number): number => Math.round(pct * 100);

function assertPercent(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new RangeError(`${name} must be between 0 and 100`);
}

/** round-half-up(amount * bps / 10000) using exact integer arithmetic. */
function applyBps(amount: number, bps: number): number {
  return Math.floor((amount * bps + 5000) / 10000);
}

/**
 * net = pricePaid - round(pricePaid*playFee); platform = round(net*platformFee); dietitian = net - platform.
 * playFee + platform + dietitian === pricePaid always holds (dietitian is the remainder).
 */
export function computeSettlement(pricePaid: number, fees: SettlementFees): Settlement {
  if (!Number.isSafeInteger(pricePaid) || pricePaid < 0) {
    throw new RangeError('pricePaid must be a non-negative integer (minor units)');
  }
  if (pricePaid > 100_000_000_000) throw new RangeError('pricePaid is unreasonably large');
  assertPercent('playFeePercent', fees.playFeePercent);
  assertPercent('platformFeePercent', fees.platformFeePercent);
  const playFee = applyBps(pricePaid, toBps(fees.playFeePercent));
  const net = pricePaid - playFee;
  const platform = applyBps(net, toBps(fees.platformFeePercent));
  const dietitian = net - platform;
  return { pricePaid, playFee, net, platform, dietitian };
}

/** Price after a percentage discount, rounded half-up to minor units. */
export function applyDiscount(amountMinor: number, discountPercent: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError('amountMinor must be a non-negative integer');
  assertPercent('discountPercent', discountPercent);
  return applyBps(amountMinor, 10000 - toBps(discountPercent));
}
