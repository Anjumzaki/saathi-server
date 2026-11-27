/**
 * The dietitian order lifecycle as her side of the marketplace walks it, and the one rule the checkout
 * screen leans on: the subscriber price is never given during a free trial.
 */
import { describe, expect, it } from 'vitest';
import { effectiveStatus, isPremiumActive, type Entitlement, type SubStatus } from '../src/services/entitlement';
import { applyDiscount, computeSettlement } from '../src/services/money';
import { ORDER_STATUSES, canRelease, canTransition, isRefundEligible, refundOpensAt, type OrderStatus } from '../src/services/orderState';
import { chooseVariant } from '../src/services/pricing';

const t0 = new Date('2026-01-01T00:00:00Z');
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);

/** Walk a path of statuses and assert every step is allowed. */
const walk = (path: readonly OrderStatus[]) => {
  for (let i = 1; i < path.length; i++) expect([path[i - 1], path[i], canTransition(path[i - 1]!, path[i]!)]).toEqual([path[i - 1], path[i], true]);
};

describe('order lifecycle, end to end', () => {
  it('walks the three ways an order can finish', () => {
    walk(['requested', 'paid', 'in_progress', 'delivered', 'released']); // the plan arrives and she releases
    walk(['requested', 'paid', 'delivered', 'released']);                // delivered without an explicit start
    walk(['requested', 'paid', 'in_progress', 'refunded']);              // nothing arrived
  });

  it('never lets an unpaid order move anywhere but paid, and never leaves a finished one', () => {
    for (const to of ORDER_STATUSES) expect(canTransition('requested', to)).toBe(to === 'paid');
    for (const from of ['released', 'refunded'] as const) {
      for (const to of ORDER_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('cannot skip payment or go backwards', () => {
    expect(canTransition('requested', 'in_progress')).toBe(false);
    expect(canTransition('delivered', 'in_progress')).toBe(false);
    expect(canTransition('in_progress', 'paid')).toBe(false);
  });

  it('tells her when the refund opens, and only while she is still waiting', () => {
    expect(refundOpensAt({ status: 'paid', paidAt: t0 }, 72)).toEqual(h(72));
    expect(refundOpensAt({ status: 'in_progress', paidAt: t0 }, 72)).toEqual(h(72));
    // Nothing to wait for: not paid, already delivered, or finished.
    expect(refundOpensAt({ status: 'requested' }, 72)).toBeNull();
    expect(refundOpensAt({ status: 'in_progress', paidAt: t0, deliveredAt: h(5) }, 72)).toBeNull();
    expect(refundOpensAt({ status: 'delivered', paidAt: t0, deliveredAt: h(5) }, 72)).toBeNull();
    expect(refundOpensAt({ status: 'released', paidAt: t0 }, 72)).toBeNull();
    expect(refundOpensAt({ status: 'refunded', paidAt: t0 }, 72)).toBeNull();
  });

  it('opens the refund exactly when the clock says it does', () => {
    const order = { status: 'paid', paidAt: t0 } as const;
    const opens = refundOpensAt(order, 72)!;
    expect(isRefundEligible(order, new Date(opens.getTime() - 1), 72)).toBe(false);
    expect(isRefundEligible(order, opens, 72)).toBe(true);
  });

  it('delivering closes the refund and opens the release', () => {
    const delivered = { status: 'delivered', paidAt: t0, deliveredAt: h(10) } as const;
    expect(isRefundEligible(delivered, h(1000), 72)).toBe(false);
    expect(canRelease(delivered, h(10), 24, true)).toBe(true);   // she can release at once
    expect(canRelease(delivered, h(33), 24, false)).toBe(false); // the job still waits
    expect(canRelease(delivered, h(34), 24, false)).toBe(true);
  });

  it('splits the money so nothing is lost on the way to the dietitian', () => {
    for (const price of [1, 99, 450000, 123457]) {
      const s = computeSettlement(price, { playFeePercent: 15, platformFeePercent: 20 });
      expect(s.playFee + s.platform + s.dietitian).toBe(price);
    }
  });
});

/** Her account as the server sees it, with the status the route would read. */
const account = (e: Entitlement | null): { status: SubStatus; isPremium: boolean } => ({
  status: effectiveStatus(e, t0),
  isPremium: isPremiumActive(e, t0),
});
const variantFor = (e: Entitlement | null, hasPrior = false) => {
  const a = account(e);
  return chooseVariant({ isPremium: a.isPremium, hasPriorOrderWithDietitian: hasPrior, status: a.status });
};

const trialing: Entitlement = { status: 'trialing', tier: 'premium', trialEndsAt: h(200), expiresAt: h(200) };
const active: Entitlement = { status: 'active', tier: 'premium', expiresAt: h(700) };
const canceled: Entitlement = { status: 'canceled', tier: 'premium', expiresAt: h(700) };
const lapsed: Entitlement = { status: 'active', tier: 'premium', expiresAt: h(-1) };

describe('the subscriber discount is never given during the trial', () => {
  it('charges a trialing Premium account the full price', () => {
    expect(account(trialing)).toEqual({ status: 'trialing', isPremium: true });
    expect(variantFor(trialing)).toBe('full');
  });

  it('gives the subscriber price once a payment has actually been taken', () => {
    expect(variantFor(active)).toBe('premium');
    // Auto-renew off, but the period she paid for is still running: she keeps the price.
    expect(variantFor(canceled)).toBe('premium');
  });

  it('charges a free or lapsed account the full price', () => {
    expect(variantFor(null)).toBe('full');
    expect(variantFor({ status: 'none' })).toBe('full');
    expect(variantFor(lapsed)).toBe('full');
    expect(effectiveStatus(lapsed, t0)).toBe('expired');
  });

  it('still gives the follow-up price in a trial, because that is earned from the dietitian, not from paying us', () => {
    expect(variantFor(trialing, true)).toBe('followUp');
    expect(variantFor(null, true)).toBe('followUp');
  });

  it('prices the discount the same way the fee config describes it', () => {
    expect(applyDiscount(450000, 30)).toBe(315000);
    expect(applyDiscount(450000, 0)).toBe(450000);
    expect(applyDiscount(999, 50)).toBe(500); // half up, in minor units
  });
});
