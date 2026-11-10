/**
 * Structural plan check. PURE functions only: no calorie counting, no nutrition database.
 * Everything is derived from the plan-as-data (times, categories, keywords).
 */
import { formatHHMM, parseHHMM } from '../utils/time';

export interface CheckOption {
  label: string;
  text: string;
}
export interface CheckItem {
  key?: string;
  category: 'meal' | 'supplement' | 'movement' | 'selfcare' | 'cycle' | 'sleep';
  title: string;
  time?: string | undefined;
  endTime?: string | undefined;
  daysOfWeek?: number[] | undefined;
  mealKind?: 'breakfast' | 'lunch' | 'dinner' | 'snack' | undefined;
  options?: CheckOption[] | undefined;
  details?: string | undefined;
}

export interface CheckConfig {
  minMeals: number;
  maxMeals: number;
  maxGapMinutes: number;
  minTeaIronGapMinutes: number;
  minDinnerToSleepMinutes: number;
  minWaterMl: number;
  proteinKeywords: string[];
  waterTargetMl?: number | null | undefined;
  /** Optional weekday (0-6): only items that occur that day are checked. */
  day?: number | undefined;
}

export const DEFAULT_PROTEIN_KEYWORDS = [
  'egg', 'chicken', 'fish', 'meat', 'mutton', 'beef', 'paneer', 'tofu', 'dal', 'lentil', 'chickpea',
  'chana', 'beans', 'yogurt', 'yoghurt', 'curd', 'dahi', 'milk', 'cheese', 'whey', 'protein', 'tuna',
  'salmon', 'turkey', 'soy', 'tempeh', 'nuts', 'hummus',
];

export const DEFAULT_CHECK_CONFIG: Omit<CheckConfig, 'waterTargetMl' | 'day'> = {
  minMeals: 3,
  maxMeals: 6,
  maxGapMinutes: 300,
  minTeaIronGapMinutes: 30,
  minDinnerToSleepMinutes: 120,
  minWaterMl: 1500,
  proteinKeywords: DEFAULT_PROTEIN_KEYWORDS,
};

export interface Tweak {
  id: string;
  title: string;
  detail: string;
  suggestion: string;
}
export type Verdict = 'good' | 'tweaks' | 'needs_work';
export interface CheckResult {
  verdict: Verdict;
  tweaks: Tweak[];
  good: string[];
}

// ---------- helpers ----------

export function daysOverlap(a?: number[], b?: number[]): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return true;
  return a.some((d) => b.includes(d));
}

