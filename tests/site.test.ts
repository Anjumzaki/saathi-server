import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import express from 'express';
import { isApiPath, mountSite } from '../src/middleware/site';
import { createStubServices } from '../src/stubs';

// The website is served by the same app as the API. No database is needed for these.
let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const page = (path: string) => fetch(base + path, { headers: { accept: 'text/html' }, redirect: 'manual' });
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('website', () => {
  it('serves the homepage at /', async () => {
    const r = await page('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('Saathi');
  });
  it('serves a page with and without .html', async () => {
    expect((await page('/pricing.html')).status).toBe(200);
    const short = await page('/pricing?x=1');
    expect(short.status).toBe(301);
    expect(short.headers.get('location')).toBe('/pricing.html?x=1');
    const index = await page('/index.html');
    expect(index.status).toBe(301);
    expect(index.headers.get('location')).toBe('/');
  });
  it('keeps the API out of search results', async () => {
    expect((await fetch(base + '/health')).headers.get('x-robots-tag')).toBe('noindex');
    expect((await page('/features.html')).headers.get('x-robots-tag')).toBeNull();
  });
  it('gives every page a title, a description and a canonical address on the main host', async () => {
    for (const p of ['/', '/pricing.html', '/blog-pcos-plate.html', '/about.html']) {
      const head = (await (await page(p)).text()).split('</head>')[0] ?? '';
      expect(head).toMatch(/<title>[^<]{10,65}<\/title>/);
      expect(head).toMatch(/<meta name="description" content="[^"]{50,170}">/);
      expect(head).toContain('<link rel="canonical" href="https://www.saathi-app.com/');
      expect(head).toContain('og:title');
    }
  });
  it('serves robots.txt, the sitemap and images', async () => {
    expect((await fetch(base + '/robots.txt')).status).toBe(200);
    expect((await fetch(base + '/sitemap.xml')).status).toBe(200);
    const img = await fetch(base + '/og.png');
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
  it('lets the pages run their own scripts and load Poppins, and nothing else', async () => {
    const csp = (await page('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain("frame-ancestors 'none'");
  });
  it('keeps the strict policy on the API', async () => {
    const csp = (await fetch(base + '/health')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain("'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
  it('shows the site 404 page to a browser and JSON to everything else', async () => {
    const html = await page('/no-such-page');
    expect(html.status).toBe(404);
    expect(html.headers.get('content-type')).toContain('text/html');
    const api = await page('/v1/no-such-route');
    expect(api.status).toBe(404);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await fetch(base + '/no-such-page')).headers.get('content-type')).toContain('application/json');
  });
  it('never serves files outside the site folder', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/.env', '/..%2f.env.example']) expect((await page(p)).status).toBe(404);
  });
  it('knows which paths are the API', () => {
    expect(isApiPath('/v1/me')).toBe(true);
    expect(isApiPath('/health')).toBe(true);
    expect(isApiPath('/v1')).toBe(true);
    expect(isApiPath('/v1-pricing')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
  it('points both forms at this server', async () => {
    expect(await (await page('/download.html')).text()).toContain("WAITLIST_ENDPOINT = '/v1/site/waitlist'");
    expect(await (await page('/pro.html')).text()).toContain("PRO_ENDPOINT='/v1/site/pro-application'");
  });
});

describe('website forms', () => {
  it('rejects a bad email on the launch list', async () => {
    const r = await post('/v1/site/waitlist', { email: 'nope', platform: 'android' });
    expect(r.status).toBe(400);
  });
  it('rejects a Pro application without a name', async () => {
    const r = await post('/v1/site/pro-application', { email: 'd@example.com', name: '' });
    expect(r.status).toBe(400);
  });
  it('needs the admin role to read the forms', async () => {
    expect((await fetch(base + '/v1/admin/leads')).status).toBe(401);
  });
});

describe('website in production', () => {
  it('sends plain http pages to https and leaves the API alone', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/health', (_req, res) => { res.json({ ok: true }); });
    mountSite(app, { production: true, host: 'www.saathi-app.com' });
    const s = app.listen(0);
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const plain = await fetch(b + '/pricing?x=1', { redirect: 'manual', headers: { 'x-forwarded-host': 'www.saathi-app.com', 'x-forwarded-proto': 'http' } });
      expect(plain.status).toBe(301);
      expect(plain.headers.get('location')).toBe('https://www.saathi-app.com/pricing?x=1');
      const other = await fetch(b + '/pricing.html', { redirect: 'manual', headers: { 'x-forwarded-host': 'saathi-437e5bca391d.herokuapp.com', 'x-forwarded-proto': 'https' } });
      expect(other.status).toBe(301);
      expect(other.headers.get('location')).toBe('https://www.saathi-app.com/pricing.html');
      expect((await fetch(b + '/pricing.html', { redirect: 'manual', headers: { 'x-forwarded-host': 'www.saathi-app.com', 'x-forwarded-proto': 'https' } })).status).toBe(200);
      expect((await fetch(b + '/health', { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } })).status).toBe(200);
    } finally { await new Promise<void>((r) => s.close(() => r())); }
  });
});
