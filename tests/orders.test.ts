import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, canRelease, canTransition, isRefundEligible } from '../src/services/orderState';
import { chooseVariant, findPrice } from '../src/services/pricing';

const t0 = new Date('2026-01-01T00:00:00Z');
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);

describe('order transitions', () => {
  it('allows the happy path', () => {
    for (const [a, b] of [['requested', 'paid'], ['paid', 'in_progress'], ['in_progress', 'delivered'], ['delivered', 'released'], ['paid', 'refunded'], ['in_progress', 'refunded']] as const) {
      expect(canTransition(a, b)).toBe(true);
    }
  });
  it('blocks skipping and leaving terminal states', () => {
    expect(canTransition('requested', 'delivered')).toBe(false);
    expect(canTransition('requested', 'refunded')).toBe(false);
    for (const to of ORDER_STATUSES) {
      expect(canTransition('released', to)).toBe(false);
      expect(canTransition('refunded', to)).toBe(false);
    }
  });
});

describe('refund eligibility (72 h, nothing delivered)', () => {
  it('is false before the window and true at/after it', () => {
    expect(isRefundEligible({ status: 'paid', paidAt: t0 }, h(71.9), 72)).toBe(false);
    expect(isRefundEligible({ status: 'paid', paidAt: t0 }, h(72), 72)).toBe(true);
    expect(isRefundEligible({ status: 'in_progress', paidAt: t0 }, h(100), 72)).toBe(true);
  });
  it('is false once anything was delivered or for other statuses', () => {
    expect(isRefundEligible({ status: 'in_progress', paidAt: t0, deliveredAt: h(10) }, h(100), 72)).toBe(false);
    expect(isRefundEligible({ status: 'delivered', paidAt: t0, deliveredAt: h(10) }, h(100), 72)).toBe(false);
    expect(isRefundEligible({ status: 'requested' }, h(100), 72)).toBe(false);
    expect(isRefundEligible({ status: 'released', paidAt: t0 }, h(100), 72)).toBe(false);
  });
  it('follows the configured window', () => {
    expect(isRefundEligible({ status: 'paid', paidAt: t0 }, h(25), 24)).toBe(true);
  });
});

describe('release', () => {
  it('client can release a delivered order immediately', () => {
    expect(canRelease({ status: 'delivered', deliveredAt: t0 }, h(0), 24, true)).toBe(true);
  });
  it('auto-release waits for the payout delay', () => {
    expect(canRelease({ status: 'delivered', deliveredAt: t0 }, h(23), 24, false)).toBe(false);
    expect(canRelease({ status: 'delivered', deliveredAt: t0 }, h(24), 24, false)).toBe(true);
  });
  it('requires delivered status', () => {
    expect(canRelease({ status: 'paid', deliveredAt: t0 }, h(99), 24, true)).toBe(false);
  });
});

describe('pricing', () => {
  it('chooses variants (follow-up beats premium beats full)', () => {
    expect(chooseVariant({ isPremium: false, hasPriorOrderWithDietitian: false })).toBe('full');
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: false })).toBe('premium');
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: true })).toBe('followUp');
    expect(chooseVariant({ isPremium: false, hasPriorOrderWithDietitian: true })).toBe('followUp');
  });
  it('finds a country price with wildcard fallback', () => {
    const v = { variant: 'full', productId: 'p', prices: [{ country: 'PK', currency: 'PKR', amountMinor: 1 }, { country: '*', currency: 'USD', amountMinor: 2 }] };
    expect(findPrice(v, 'pk')!.currency).toBe('PKR');
    expect(findPrice(v, 'GB')!.currency).toBe('USD');
    expect(findPrice({ ...v, prices: [v.prices[0]!] }, 'GB')).toBeNull();
  });
});