export function itemsForDay(items: CheckItem[], day?: number): CheckItem[] {
  if (day === undefined) return items;
  return items.filter((i) => !i.daysOfWeek || i.daysOfWeek.length === 0 || i.daysOfWeek.includes(day));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keyword match at a word start (so "egg" does not match "veggie"); plural/suffix forms still match. */
export function containsKeyword(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  return keywords.some((k) => {
    const kw = k.trim().toLowerCase();
    return kw.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(kw)}`, 'u').test(t);
  });
}

const textOf = (i: CheckItem) => [i.title, i.details ?? '', ...(i.options ?? []).map((o) => o.text)].join(' \n ');

interface TimedMeal {
  item: CheckItem;
  minutes: number;
}

export function timedMeals(items: CheckItem[]): TimedMeal[] {
  return items
    .filter((i) => i.category === 'meal')
    .map((item) => ({ item, minutes: parseHHMM(item.time) }))
    .filter((m): m is TimedMeal => m.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes);
}

const isMain = (i: CheckItem) => i.mealKind !== 'snack';

// ---------- individual checks ----------

export function countMeals(items: CheckItem[]): { total: number; main: number; snacks: number } {
  const meals = items.filter((i) => i.category === 'meal');
  const snacks = meals.filter((m) => m.mealKind === 'snack').length;
  return { total: meals.length, main: meals.length - snacks, snacks };
}

/** Longest gap between consecutive meals within a day (overnight fast is intentionally excluded). */
export function longestMealGap(items: CheckItem[]): { minutes: number; from: CheckItem; to: CheckItem } | null {
  const meals = timedMeals(items);
  let best: { minutes: number; from: CheckItem; to: CheckItem } | null = null;
  for (let i = 1; i < meals.length; i++) {
    const prev = meals[i - 1]!;
    const cur = meals[i]!;
    const minutes = cur.minutes - prev.minutes;
    if (!best || minutes > best.minutes) best = { minutes, from: prev.item, to: cur.item };
  }
  return best;
}

/** Main meals where the protein keyword is missing; with A/B/C options, lists the options that lack it. */
export function mainMealsMissingProtein(
  items: CheckItem[],
  keywords: string[],
): { item: CheckItem; missingOptions: string[] }[] {
  const out: { item: CheckItem; missingOptions: string[] }[] = [];
  for (const item of items) {
    if (item.category !== 'meal' || !isMain(item)) continue;
    const opts = item.options ?? [];
    if (opts.length > 0) {
      const base = `${item.title} ${item.details ?? ''}`;
      const missing = opts.filter((o) => !containsKeyword(`${base} ${o.text}`, keywords)).map((o) => o.label);
      if (missing.length > 0) out.push({ item, missingOptions: missing });
    } else if (!containsKeyword(textOf(item), keywords)) {
      out.push({ item, missingOptions: [] });
    }
  }
  return out;
}

const TEA_RE = /(?<![\p{L}])(tea|chai)(?![\p{L}])/iu;
const HERBAL_RE = /(herbal|chamomile|peppermint|rooibos|fennel|mint tea|ginger tea)/i;
const IRON_RE = /(?<![\p{L}])(iron|ferrous|ferric|ferrograd\w*|ferrosan\w*)(?![\p{L}])/iu;

export const isTeaItem = (i: CheckItem) => {
  const t = textOf(i);
  return TEA_RE.test(t) && !HERBAL_RE.test(t);
};
export const isIronItem = (i: CheckItem) => i.category !== 'sleep' && IRON_RE.test(textOf(i));

/** Pairs of (tea, iron) items closer than `minGapMinutes` on a shared day. */
export function teaIronConflicts(
  items: CheckItem[],
  minGapMinutes: number,
): { tea: CheckItem; iron: CheckItem; gapMinutes: number }[] {
  const out: { tea: CheckItem; iron: CheckItem; gapMinutes: number }[] = [];
  const tea = items.filter((i) => isTeaItem(i) && parseHHMM(i.time) !== null);
  const iron = items.filter((i) => isIronItem(i) && parseHHMM(i.time) !== null);
  for (const t of tea) {
    for (const f of iron) {
      if (!daysOverlap(t.daysOfWeek, f.daysOfWeek)) continue;
      const gap = Math.abs(parseHHMM(t.time)! - parseHHMM(f.time)!);
      const wrapped = Math.min(gap, 1440 - gap);
      if (wrapped < minGapMinutes) out.push({ tea: t, iron: f, gapMinutes: wrapped });
    }
  }
  return out;
}

/** Dinner = meal tagged dinner, else the last main meal that is at/after 17:00. */
export function findDinner(items: CheckItem[]): CheckItem | null {
  const meals = timedMeals(items);
  const tagged = meals.filter((m) => m.item.mealKind === 'dinner');
  if (tagged.length) return tagged[tagged.length - 1]!.item;
  const mains = meals.filter((m) => isMain(m.item) && m.minutes >= 17 * 60);
  return mains.length ? mains[mains.length - 1]!.item : null;
}

export function findSleep(items: CheckItem[]): CheckItem | null {
  return items.find((i) => i.category === 'sleep' && parseHHMM(i.time) !== null) ?? null;
}

/** Minutes from dinner to sleep, wrapping past midnight. */
export function dinnerToSleepMinutes(dinner: CheckItem, sleep: CheckItem): number {
  return (parseHHMM(sleep.time)! - parseHHMM(dinner.time)! + 1440) % 1440;
}

// ---------- orchestration ----------

export function checkPlan(allItems: CheckItem[], partial: Partial<CheckConfig> = {}): CheckResult {
  const cfg: CheckConfig = { ...DEFAULT_CHECK_CONFIG, ...partial };
  const items = itemsForDay(allItems, cfg.day);
  const tweaks: Tweak[] = [];
  const good: string[] = [];

  // 1. meal count
  const counts = countMeals(items);
  if (counts.total < cfg.minMeals) {
    tweaks.push({
      id: 'meal-count-low',
      title: 'Few meals planned',
      detail: `Only ${counts.total} meal${counts.total === 1 ? '' : 's'} planned; ${cfg.minMeals} or more is steadier.`,
      suggestion: 'Add a meal or a small snack so the day is spread out.',
    });
  } else if (counts.total > cfg.maxMeals) {
    tweaks.push({
      id: 'meal-count-high',
      title: 'Many eating slots',
      detail: `${counts.total} meals/snacks planned; more than ${cfg.maxMeals} can be hard to keep up.`,
      suggestion: 'Merge a snack into a nearby meal.',
    });
  } else {
    good.push(`${counts.main} main meal${counts.main === 1 ? '' : 's'}${counts.snacks ? ` and ${counts.snacks} snack${counts.snacks === 1 ? '' : 's'}` : ''} planned`);
  }

  // 2. longest gap
  const gap = longestMealGap(items);
  if (gap) {
    if (gap.minutes > cfg.maxGapMinutes) {
      const mid = formatHHMM(parseHHMM(gap.from.time)! + gap.minutes / 2);
      tweaks.push({
        id: 'meal-gap-long',
        title: 'Long gap between meals',
        detail: `${(gap.minutes / 60).toFixed(1)} h between "${gap.from.title}" and "${gap.to.title}" (limit ${(cfg.maxGapMinutes / 60).toFixed(1)} h).`,
        suggestion: `Add a light snack around ${mid}.`,
      });
    } else {
      good.push(`Longest gap between meals is ${(gap.minutes / 60).toFixed(1)} h`);
    }
  }

  // 3. protein at each main meal
  const mains = items.filter((i) => i.category === 'meal' && isMain(i));
  const missing = mainMealsMissingProtein(items, cfg.proteinKeywords);
  for (const m of missing) {
    const where = m.missingOptions.length ? ` (options ${m.missingOptions.join(', ')})` : '';
    tweaks.push({
      id: `protein-${m.item.key ?? m.item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: `No protein source at ${m.item.title}`,
      detail: `No protein-source keyword found${where}.`,
      suggestion: 'Add a protein source (for example eggs, dal, yogurt, chicken or paneer) to this meal.',
    });
  }
  if (mains.length > 0 && missing.length === 0) good.push('Every main meal has a protein source');

  // 4. tea vs iron
  const conflicts = teaIronConflicts(items, cfg.minTeaIronGapMinutes);
  for (const c of conflicts) {
    tweaks.push({
      id: `tea-iron-${c.iron.key ?? 'iron'}-${c.tea.key ?? 'tea'}`,
      title: 'Tea too close to iron',
      detail: `"${c.tea.title}" and "${c.iron.title}" are ${c.gapMinutes} min apart; at least ${cfg.minTeaIronGapMinutes} min helps iron absorb.`,
      suggestion: `Move tea at least ${cfg.minTeaIronGapMinutes} minutes away from the iron.`,
    });
  }
  if (conflicts.length === 0 && items.some(isIronItem) && items.some(isTeaItem)) good.push('Tea and iron are spaced apart');

  // 5. dinner vs sleep
  const dinner = findDinner(items);
  const sleep = findSleep(items);
  if (dinner && sleep) {
    const diff = dinnerToSleepMinutes(dinner, sleep);
    if (diff < cfg.minDinnerToSleepMinutes) {
      tweaks.push({
        id: 'dinner-late',
        title: 'Dinner close to bedtime',
        detail: `Dinner at ${dinner.time} is only ${diff} min before sleep at ${sleep.time}; aim for ${cfg.minDinnerToSleepMinutes / 60} h or more.`,
        suggestion: `Move dinner to ${formatHHMM(parseHHMM(sleep.time)! - cfg.minDinnerToSleepMinutes)} or earlier.`,
      });
    } else {
      good.push(`Dinner is ${(diff / 60).toFixed(1)} h before sleep`);
    }
  }

  // 6. water
  const w = cfg.waterTargetMl;
  if (w === undefined || w === null || w <= 0) {
    tweaks.push({
      id: 'water-missing',
      title: 'No water target',
      detail: 'The plan has no daily water target.',
      suggestion: `Set a daily water target of at least ${cfg.minWaterMl} ml.`,
    });
  } else if (w < cfg.minWaterMl) {
    tweaks.push({
      id: 'water-low',
      title: 'Water target is low',
      detail: `Target is ${w} ml; at least ${cfg.minWaterMl} ml is suggested.`,
      suggestion: `Raise the daily water target to ${cfg.minWaterMl} ml or more.`,
    });
  } else {
    good.push(`Water target of ${w} ml`);
  }

  const verdict: Verdict = tweaks.length === 0 ? 'good' : tweaks.length <= 2 ? 'tweaks' : 'needs_work';
  return { verdict, tweaks, good };
}
