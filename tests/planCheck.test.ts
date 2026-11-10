import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTEIN_KEYWORDS, checkPlan, containsKeyword, countMeals, dinnerToSleepMinutes, findDinner,
  longestMealGap, mainMealsMissingProtein, teaIronConflicts, type CheckItem,
} from '../src/services/planCheck';

const meal = (title: string, time: string, extra: Partial<CheckItem> = {}): CheckItem => ({ category: 'meal', title, time, ...extra });
const good: CheckItem[] = [
  meal('Breakfast', '08:00', { mealKind: 'breakfast', details: 'two eggs and toast' }),
  meal('Lunch', '13:00', { mealKind: 'lunch', details: 'dal, roti, salad' }),
  meal('Snack', '16:30', { mealKind: 'snack', details: 'fruit' }),
  meal('Dinner', '19:30', { mealKind: 'dinner', details: 'grilled chicken' }),
  { category: 'sleep', title: 'Bedtime', time: '23:00' },
];

describe('containsKeyword', () => {
  it('matches word starts only', () => {
    expect(containsKeyword('Veggie wrap', ['egg'])).toBe(false);
    expect(containsKeyword('Two Eggs on toast', ['egg'])).toBe(true);
    expect(containsKeyword('dahi with roti', ['dahi'])).toBe(true);
    expect(containsKeyword('anything', [''])).toBe(false);
  });
  it('supports non-Latin keywords and regex metacharacters', () => {
    expect(containsKeyword('دال اور روٹی', ['دال'])).toBe(true);
    expect(containsKeyword('c++ (test)', ['c++'])).toBe(true);
  });
});

describe('countMeals', () => {
  it('splits main meals and snacks', () => {
    expect(countMeals(good)).toEqual({ total: 4, main: 3, snacks: 1 });
    expect(countMeals([])).toEqual({ total: 0, main: 0, snacks: 0 });
  });
});

describe('longestMealGap', () => {
  it('finds the biggest in-day gap, ignoring unsorted input and overnight', () => {
    const g = longestMealGap([...good].reverse())!;
    expect(g.minutes).toBe(300); // 08:00 -> 13:00
    expect(g.from.title).toBe('Breakfast');
    expect(g.to.title).toBe('Lunch');
  });
  it('returns null with fewer than two timed meals', () => {
    expect(longestMealGap([meal('x', '08:00')])).toBeNull();
    expect(longestMealGap([meal('a', '08:00'), { category: 'meal', title: 'no time' }])).toBeNull();
  });
});

describe('protein per main meal', () => {
  it('flags main meals without a keyword but ignores snacks', () => {
    const items = [meal('Lunch', '13:00', { mealKind: 'lunch', details: 'rice and salad' }), meal('Snack', '16:00', { mealKind: 'snack', details: 'apple' })];
    const out = mainMealsMissingProtein(items, DEFAULT_PROTEIN_KEYWORDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.item.title).toBe('Lunch');
  });
  it('checks every A/B/C option', () => {
    const item = meal('Breakfast', '08:00', { mealKind: 'breakfast', options: [{ label: 'A', text: 'Omelette' }, { label: 'B', text: 'Plain toast' }, { label: 'C', text: 'Yogurt bowl' }] });
    // "Omelette" has no keyword; yogurt does
    const out = mainMealsMissingProtein([item], DEFAULT_PROTEIN_KEYWORDS);
    expect(out[0]!.missingOptions).toEqual(['A', 'B']);
  });
  it('uses the region keyword list passed in', () => {
    const item = meal('Lunch', '13:00', { details: 'lobia with roti' });
    expect(mainMealsMissingProtein([item], DEFAULT_PROTEIN_KEYWORDS)).toHaveLength(1);
    expect(mainMealsMissingProtein([item], ['lobia'])).toHaveLength(0);
  });
  it('treats meals without mealKind as main', () => {
    expect(mainMealsMissingProtein([meal('Meal', '12:00', { details: 'pasta' })], ['egg'])).toHaveLength(1);
  });
});

describe('tea vs iron spacing', () => {
  const iron = (time: string, extra: Partial<CheckItem> = {}): CheckItem => ({ category: 'supplement', title: 'Iron tablet', time, ...extra });
  const tea = (time: string, extra: Partial<CheckItem> = {}): CheckItem => ({ category: 'selfcare', title: 'Chai break', time, ...extra });
  it('flags tea less than 30 minutes from iron, in either direction', () => {
    expect(teaIronConflicts([iron('08:00'), tea('08:20')], 30)).toHaveLength(1);
    expect(teaIronConflicts([iron('08:20'), tea('08:00')], 30)).toHaveLength(1);
    expect(teaIronConflicts([iron('08:00'), tea('08:00')], 30)[0]!.gapMinutes).toBe(0);
  });
  it('accepts exactly 30 minutes and more', () => {
    expect(teaIronConflicts([iron('08:00'), tea('08:30')], 30)).toHaveLength(0);
    expect(teaIronConflicts([iron('08:00'), tea('11:00')], 30)).toHaveLength(0);
  });
  it('wraps around midnight', () => {
    expect(teaIronConflicts([iron('23:50'), tea('00:10')], 30)).toHaveLength(1);
  });
  it('ignores herbal tea and non-overlapping days', () => {
    expect(teaIronConflicts([iron('08:00'), tea('08:05', { title: 'Chamomile herbal tea' })], 30)).toHaveLength(0);
    expect(teaIronConflicts([iron('08:00', { daysOfWeek: [1] }), tea('08:05', { daysOfWeek: [2] })], 30)).toHaveLength(0);
    expect(teaIronConflicts([iron('08:00', { daysOfWeek: [1, 2] }), tea('08:05', { daysOfWeek: [2] })], 30)).toHaveLength(1);
  });
  it('detects tea and iron mentioned in details', () => {
    const items: CheckItem[] = [{ category: 'supplement', title: 'Supplement', time: '09:00', details: 'ferrous sulphate' }, meal('Breakfast', '09:10', { details: 'paratha with chai' })];
    expect(teaIronConflicts(items, 30)).toHaveLength(1);
  });
  it('skips untimed items', () => {
    expect(teaIronConflicts([{ category: 'supplement', title: 'Iron' }, tea('08:00')], 30)).toHaveLength(0);
  });
});

