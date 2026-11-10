import type { PlanContent } from '../schemas/plan';

export interface Changed<T> {
  key: string;
  before: T;
  after: T;
  fields: string[];
}
export interface Diff<T> {
  added: T[];
  changed: Changed<T>[];
  removed: T[];
}
export interface PlanDiff {
  items: Diff<unknown>;
  rules: Diff<unknown>;
  recipes: Diff<unknown>;
  summary: { added: number; changed: number; removed: number };
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function diffByKey<T extends object>(prev: T[], next: T[], keyOf: (t: T) => string): Diff<T> {
  const before = new Map(prev.map((p) => [keyOf(p), p]));
  const after = new Map(next.map((n) => [keyOf(n), n]));
  const diff: Diff<T> = { added: [], changed: [], removed: [] };
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) {
      diff.added.push(a);
    } else if (stableStringify(a) !== stableStringify(b)) {
      const ra = a as Record<string, unknown>;
      const rb = b as Record<string, unknown>;
      const fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])]
        .filter((f) => stableStringify(ra[f]) !== stableStringify(rb[f]))
        .sort();
      diff.changed.push({ key: k, before: b, after: a, fields });
    }
  }
  for (const [k, b] of before) if (!after.has(k)) diff.removed.push(b);
  return diff;
}

/** Diff a new plan version against the previous one (null = first version: everything is "added"). */
export function diffPlans(prev: PlanContent | null, next: PlanContent): PlanDiff {
  const p = prev ?? { items: [], rules: [], recipes: [] };
  const items = diffByKey(p.items, next.items, (i) => i.key);
  const rules = diffByKey(p.rules, next.rules, (r) => r.id);
  const recipes = diffByKey(p.recipes, next.recipes, (r) => r.id);
  const sum = (f: 'added' | 'changed' | 'removed') => items[f].length + rules[f].length + recipes[f].length;
  return { items, rules, recipes, summary: { added: sum('added'), changed: sum('changed'), removed: sum('removed') } };
}
