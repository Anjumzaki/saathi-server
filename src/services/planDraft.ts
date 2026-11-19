/** Turns whatever the AI returned into a safe plan draft. Pure: no network, so it is fully testable. */
import { CATEGORIES, planItemSchema, type PlanContent, type PlanItem } from '../schemas/plan';

const MEAL_KINDS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const RULE_SOURCES = ['DIETITIAN', 'SAATHI', 'OWN'] as const;

export interface NormalizedDraft extends PlanContent {
  title: string;
  warnings: string[];
}

/** Extract the first JSON object from model text (it may be wrapped in a ```json fence or have a sentence around it). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no_json');
  return JSON.parse(body.slice(start, end + 1));
}

/** "8", "8:5", "8am", "08:00", "8.30 pm", "20:00" -> "HH:MM" or undefined. */
export function toHhmm(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d{1,2})(?:[:.](\d{1,2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(v);
  if (!m) return undefined;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');

const CATEGORY_ALIASES: Record<string, (typeof CATEGORIES)[number]> = {
  food: 'meal', meals: 'meal', snack: 'meal', supplements: 'supplement', vitamin: 'supplement', medicine: 'supplement',
  exercise: 'movement', walk: 'movement', workout: 'movement', activity: 'movement', water: 'selfcare', hydration: 'selfcare',
};

/** Clean one item; returns null (with a reason) when it cannot be used. */
function cleanItem(raw: any, index: number): { item: PlanItem } | { skip: string } {
  if (!raw || typeof raw !== 'object') return { skip: `item ${index + 1} was not readable` };
  const title = clip(raw.title, 200);
  if (!title) return { skip: `item ${index + 1} had no title` };
  const catRaw = clip(raw.category, 30).toLowerCase();
  const category = (CATEGORIES as readonly string[]).includes(catRaw) ? (catRaw as (typeof CATEGORIES)[number]) : CATEGORY_ALIASES[catRaw] ?? 'meal';
  const days = Array.isArray(raw.daysOfWeek) ? [...new Set(raw.daysOfWeek.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))] as number[] : [];
  const options = Array.isArray(raw.options)
    ? raw.options.slice(0, 3).map((o: any, i: number) => ({ label: (['A', 'B', 'C'] as const)[i]!, text: clip(typeof o === 'string' ? o : o?.text, 500) })).filter((o: { text: string }) => o.text)
    : [];
  const mk = clip(raw.mealKind, 20).toLowerCase();
  const candidate = {
    key: clip(raw.key, 64) || `ai-${index + 1}`,
    category,
    title,
    time: toHhmm(raw.time),
    endTime: toHhmm(raw.endTime),
    daysOfWeek: days,
    tier: raw.tier === 'alarm' ? 'alarm' : 'notification',
    mealKind: category === 'meal' && (MEAL_KINDS as readonly string[]).includes(mk) ? mk : undefined,
    options,
    details: clip(raw.details, 2000) || undefined,
  };
  const parsed = planItemSchema.safeParse(candidate);
  return parsed.success ? { item: parsed.data } : { skip: `"${title}" could not be used` };
}

/** Normalise the parsed JSON into a draft: drop unusable items (with a warning), make keys unique, cap sizes. */
export function normalizeDraft(raw: unknown): NormalizedDraft {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const warnings: string[] = [];
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  (Array.isArray(o.items) ? o.items : []).slice(0, 200).forEach((r: unknown, i: number) => {
    const c = cleanItem(r, i);
    if ('skip' in c) return void warnings.push(`Skipped: ${c.skip}.`);
    let key = c.item.key; let n = 2;
    while (seen.has(key)) key = `${c.item.key}-${n++}`;
    seen.add(key);
    items.push({ ...c.item, key });
  });
  const rules = (Array.isArray(o.rules) ? o.rules : []).slice(0, 100).map((r: any, i: number) => {
    const text = clip(typeof r === 'string' ? r : r?.text, 500);
    const src = clip(r?.source, 12).toUpperCase();
    return text ? { id: clip(r?.id, 64) || `ai-rule-${i + 1}`, text, source: (RULE_SOURCES as readonly string[]).includes(src) ? (src as (typeof RULE_SOURCES)[number]) : 'DIETITIAN' } : null;
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  const recipes = (Array.isArray(o.recipes) ? o.recipes : []).slice(0, 100).map((r: any, i: number) => {
    const title = clip(r?.title, 200);
    if (!title) return null;
    const strs = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map(x => clip(x, max)).filter(Boolean).slice(0, n) : []);
    return { id: clip(r?.id, 64) || `ai-recipe-${i + 1}`, title, ingredients: strs(r?.ingredients, 200, 60), steps: strs(r?.steps, 1000, 40), notes: clip(r?.notes, 1000) || undefined };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!items.length) warnings.push('No meals or reminders could be found in this document.');
  const untimed = items.filter(i => !i.time).length;
  if (untimed) warnings.push(`${untimed} item${untimed === 1 ? ' has' : 's have'} no time. Please set a time before saving.`);
  const modelWarnings = (Array.isArray(o.warnings) ? o.warnings : []).map((w: unknown) => clip(w, 300)).filter(Boolean).slice(0, 10);
  return { title: clip(o.title, 200) || 'Imported plan', items, rules, recipes, warnings: [...modelWarnings, ...warnings] };
}
