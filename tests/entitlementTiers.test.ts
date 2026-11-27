import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { makeRequireFeature } from '../src/middleware/auth';
import {
  featuresFor,
  hasFeature,
  resolveEntitlement,
  tierNeededFor,
  tierOf,
  type Entitlement,
  type Feature,
} from '../src/services/entitlement';
import { toPackageViews, tierOfProduct } from '../src/services/packageCatalogue';
import { chooseVariant } from '../src/services/pricing';

const now = new Date('2026-06-01T00:00:00Z');
const later = new Date('2026-07-01T00:00:00Z');
const earlier = new Date('2026-05-01T00:00:00Z');

const premiumActive: Entitlement = { status: 'active', tier: 'premium', plan: 'monthly', expiresAt: later };
const plusActive: Entitlement = { status: 'active', tier: 'plus', plan: 'yearly', expiresAt: later };
const premiumTrial: Entitlement = { status: 'trialing', tier: 'premium', plan: 'monthly', trialEndsAt: later, expiresAt: later };
const plusTrial: Entitlement = { status: 'trialing', tier: 'plus', plan: 'monthly', trialEndsAt: later, expiresAt: later };

describe('tier resolution', () => {
  it('reads the tier only while the subscription is running', () => {
    expect(tierOf(null, now)).toBe('free');
    expect(tierOf({ status: 'none' }, now)).toBe('free');
    expect(tierOf(premiumActive, now)).toBe('premium');
    expect(tierOf(plusActive, now)).toBe('plus');
    expect(tierOf(plusTrial, now)).toBe('plus');
    expect(tierOf({ status: 'active', tier: 'plus', expiresAt: earlier }, now)).toBe('free');
  });
  it('treats records written before tiers existed as Premium', () => {
    expect(tierOf({ status: 'active', expiresAt: later }, now)).toBe('premium');
    expect(tierOf({ status: 'canceled', tier: null, expiresAt: later }, now)).toBe('premium');
  });
  it('free opens nothing paid', () => {
    expect(featuresFor('free', 'none')).toEqual([]);
    expect(hasFeature(null, 'plan_read_ai', now)).toBe(false);
  });
  it('Plus adds the dietitian features on top of Premium', () => {
    for (const f of ['representative_help', 'saathi_plan_request'] as Feature[]) {
      expect(hasFeature(plusActive, f, now)).toBe(true);
      expect(hasFeature(premiumActive, f, now)).toBe(false);
    }
    expect(hasFeature(plusActive, 'plan_read_ai', now)).toBe(true);
    expect(tierNeededFor('representative_help')).toBe('plus');
    expect(tierNeededFor('plan_read_ai')).toBe('premium');
  });
  it('an expired subscription opens nothing', () => {
    const lapsed: Entitlement = { status: 'active', tier: 'plus', expiresAt: earlier };
    expect(resolveEntitlement(lapsed, now)).toMatchObject({ tier: 'free', status: 'expired', features: [] });
  });
  it('canceled keeps everything until the paid period ends', () => {
    expect(hasFeature({ status: 'canceled', tier: 'premium', expiresAt: later }, 'dietitian_discount', now)).toBe(true);
  });
  it('reports one shape for GET /subscription', () => {
    expect(resolveEntitlement(premiumTrial, now)).toMatchObject({ tier: 'premium', status: 'trialing', plan: 'monthly', trialEndsAt: later, expiresAt: later });
  });
});

describe('the trial excludes the discounts', () => {
  it('holds back both discounts while trialing, and nothing else', () => {
    const trialing = featuresFor('plus', 'trialing');
    expect(trialing).not.toContain('dietitian_discount');
    expect(trialing).not.toContain('merchant_discount');
    for (const f of ['plan_read_ai', 'plan_generate_ai', 'guided_routines', 'local_produce', 'partner_view', 'watch_access', 'representative_help', 'saathi_plan_request'] as Feature[]) {
      expect(trialing).toContain(f);
    }
  });
  it('opens them once a payment has gone through', () => {
    expect(hasFeature(premiumTrial, 'dietitian_discount', now)).toBe(false);
    expect(hasFeature(premiumTrial, 'merchant_discount', now)).toBe(false);
    expect(hasFeature(premiumActive, 'dietitian_discount', now)).toBe(true);
    expect(hasFeature(premiumActive, 'merchant_discount', now)).toBe(true);
  });
  it('charges the full dietitian price during the trial', () => {
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: false, status: 'trialing' })).toBe('full');
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: false, status: 'active' })).toBe('premium');
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: false, status: 'canceled' })).toBe('premium');
    // a follow-up with the same dietitian is cheaper either way
    expect(chooseVariant({ isPremium: true, hasPriorOrderWithDietitian: true, status: 'trialing' })).toBe('followUp');
  });
});

