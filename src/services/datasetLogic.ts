/** Pure dataset logic, shared in spirit with the mobile app (same showIf rules). No database access. */

export interface DatasetOption {
  id: string;
  label: string;
  labelUr?: string;
  icon?: string;
  tags?: string[];
  regions?: string[];
  source?: 'seed' | 'user' | 'dietitian' | 'promoted';
  order?: number;
  active?: boolean;
}
export interface DatasetLike {
  key: string;
  selection: 'single' | 'multi';
  allowCustom?: boolean;
  minPick?: number;
  showIf?: Record<string, string[]> | null;
  options: DatasetOption[];
}
export type Answers = Record<string, string[]>;

export const MAX_CUSTOM_PER_DATASET = 20;
export const MAX_CUSTOM_LABEL = 40;

/** A dataset with showIf is visible when ANY listed answer is selected; the referenced dataset must itself be visible. */
export function visibleDatasets<T extends DatasetLike>(all: T[], answers: Answers): T[] {
  const byKey = new Map(all.map((d) => [d.key, d]));
  const memo = new Map<string, boolean>();
  const visible = (key: string, seen: Set<string>): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const d = byKey.get(key);
    if (!d || seen.has(key)) return false;
    let ok = true;
    if (d.showIf && Object.keys(d.showIf).length) {
      const next = new Set(seen).add(key);
      ok = Object.entries(d.showIf).some(
        ([refKey, ids]) => visible(refKey, next) && (answers[refKey] ?? []).some((a) => ids.includes(a)),
      );
    }
    memo.set(key, ok);
    return ok;
  };
  return all.filter((d) => visible(d.key, new Set()));
}

/** Options a user sees for one dataset: active, in the user's region, ordered. */
export function optionsFor(d: DatasetLike, country?: string): DatasetOption[] {
  const cc = country?.toUpperCase();
  return d.options
    .filter((o) => o.active !== false && (!o.regions?.length || (cc !== undefined && o.regions.includes(cc))))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Union of tags of the selected options (plan builder / checker input). Ignores answers of hidden datasets. */
export function selectedTags(all: DatasetLike[], answers: Answers, key: string): string[] {
  if (!visibleDatasets(all, answers).some((d) => d.key === key)) return [];
  const d = all.find((x) => x.key === key)!;
  const sel = new Set(answers[key] ?? []);
  return [...new Set(d.options.filter((o) => sel.has(o.id)).flatMap((o) => o.tags ?? []))];
}

export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
export const labelKey = (raw: string): string => normalizeLabel(raw).toLocaleLowerCase();

export function validateCustomLabel(raw: string): { ok: true; label: string } | { ok: false; reason: string } {
  const label = normalizeLabel(raw);
  if (!label) return { ok: false, reason: 'Label is empty' };
  if (label.length > MAX_CUSTOM_LABEL) return { ok: false, reason: `Label is longer than ${MAX_CUSTOM_LABEL} characters` };
  return { ok: true, label };
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
export function slugId(label: string): string {
  return normalizeLabel(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || shortId();
}

/** Validate a stored answer against a dataset: single => at most 1, unknown ids dropped unless the user's own option. */
export function cleanAnswer(d: DatasetLike, ids: string[], userOptionIds: string[]): string[] {
  const valid = new Set([...d.options.map((o) => o.id), ...userOptionIds]);
  const kept = [...new Set(ids)].filter((i) => valid.has(i));
  return d.selection === 'single' ? kept.slice(0, 1) : kept;
}