describe('dinner vs sleep', () => {
  it('finds tagged dinner or the last evening main meal', () => {
    expect(findDinner(good)!.title).toBe('Dinner');
    expect(findDinner([meal('Late meal', '20:00'), meal('Lunch', '13:00')])!.title).toBe('Late meal');
    expect(findDinner([meal('Lunch', '13:00')])).toBeNull();
  });
  it('computes minutes with midnight wrap', () => {
    expect(dinnerToSleepMinutes(meal('d', '19:30'), { category: 'sleep', title: 's', time: '23:00' })).toBe(210);
    expect(dinnerToSleepMinutes(meal('d', '23:00'), { category: 'sleep', title: 's', time: '00:30' })).toBe(90);
  });
});

describe('checkPlan', () => {
  it('returns a good verdict for a sound plan', () => {
    const r = checkPlan(good, { waterTargetMl: 2500 });
    expect(r.tweaks).toEqual([]);
    expect(r.verdict).toBe('good');
    expect(r.good.length).toBeGreaterThanOrEqual(4);
  });
  it('flags a single issue as tweaks', () => {
    const r = checkPlan(good, {});
    expect(r.verdict).toBe('tweaks');
    expect(r.tweaks.map((t) => t.id)).toEqual(['water-missing']);
    expect(r.tweaks[0]).toEqual(expect.objectContaining({ title: expect.any(String), detail: expect.any(String), suggestion: expect.any(String) }));
  });
  it('flags few meals, long gaps, missing protein, late dinner, and low water together', () => {
    const items: CheckItem[] = [
      meal('Breakfast', '07:00', { mealKind: 'breakfast', details: 'toast' }),
      meal('Dinner', '22:00', { mealKind: 'dinner', details: 'rice' }),
      { category: 'sleep', title: 'Bed', time: '23:00' },
    ];
    const r = checkPlan(items, { waterTargetMl: 800 });
    const ids = r.tweaks.map((t) => t.id);
    expect(ids).toContain('meal-count-low');
    expect(ids).toContain('meal-gap-long');
    expect(ids).toContain('dinner-late');
    expect(ids).toContain('water-low');
    expect(ids.filter((i) => i.startsWith('protein-'))).toHaveLength(2);
    expect(r.verdict).toBe('needs_work');
  });
  it('suggests a snack time inside the long gap', () => {
    const r = checkPlan([meal('A', '08:00', { details: 'egg' }), meal('B', '16:00', { details: 'egg' }), meal('C', '19:00', { details: 'egg' })], { waterTargetMl: 2000 });
    const t = r.tweaks.find((x) => x.id === 'meal-gap-long')!;
    expect(t.suggestion).toContain('12:00');
  });
  it('flags too many eating slots', () => {
    const items = Array.from({ length: 8 }, (_, i) => meal(`M${i}`, `${String(8 + i).padStart(2, '0')}:00`, { details: 'egg' }));
    expect(checkPlan(items, { waterTargetMl: 2000 }).tweaks.map((t) => t.id)).toContain('meal-count-high');
  });
  it('reports tea-iron conflicts and good note when spaced', () => {
    const base: CheckItem[] = [...good, { category: 'supplement', key: 'fe', title: 'Iron', time: '08:00' }];
    const bad = checkPlan([...base, { category: 'selfcare', key: 'tea', title: 'Tea', time: '08:10' }], { waterTargetMl: 2000 });
    expect(bad.tweaks.map((t) => t.id)).toContain('tea-iron-fe-tea');
    const ok = checkPlan([...base, { category: 'selfcare', title: 'Tea', time: '10:00' }], { waterTargetMl: 2000 });
    expect(ok.good).toContain('Tea and iron are spaced apart');
  });
  it('respects the day filter', () => {
    const items: CheckItem[] = [
      meal('Mon lunch', '13:00', { daysOfWeek: [1], details: 'egg' }),
      meal('Tue lunch', '13:00', { daysOfWeek: [2], details: 'rice' }),
    ];
    const mon = checkPlan(items, { day: 1, waterTargetMl: 2000 });
    expect(mon.tweaks.some((t) => t.id.startsWith('protein-'))).toBe(false);
    const tue = checkPlan(items, { day: 2, waterTargetMl: 2000 });
    expect(tue.tweaks.some((t) => t.id.startsWith('protein-'))).toBe(true);
  });
  it('handles an empty plan', () => {
    const r = checkPlan([], {});
    expect(r.tweaks.map((t) => t.id)).toEqual(['meal-count-low', 'water-missing']);
  });
  it('accepts water at exactly the minimum and honours config overrides', () => {
    expect(checkPlan(good, { waterTargetMl: 1500 }).tweaks).toEqual([]);
    expect(checkPlan(good, { waterTargetMl: 1500, minWaterMl: 2000 }).tweaks.map((t) => t.id)).toEqual(['water-low']);
    expect(checkPlan(good, { waterTargetMl: 2000, minDinnerToSleepMinutes: 300 }).tweaks.map((t) => t.id)).toEqual(['dinner-late']);
  });
});
