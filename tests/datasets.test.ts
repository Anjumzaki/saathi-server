import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import seedData from '../src/data/datasets-seed.json';
import {
  cleanAnswer, labelKey, optionsFor, selectedTags, slugId, validateCustomLabel, visibleDatasets, type DatasetLike,
} from '../src/services/datasetLogic';
import { SYNC_COLLECTIONS } from '../src/services/syncLogic';
import { DIETITIAN_VISIBLE_COLLECTIONS, serializeRecordsForDietitian } from '../src/services/serializers';
import { signAccessToken } from '../src/services/tokens';
import { createStubServices } from '../src/stubs';

const all = seedData.datasets as unknown as DatasetLike[];
const keys = (a: Record<string, string[]>) => visibleDatasets(all, a).map((d) => d.key);

describe('seed integrity', () => {
  it('has unique dataset keys and unique option ids within each dataset', () => {
    expect(new Set(all.map((d) => d.key)).size).toBe(all.length);
    for (const d of all) expect(new Set(d.options.map((o) => o.id)).size, d.key).toBe(d.options.length);
  });
  it('every showIf points at a real dataset and a real option id', () => {
    for (const d of all) for (const [ref, ids] of Object.entries(d.showIf ?? {})) {
      const target = all.find((x) => x.key === ref);
      expect(target, `${d.key} -> ${ref}`).toBeTruthy();
      for (const id of ids) expect(target!.options.map((o) => o.id), `${d.key} -> ${ref}.${id}`).toContain(id);
    }
  });
  it('single-select datasets only', () => {
    for (const d of all) expect(['single', 'multi']).toContain(d.selection);
  });
});

describe('showIf resolver', () => {
  it('hides follow-ups until a trigger answer is chosen', () => {
    expect(keys({})).not.toContain('home_equipment');
    expect(keys({ walk_where: ['home'] })).toContain('home_equipment');
    expect(keys({ walk_where: ['treadmill'] })).toEqual(expect.arrayContaining(['home_equipment', 'treadmill_setup']));
  });
  it('cycle follow-ups appear for pcos / conceive / regular_periods only', () => {
    expect(keys({ goals: ['weight_loss'] })).not.toContain('cycle_pattern');
    for (const g of ['pcos', 'conceive', 'regular_periods']) expect(keys({ goals: [g] })).toEqual(expect.arrayContaining(['cycle_pattern', 'cycle_symptoms']));
    expect(keys({ goals: ['pcos'] })).not.toContain('together_ideas');
    expect(keys({ goals: ['conceive'] })).toContain('together_ideas');
  });
  it('ignores answers of a hidden dataset (stale answer after the trigger changes)', () => {
    // treadmill_setup shown by home_equipment=treadmill, but home_equipment is hidden when walk_where=park
    expect(keys({ walk_where: ['park'], home_equipment: ['treadmill'] })).not.toContain('treadmill_setup');
  });
  it('survives cyclic showIf without looping', () => {
    const cyc: DatasetLike[] = [
      { key: 'a', selection: 'single', showIf: { b: ['x'] }, options: [] },
      { key: 'b', selection: 'single', showIf: { a: ['x'] }, options: [] },
    ];
    expect(visibleDatasets(cyc, { a: ['x'], b: ['x'] })).toEqual([]);
  });
});

describe('options, tags, custom labels', () => {
  const d: DatasetLike = {
    key: 'k', selection: 'single',
    options: [
      { id: 'b', label: 'B', order: 2 }, { id: 'a', label: 'A', order: 1, tags: ['carb', 'x'] },
      { id: 'pk', label: 'PK only', regions: ['PK'] }, { id: 'off', label: 'Off', active: false },
    ],
  };
  it('filters by region and active, and orders', () => {
    expect(optionsFor(d, 'GB').map((o) => o.id)).toEqual(['pk', 'a', 'b'].filter((i) => i !== 'pk'));
    expect(optionsFor(d, 'pk').map((o) => o.id)).toEqual(['pk', 'a', 'b']);
    expect(optionsFor(d).map((o) => o.id)).toEqual(['a', 'b']);
  });
  it('collects tags only for visible datasets', () => {
    const ds: DatasetLike[] = [{ ...d, key: 'foods', selection: 'multi' }];
    expect(selectedTags(ds, { foods: ['a'] }, 'foods')).toEqual(['carb', 'x']);
    expect(selectedTags(ds, { foods: ['a'] }, 'nope')).toEqual([]);
  });
  it('validates and de-dupes labels', () => {
    expect(validateCustomLabel('   ')).toMatchObject({ ok: false });
    expect(validateCustomLabel('x'.repeat(41))).toMatchObject({ ok: false });
    expect(validateCustomLabel('  Sattu   drink ')).toEqual({ ok: true, label: 'Sattu drink' });
    expect(labelKey(' Sattu  DRINK')).toBe(labelKey('sattu drink'));
    expect(slugId('Sattu Drink!')).toBe('sattu_drink');
  });
  it('cleans answers: unknown ids dropped, single keeps one, user options allowed', () => {
    expect(cleanAnswer(d, ['a', 'zzz', 'a'], [])).toEqual(['a']);
    expect(cleanAnswer({ ...d, selection: 'multi' }, ['a', 'b', 'u_1'], ['u_1'])).toEqual(['a', 'b', 'u_1']);
    expect(cleanAnswer(d, ['a', 'b'], [])).toEqual(['a']);
  });
});

describe('answers are private', () => {
  it('syncs but is never visible to dietitians', () => {
    expect(SYNC_COLLECTIONS).toContain('answers');
    for (const c of ['plans', 'rules', 'recipes', 'feelings']) expect(DIETITIAN_VISIBLE_COLLECTIONS as readonly string[]).not.toContain(c);
    expect(DIETITIAN_VISIBLE_COLLECTIONS as readonly string[]).not.toContain('answers');
    const out = serializeRecordsForDietitian([
      { collection: 'answers', clientId: 'goals', updatedAt: new Date(), deleted: false, payload: { optionIds: ['pcos'] } },
      { collection: 'logs', clientId: 'l', updatedAt: new Date(), deleted: false, payload: { kind: 'meal' } },
    ]);
    expect(out.map((r) => r.collection)).toEqual(['logs']);
  });
});

describe('HTTP wiring', () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  it('adding an option needs sign-in', async () => {
    const r = await fetch(`${base}/v1/datasets/foods/options`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"x"}' });
    expect(r.status).toBe(401);
  });
  it('rejects an empty label before touching the database', async () => {
    const token = signAccessToken('0123456789abcdef01234567', ['client']);
    const r = await fetch(`${base}/v1/datasets/foods/options`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"label":"  "}' });
    expect(r.status).toBe(400);
  });
  it('admin dataset routes need the admin role', async () => {
    const token = signAccessToken('0123456789abcdef01234567', ['client']);
    const r = await fetch(`${base}/v1/admin/datasets`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
  });
});
