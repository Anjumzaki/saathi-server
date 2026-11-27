import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createStubServices } from '../src/stubs';
import { DEFAULT_COUNTRY, producePacks, resolveProduce, selectProduce, tilesFor } from '../src/data/produce';
import type { ProducePack } from '../src/data/produce';

const packs = producePacks();
const pk = packs.find((p) => p.country === 'PK')!;

describe('produce pack data', () => {
  it('covers Pakistan by province and the UAE', () => {
    expect(pk.regions.map((r) => r.region)).toEqual(expect.arrayContaining(['Punjab', 'Sindh']));
    const ae = packs.find((p) => p.country === 'AE')!;
    expect(ae.regions.map((r) => r.region)).toEqual(expect.arrayContaining(['Abu Dhabi']));
    expect(packs.some((p) => p.country === DEFAULT_COUNTRY)).toBe(true);
  });
  it('has sane months, a use note and a kind everywhere', () => {
    const lists = packs.flatMap((p) => [p.items, ...p.regions.map((r) => r.items)]);
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0);
      for (const i of list) {
        expect(i.name, JSON.stringify(i)).toBeTruthy();
        expect(i.use, i.name).toBeTruthy();
        expect(['fruit', 'veg', 'herb'], i.name).toContain(i.kind);
        expect(i.months.length, i.name).toBeGreaterThan(0);
        for (const m of i.months) expect(m, i.name).toBeGreaterThanOrEqual(1);
        for (const m of i.months) expect(m, i.name).toBeLessThanOrEqual(12);
      }
    }
  });
  it('never puts a city in two regions of the same country', () => {
    for (const p of packs) {
      const all = p.regions.flatMap((r) => r.cities.map((c) => c.toLowerCase()));
      expect(new Set(all).size, p.country).toBe(all.length);
    }
  });
});

describe('fallback chain', () => {
  it('uses her region when the city is in one', () => {
    const r = resolveProduce(packs, 'PK', 'Lahore')!;
    expect(r.source).toBe('region');
    expect(r.region).toBe('Punjab');
    expect(r.items.map((i) => i.name)).toContain('Kinnow');
  });
  it('matches a region by name too, however it is spelled', () => {
    expect(resolveProduce(packs, 'AE', 'ras al khaimah')!.region).toBe('Dubai and the Northern Emirates');
    expect(resolveProduce(packs, 'PK', 'sindh')!.region).toBe('Sindh');
  });
  it('falls back to the country when the city is not in any region', () => {
    const r = resolveProduce(packs, 'PK', 'Hunza')!;
    expect(r.source).toBe('country');
    expect(r.region).toBe('');
  });
  it('falls back to the neutral list for a country with no pack', () => {
    const r = resolveProduce(packs, 'ZW', 'Harare')!;
    expect(r.source).toBe('default');
    expect(r.pack.country).toBe(DEFAULT_COUNTRY);
  });
  it('prefers a corrected pack from the database over the written one', () => {
    const corrected: ProducePack = {
      country: 'PK', name: 'Pakistan', version: 7, updatedAt: '2026-12-01',
      items: [{ name: 'Amrood', kind: 'fruit', use: '1 medium', months: [11] }], regions: [],
    };
    const r = resolveProduce([corrected, ...packs.filter((p) => p.country !== 'PK')], 'PK', 'Lahore')!;
    expect(r.items.map((i) => i.name)).toEqual(['Amrood']);
  });
  it('answers nothing when even the neutral list is missing', () => {
    expect(selectProduce(packs.filter((p) => p.country !== DEFAULT_COUNTRY), { country: 'ZW', month: 5 })).toBeNull();
  });
});

describe('month and tiles', () => {
  const punjab = pk.regions.find((r) => r.region === 'Punjab')!.items;
  it('shows what is in season now and flags what starts next month', () => {
    const nov = tilesFor(punjab, 11);
    expect(nov.map((t) => t.name)).toContain('Guava');
    expect(nov.map((t) => t.name)).not.toContain('Mango');
    expect(nov.find((t) => t.name === 'Kinnow')?.soon).toBe('from Dec');
    expect(tilesFor(punjab, 6).map((t) => t.name)).toContain('Mango');
  });
  it('wraps December into January and honours max', () => {
    expect(tilesFor(punjab, 12).map((t) => t.name)).toContain('Kinnow');
    expect(tilesFor(punjab, 11, 3)).toHaveLength(3);
  });
});

describe('GET /v1/region/:country/produce', () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as { produce?: Record<string, unknown>; error?: { code: string } } };
  };

  it('serves the region list, keyed by city and month', async () => {
    const { status, body } = await get('/v1/region/pk/produce?region=Karachi&month=1');
    expect(status).toBe(200);
    expect(body.produce).toMatchObject({ country: 'PK', region: 'Sindh', month: 1, source: 'region', version: 1 });
    expect(body.produce!['updatedAt']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const names = (body.produce!['items'] as { name: string }[]).map((i) => i.name);
    expect(names).toContain('Chikoo');
  });
  it('walks the chain down to the country and then the neutral list', async () => {
    expect((await get('/v1/region/pk/produce?region=Hunza&month=11')).body.produce).toMatchObject({ source: 'country' });
    expect((await get('/v1/region/zw/produce?month=11')).body.produce).toMatchObject({ source: 'default', country: DEFAULT_COUNTRY });
  });
  it('defaults the month to this one and caps the list', async () => {
    const { body } = await get('/v1/region/ae/produce?region=Dubai');
    expect(body.produce!['month']).toBe(new Date().getUTCMonth() + 1);
    expect((body.produce!['items'] as unknown[]).length).toBeLessThanOrEqual(8);
    const three = await get('/v1/region/ae/produce?region=Dubai&max=3');
    expect((three.body.produce!['items'] as unknown[]).length).toBe(3);
  });
  it('rejects a bad country or month', async () => {
    expect((await get('/v1/region/pakistan/produce')).status).toBe(400);
    expect((await get('/v1/region/pk/produce?month=13')).status).toBe(400);
  });
});
