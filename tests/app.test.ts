import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/services/tokens';
import { createStubServices } from '../src/stubs';

// Wiring tests that need no database: routing, auth gate, validation, error shape, pure plan check.
let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();
const post = (path: string, body: unknown, token?: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe('HTTP wiring', () => {
  it('serves /health with security headers', async () => {
    const r = await fetch(base + '/health');
    expect(r.status).toBe(200);
    expect((await j(r)).status).toBe('ok');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('404s unknown routes with a JSON error', async () => {
    const r = await fetch(base + '/nope');
    expect(r.status).toBe(404);
    expect((await j(r)).error.code).toBe('not_found');
  });
  it('requires auth on private routes', async () => {
    for (const p of ['/v1/me', '/v1/sync/pull', '/v1/orders', '/v1/partner/shares']) expect((await fetch(base + p)).status).toBe(401);
    expect((await fetch(base + '/v1/me', { headers: { authorization: 'Bearer garbage' } })).status).toBe(401);
  });
  it('requires the admin role for admin routes', async () => {
    const client = signAccessToken('507f1f77bcf86cd799439011', ['client']);
    const r = await fetch(base + '/v1/admin/fee-config', { headers: { authorization: `Bearer ${client}` } });
    expect(r.status).toBe(403);
  });
  it('validates input with zod', async () => {
    const r = await post('/v1/auth/otp/request', { email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect((await j(r)).error.code).toBe('validation_error');
    expect((await post('/v1/auth/otp/verify', { email: 'a@b.co', code: '12' })).status).toBe(400);
    // password sign-in input is validated before anything touches the database
    expect((await post('/v1/auth/signup', { email: 'a@b.co', password: 'short' })).status).toBe(400);
    expect((await post('/v1/auth/signup', { email: 'a@b.co' })).status).toBe(400);
    expect((await post('/v1/auth/login', { email: 'a@b.co' })).status).toBe(400);
    expect((await post('/v1/auth/password/change', { currentPassword: 'x', newPassword: 'longenough1' })).status).toBe(401); // needs a session
    expect((await post('/v1/auth/password/reset', { email: 'a@b.co', code: '123456', password: 'short' })).status).toBe(400);
    // sign-up form data is validated before anything else happens
    for (const signup of [{ phone: '03001234567' }, { displayName: '' }, { acceptTerms: false }, { role: 'admin' }]) {
      const bad = await post('/v1/auth/otp/verify', { email: 'a@b.co', code: '123456', signup });
      expect(bad.status).toBe(400);
      expect((await j(bad)).error.code).toBe('validation_error');
    }
  });
  it('rejects malformed JSON cleanly', async () => {
    const r = await fetch(base + '/v1/auth/otp/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    expect(r.status).toBe(400);
  });
  it('runs the structural plan check end to end', async () => {
    const tok = signAccessToken('507f1f77bcf86cd799439011', ['client']);
    const r = await post('/v1/plans/check', { waterTargetMl: 2000, items: [
      { category: 'meal', title: 'Breakfast', time: '08:00', details: 'eggs' },
      { category: 'meal', title: 'Lunch', time: '13:00', details: 'dal' },
      { category: 'meal', title: 'Dinner', time: '18:00', mealKind: 'dinner', details: 'chicken' },
      { category: 'sleep', title: 'Bed', time: '23:00' },
    ] }, tok);
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body.verdict).toBe('good');
    expect(body.tweaks).toEqual([]);
    expect((await post('/v1/plans/check', { items: [{ category: 'meal', title: 'x', time: '8am' }] }, tok)).status).toBe(400);
  });
});
