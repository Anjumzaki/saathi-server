import { describe, expect, it } from 'vitest';
import { diffPlans, stableStringify } from '../src/services/planDiff';
import { nextVersion } from '../src/services/planVersioning';
import type { PlanContent, PlanItem } from '../src/schemas/plan';

const item = (key: string, extra: Partial<PlanItem> = {}): PlanItem => ({ key, category: 'meal', title: key, daysOfWeek: [], tier: 'notification', options: [], ...extra });
const plan = (items: PlanItem[], rules: PlanContent['rules'] = [], recipes: PlanContent['recipes'] = []): PlanContent => ({ items, rules, recipes });

describe('stableStringify', () => {
  it('ignores key order and undefined', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: undefined } })).toBe(stableStringify({ b: { c: 2 }, a: 1 }));
  });
});

describe('diffPlans', () => {
  it('treats the first version as all added', () => {
    const d = diffPlans(null, plan([item('a'), item('b')], [{ id: 'r1', text: 'x', source: 'OWN' }]));
    expect(d.summary).toEqual({ added: 3, changed: 0, removed: 0 });
  });
  it('detects added, changed (with fields) and removed', () => {
    const prev = plan([item('a'), item('b', { time: '08:00' }), item('c')]);
    const next = plan([item('a'), item('b', { time: '09:00' }), item('d')]);
    const d = diffPlans(prev, next);
    expect(d.items.added.map((x) => (x as PlanItem).key)).toEqual(['d']);
    expect(d.items.removed.map((x) => (x as PlanItem).key)).toEqual(['c']);
    expect(d.items.changed).toHaveLength(1);
    expect(d.items.changed[0]!.key).toBe('b');
    expect(d.items.changed[0]!.fields).toEqual(['time']);
    expect(d.summary).toEqual({ added: 1, changed: 1, removed: 1 });
  });
  it('is empty for identical plans', () => {
    const p = plan([item('a')], [{ id: 'r', text: 't', source: 'DIETITIAN' }]);
    expect(diffPlans(p, structuredClone(p)).summary).toEqual({ added: 0, changed: 0, removed: 0 });
  });
  it('diffs rules and recipes by id', () => {
    const prev = plan([], [{ id: 'r1', text: 'old', source: 'OWN' }], [{ id: 'x', title: 'Soup', ingredients: [], steps: [] }]);
    const next = plan([], [{ id: 'r1', text: 'new', source: 'OWN' }], []);
    const d = diffPlans(prev, next);
    expect(d.rules.changed[0]!.fields).toEqual(['text']);
    expect(d.recipes.removed).toHaveLength(1);
  });
});

describe('nextVersion', () => {
  it('numbers versions and carries the diff', () => {
    const v1 = nextVersion(null, plan([item('a')]));
    expect(v1.number).toBe(1);
    const v2 = nextVersion(v1, plan([item('a'), item('b')]));
    expect(v2.number).toBe(2);
    expect(v2.diff!.summary.added).toBe(1);
  });
});