describe('requireFeature', () => {
  // The gate reads the clock itself, so these fixtures run from the real now.
  const soon = new Date(Date.now() + 30 * 86_400_000);
  const live = { premium: { status: 'active', tier: 'premium', expiresAt: soon } as Entitlement,
    plus: { status: 'active', tier: 'plus', expiresAt: soon } as Entitlement,
    trial: { status: 'trialing', tier: 'premium', trialEndsAt: soon, expiresAt: soon } as Entitlement };

  const run = async (sub: Entitlement | null, feature: Feature, auth: { userId: string; roles: string[] } | null = { userId: 'u1', roles: ['client'] }) => {
    const gate = makeRequireFeature(async () => sub)(feature);
    let passed = false;
    let err: unknown;
    const next: NextFunction = (e?: unknown) => { if (e) err = e; else passed = true; };
    gate({ auth: auth ?? undefined } as unknown as Request, {} as Response, next);
    await new Promise((r) => setImmediate(r));
    return { passed, err: err as { status?: number; message?: string } | undefined };
  };

  it('lets a feature of her tier through', async () => {
    expect((await run(live.premium, 'plan_read_ai')).passed).toBe(true);
    expect((await run(live.plus, 'representative_help')).passed).toBe(true);
    expect((await run(live.trial, 'guided_routines')).passed).toBe(true);
  });
  it('denies a feature of a higher tier with 402', async () => {
    const r = await run(live.premium, 'saathi_plan_request');
    expect(r.passed).toBe(false);
    expect(r.err?.status).toBe(402);
    expect(r.err?.message).toContain('Plus');
  });
  it('denies everything paid on the free tier', async () => {
    const r = await run(null, 'plan_read_ai');
    expect(r.passed).toBe(false);
    expect(r.err?.status).toBe(402);
  });
  it('denies a discount during the trial and says why', async () => {
    const r = await run(live.trial, 'dietitian_discount');
    expect(r.passed).toBe(false);
    expect(r.err?.status).toBe(402);
    expect(r.err?.message).toContain('first payment');
  });
  it('needs a session', async () => {
    const r = await run(live.premium, 'plan_read_ai', null);
    expect(r.passed).toBe(false);
    expect(r.err?.status).toBe(401);
  });
});

describe('GET /packages', () => {
  const docs = [
    { key: 'dietitian_band_a', kind: 'dietitian_plan', label: 'Starter plan', active: true, variants: [{ variant: 'full', productId: 'x', prices: [] }] },
    { key: 'premium_plus', kind: 'premium', tier: 'plus', label: 'Saathi Premium Plus', trialDays: 7, active: true,
      features: ['plan_read_ai', 'representative_help', 'saathi_plan_request', 'not_a_feature'], perks: ['Everything in Premium'],
      variants: [{ variant: 'monthly', productId: 'saathi_plus_monthly', prices: [{ country: 'PK', currency: 'PKR', amountMinor: 250000 }] }, { variant: 'yearly', productId: 'saathi_plus_yearly', iosProductId: 'saathi_plus_yearly_ios', prices: [] }] },
    { key: 'premium_default', kind: 'premium', tier: 'premium', label: 'Saathi Premium', trialDays: 7, active: true, features: [], perks: ['Read your plan'],
      variants: [{ variant: 'monthly', productId: 'saathi_premium_monthly', prices: [] }, { variant: 'yearly', productId: 'saathi_premium_yearly', prices: [] }] },
  ];

  it('returns only the paid packages, Premium first', () => {
    const views = toPackageViews(docs);
    expect(views.map((v) => v.key)).toEqual(['premium_default', 'premium_plus']);
  });
  it('carries tier, label, trial, features, perks, product ids and prices', () => {
    const plus = toPackageViews(docs).find((v) => v.tier === 'plus')!;
    expect(plus).toMatchObject({ key: 'premium_plus', tier: 'plus', label: 'Saathi Premium Plus', trialDays: 7, perks: ['Everything in Premium'] });
    expect(plus.features).toEqual(['plan_read_ai', 'representative_help', 'saathi_plan_request']); // unknown keys dropped
    expect(plus.variants.map((v) => v.variant)).toEqual(['monthly', 'yearly']);
    expect(plus.variants[0]!.productIds).toEqual({ android: 'saathi_plus_monthly', ios: 'saathi_plus_monthly' });
    expect(plus.variants[1]!.productIds.ios).toBe('saathi_plus_yearly_ios');
    expect(plus.variants[0]!.prices).toEqual([{ country: 'PK', currency: 'PKR', amountMinor: 250000 }]);
  });
  it('falls back to the tier default when a package carries no feature list', () => {
    const prem = toPackageViews(docs).find((v) => v.tier === 'premium')!;
    expect(prem.features).toContain('plan_read_ai');
    expect(prem.features).not.toContain('representative_help');
  });
  it('maps a store product id back to its package', () => {
    const views = toPackageViews(docs);
    expect(tierOfProduct(views, 'saathi_plus_yearly_ios')).toEqual({ tier: 'plus', plan: 'yearly' });
    expect(tierOfProduct(views, 'saathi_premium_monthly')).toEqual({ tier: 'premium', plan: 'monthly' });
    expect(tierOfProduct(views, 'nope')).toBeNull();
  });
});
