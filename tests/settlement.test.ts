import { describe, expect, it } from 'vitest';
import { applyDiscount, computeSettlement } from '../src/services/money';

const fees = { playFeePercent: 15, platformFeePercent: 20 };

describe('computeSettlement', () => {
  it('applies the documented formula on a round number', () => {
    // 10000 -> play 1500, net 8500, platform 1700, dietitian 6800
    expect(computeSettlement(10000, fees)).toEqual({ pricePaid: 10000, playFee: 1500, net: 8500, platform: 1700, dietitian: 6800 });
  });
  it('returns zeros for a zero price', () => {
    expect(computeSettlement(0, fees)).toEqual({ pricePaid: 0, playFee: 0, net: 0, platform: 0, dietitian: 0 });
  });
  it('rounds half up to minor units', () => {
    // 10 * 15% = 1.5 -> 2 ; net 8 ; 8 * 20% = 1.6 -> 2 ; dietitian 6
    expect(computeSettlement(10, fees)).toEqual({ pricePaid: 10, playFee: 2, net: 8, platform: 2, dietitian: 6 });
    // 1 * 15% = 0.15 -> 0
    expect(computeSettlement(1, fees)).toMatchObject({ playFee: 0, net: 1, platform: 0, dietitian: 1 });
    // 3 * 15% = 0.45 -> 0 ; net 3 ; 3 * 20% = 0.6 -> 1 ; dietitian 2
    expect(computeSettlement(3, fees)).toMatchObject({ playFee: 0, platform: 1, dietitian: 2 });
  });
  it('handles 0% and 100% fees', () => {
    expect(computeSettlement(999, { playFeePercent: 0, platformFeePercent: 0 })).toMatchObject({ playFee: 0, platform: 0, dietitian: 999 });
    expect(computeSettlement(999, { playFeePercent: 100, platformFeePercent: 20 })).toMatchObject({ playFee: 999, net: 0, platform: 0, dietitian: 0 });
    expect(computeSettlement(999, { playFeePercent: 0, platformFeePercent: 100 })).toMatchObject({ platform: 999, dietitian: 0 });
  });
  it('supports fractional percentages', () => {
    const s = computeSettlement(10000, { playFeePercent: 15.5, platformFeePercent: 12.25 });
    expect(s.playFee).toBe(1550);
    expect(s.platform).toBe(Math.round(8450 * 0.1225));
    expect(s.playFee + s.platform + s.dietitian).toBe(10000);
  });
  it('reconciles exactly and never goes negative across many prices and fee combos', () => {
    const percents = [0, 0.5, 5, 10, 15, 20, 29.99, 30, 50, 99.99, 100];
    for (let price = 0; price <= 3000; price += 13) {
      for (const pf of percents) {
        for (const pl of percents) {
          const s = computeSettlement(price, { playFeePercent: pf, platformFeePercent: pl });
          expect(s.playFee + s.platform + s.dietitian).toBe(price);
          expect(s.net).toBe(price - s.playFee);
          for (const v of [s.playFee, s.net, s.platform, s.dietitian]) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
          }
          expect(s.platform).toBeLessThanOrEqual(s.net);
        }
      }
    }
  });
  it('reconciles for large realistic prices', () => {
    for (const price of [99_999_99, 1_234_567_89, 100_000_000_000]) {
      const s = computeSettlement(price, fees);
      expect(s.playFee + s.platform + s.dietitian).toBe(price);
    }
  });
  it('discounted variants never produce a negative payout', () => {
    for (const base of [9900, 25000, 300000]) {
      for (const pct of [30, 50]) {
        const s = computeSettlement(applyDiscount(base, pct), fees);
        expect(s.dietitian).toBeGreaterThan(0);
        expect(s.playFee + s.platform + s.dietitian).toBe(applyDiscount(base, pct));
      }
    }
  });
  it('rejects invalid input', () => {
    expect(() => computeSettlement(-1, fees)).toThrow(RangeError);
    expect(() => computeSettlement(10.5, fees)).toThrow(RangeError);
    expect(() => computeSettlement(NaN, fees)).toThrow(RangeError);
    expect(() => computeSettlement(1e15, fees)).toThrow(RangeError);
    expect(() => computeSettlement(100, { playFeePercent: -1, platformFeePercent: 20 })).toThrow(RangeError);
    expect(() => computeSettlement(100, { playFeePercent: 15, platformFeePercent: 101 })).toThrow(RangeError);
    expect(() => computeSettlement(100, { playFeePercent: NaN, platformFeePercent: 20 })).toThrow(RangeError);
  });
});

describe('applyDiscount', () => {
  it('computes -30% and -50% with rounding', () => {
    expect(applyDiscount(10000, 30)).toBe(7000);
    expect(applyDiscount(10000, 50)).toBe(5000);
    expect(applyDiscount(999, 30)).toBe(699); // 699.3
    expect(applyDiscount(1, 50)).toBe(1); // 0.5 rounds up
    expect(applyDiscount(500, 0)).toBe(500);
    expect(applyDiscount(500, 100)).toBe(0);
  });
  it('rejects bad input', () => {
    expect(() => applyDiscount(-5, 10)).toThrow(RangeError);
    expect(() => applyDiscount(5, 120)).toThrow(RangeError);
  });
});
