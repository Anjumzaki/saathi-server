import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A package or fee edit must leave no stale cached price behind. There is no database in these tests,
 * so the two config models and the three cache invalidators are stood in for and the real routes are
 * called over HTTP: what is being checked is the wiring, which is where this went wrong before.
 */
const h = vi.hoisted(() => ({ cleared: [] as string[], saved: [] as unknown[] }));

vi.mock('../src/services/feeConfig', async (orig) => {
  const real = await orig<typeof import('../src/services/feeConfig')>();
  return {
    ...real,
    getFeeConfig: async () => real.DEFAULT_FEE_CONFIG,
    invalidateFeeConfig: () => { h.cleared.push('fee'); },
    invalidatePackages: () => { h.cleared.push('packages'); },
  };
});
vi.mock('../src/services/packageCatalogue', async (orig) => {
  const real = await orig<typeof import('../src/services/packageCatalogue')>();
  return { ...real, invalidatePaidPackages: () => { h.cleared.push('paid'); } };
});
vi.mock('../src/models/PackageConfig', async (orig) => {
  const real = await orig<typeof import('../src/models/PackageConfig')>();
  const pkg = { _id: '507f1f77bcf86cd799439011', key: 'premium_monthly', kind: 'premium', label: 'Saathi Premium' };
  return {
    ...real,
    FeeConfigModel: { findOneAndUpdate: async (_q: unknown, update: unknown) => { h.saved.push(update); return pkg; } },
    PackageConfig: {
      find: () => ({ sort: () => ({ lean: async () => [pkg] }) }),
      exists: async () => null,
      create: async (b: unknown) => { h.saved.push(b); return pkg; },
      findByIdAndUpdate: async (_id: unknown, update: unknown) => { h.saved.push(update); return pkg; },
      findByIdAndDelete: async () => pkg,
    },
  };
});

// vi.mock is hoisted above these, so the routes are built on the stand-ins above.
import { createApp } from '../src/app';
import { signAccessToken } from '../src/services/tokens';
import { createStubServices } from '../src/stubs';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { h.cleared = []; h.saved = []; });

const token = () => signAccessToken('507f1f77bcf86cd799439011', ['admin']);
const send = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const PREMIUM = {
  key: 'premium_monthly', kind: 'premium', label: 'Saathi Premium', active: true, sortOrder: 0,
  variants: [{ variant: 'monthly', productId: 'saathi_premium_monthly', prices: [{ country: 'PK', currency: 'PKR', amountMinor: 90000 }] }],
};

describe('a fee edit', () => {
  it('saves what was sent and clears every cached price', async () => {
    const r = await send('PUT', '/v1/admin/fee-config', { platformFeePercent: 25, premiumDiscountPercent: 40 });
    expect(r.status).toBe(200);
    expect(h.saved[0]).toMatchObject({ $set: { platformFeePercent: 25, premiumDiscountPercent: 40 } });
    // A discount is what band prices are derived from, so the package caches are as stale as the fee one.
    expect(h.cleared.sort()).toEqual(['fee', 'packages', 'paid']);
  });
  it('refuses a percentage that is not one, and changes nothing', async () => {
    expect((await send('PUT', '/v1/admin/fee-config', { platformFeePercent: 120 })).status).toBe(400);
    expect((await send('PUT', '/v1/admin/fee-config', { madeUp: 1 })).status).toBe(400);
    expect(h.cleared).toEqual([]);
  });
});

describe('a package edit', () => {
  it('clears every cached price on create, save and delete', async () => {
    expect((await send('POST', '/v1/admin/packages', PREMIUM)).status).toBe(201);
    expect(h.cleared.sort()).toEqual(['fee', 'packages', 'paid']);

    h.cleared = [];
    expect((await send('PUT', '/v1/admin/packages/507f1f77bcf86cd799439011', PREMIUM)).status).toBe(200);
    expect(h.cleared.sort()).toEqual(['fee', 'packages', 'paid']);

    h.cleared = [];
    expect((await send('DELETE', '/v1/admin/packages/507f1f77bcf86cd799439011')).status).toBe(204);
    expect(h.cleared.sort()).toEqual(['fee', 'packages', 'paid']);
  });
  it('refuses a package the app could not use, and clears nothing', async () => {
    expect((await send('POST', '/v1/admin/packages', { ...PREMIUM, variants: [] })).status).toBe(400);
    expect((await send('POST', '/v1/admin/packages', { ...PREMIUM, kind: 'something_else' })).status).toBe(400);
    expect((await send('POST', '/v1/admin/packages', { ...PREMIUM, key: 'Not A Key' })).status).toBe(400);
    expect(h.cleared).toEqual([]);
  });
  it('can re-cut what Premium Plus opens, and refuses a feature that does not exist', async () => {
    const plus = { ...PREMIUM, key: 'premium_plus_monthly', tier: 'plus', features: ['representative_help', 'plan_read_ai'], perks: ['Chat with a Saathi dietitian'] };
    expect((await send('POST', '/v1/admin/packages', plus)).status).toBe(201);
    expect(h.saved[0]).toMatchObject({ tier: 'plus', features: ['representative_help', 'plan_read_ai'] });

    const bad = await send('POST', '/v1/admin/packages', { ...plus, features: ['make_tea'] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('representative_help');
  });
  it('leaves the tier and the features alone when an edit does not mention them', async () => {
    expect((await send('PUT', '/v1/admin/packages/507f1f77bcf86cd799439011', PREMIUM)).status).toBe(200);
    const update = h.saved[0] as { $set: Record<string, unknown> };
    expect(Object.keys(update.$set)).not.toContain('tier');
    expect(Object.keys(update.$set)).not.toContain('features');
  });
  it('lists the packages for the tool to draw', async () => {
    const r = await send('GET', '/v1/admin/packages');
    expect(r.status).toBe(200);
    const out = (await r.json()) as { packages: { key: string }[] };
    expect(out.packages[0]!.key).toBe('premium_monthly');
  });
});
