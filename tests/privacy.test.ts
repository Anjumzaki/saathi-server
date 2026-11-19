import { describe, expect, it } from 'vitest';
import { canCheer, inviteExpiry, isInviteValid, INVITE_TTL_MS } from '../src/services/partnerLogic';
import {
  redactCycle, serializePartnerView, serializePlanForDietitian, serializeRecordsForDietitian, type PartnerSnapshot, type SyncRecordLike,
} from '../src/services/serializers';

const perms = (o: Partial<Parameters<typeof serializePartnerView>[0]> = {}) => ({ effortRing: false, mealsLogged: false, waterWalk: false, weight: false, togetherNudgesOnly: false, ...o });
// A snapshot polluted with cycle data the serializer must never forward.
const snap = {
  date: '2026-03-01', effortRing: 0.8, streak: 5, mealsLoggedToday: true, waterMl: 1800, steps: 7000, weightKg: 60.5,
  togetherNudges: ['Walk together'],
  cycleDay: 14, periodStart: '2026-02-20', symptoms: ['cramps'], cycleRecords: [{ flow: 'heavy' }],
} as PartnerSnapshot;
const FORBIDDEN = /cycle|period|symptom|cramp|flow|menstru/i;

describe('partner view', () => {
  it('day-summary fields follow the same ticks: counts only, Together only when ticked and true', () => {
    const day = { ...snap, effort: 78, mealsDone: 4, mealsTotal: 5, waterCups: 6, waterTarget: 8, walkDone: true, weightGoalKg: 58, togetherTonight: true } as PartnerSnapshot;
    expect(serializePartnerView(perms(), day)).toEqual({ date: '2026-03-01' });
    expect(serializePartnerView(perms({ effortRing: true }), day)).toMatchObject({ effort: 78, streak: 5 });
    expect(serializePartnerView(perms({ mealsLogged: true }), day)).toMatchObject({ meals: { done: 4, total: 5 } });
    expect(serializePartnerView(perms({ waterWalk: true }), day)).toMatchObject({ waterCups: { done: 6, target: 8 }, walkDone: true });
    expect(serializePartnerView(perms({ weight: true }), day)).toMatchObject({ weightKg: 60.5, weightGoalKg: 58 });
    expect(serializePartnerView(perms({ effortRing: true }), day).togetherTonight).toBeUndefined();
    expect(serializePartnerView(perms({ together: true }), day)).toEqual({ date: '2026-03-01', togetherTonight: true });
    expect(JSON.stringify(serializePartnerView(perms({ effortRing: true, mealsLogged: true, waterWalk: true, weight: true, together: true }), day))).not.toMatch(FORBIDDEN);
  });

  it('shows nothing but the date when no permission is ticked', () => {
    expect(serializePartnerView(perms(), snap)).toEqual({ date: '2026-03-01' });
  });
  it('exposes only ticked permissions', () => {
    expect(serializePartnerView(perms({ effortRing: true }), snap)).toEqual({ date: '2026-03-01', effortRing: 0.8, streak: 5 });
    expect(serializePartnerView(perms({ mealsLogged: true }), snap)).toEqual({ date: '2026-03-01', mealsLoggedToday: true });
    expect(serializePartnerView(perms({ waterWalk: true }), snap)).toEqual({ date: '2026-03-01', water: { ml: 1800 }, walk: { steps: 7000 } });
    expect(serializePartnerView(perms({ weight: true }), snap)).toEqual({ date: '2026-03-01', weightKg: 60.5 });
  });
  it('together-nudges-only wins over every other permission', () => {
    const v = serializePartnerView(perms({ togetherNudgesOnly: true, effortRing: true, weight: true, waterWalk: true, mealsLogged: true }), snap);
    expect(v).toEqual({ date: '2026-03-01', togetherNudges: ['Walk together'] });
  });
  it('NEVER exposes cycle data, even with every permission on', () => {
    const v = serializePartnerView(perms({ effortRing: true, mealsLogged: true, waterWalk: true, weight: true }), snap);
    expect(JSON.stringify(v)).not.toMatch(FORBIDDEN);
    expect(Object.keys(v)).not.toContain('cycleDay');
  });
});

describe('dietitian serializers', () => {
  it('drops cycle plan items and cycle-looking keys', () => {
    const plan = serializePlanForDietitian({
      title: 'p',
      items: [
        { category: 'meal', title: 'Lunch' },
        { category: 'cycle', title: 'Track period' },
        { category: 'selfcare', title: 'Walk', cyclePhase: 'luteal', note: 'ok' },
      ],
    });
    expect(plan.items.map((i) => i['title'])).toEqual(['Lunch', 'Walk']);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN);
    expect(plan.items[1]).toMatchObject({ note: 'ok' });
  });
  it('excludes cycleRecords and settings collections entirely', () => {
    const rec = (collection: string, payload: Record<string, unknown>): SyncRecordLike => ({ collection, clientId: collection, updatedAt: new Date(), deleted: false, payload });
    const out = serializeRecordsForDietitian([
      rec('cycleRecords', { periodStart: '2026-01-01', symptoms: ['x'] }),
      rec('settings', { cycleLength: 28 }),
      rec('logs', { kind: 'meal', text: 'rice', symptom: 'bloating', cycleDay: 3 }),
      rec('planItems', { category: 'cycle', title: 'x' }),
      rec('metrics', { type: 'weight', kg: 60, periodNote: 'n' }),
    ]);
    expect(out.map((r) => r.collection).sort()).toEqual(['logs', 'metrics']);
    expect(JSON.stringify(out)).not.toMatch(FORBIDDEN);
    expect(out.find((r) => r.collection === 'logs')!.payload).toEqual({ kind: 'meal', text: 'rice' });
  });
  it('redactCycle works recursively and leaves primitives alone', () => {
    expect(redactCycle({ a: [{ ovulationDate: 1, b: 2 }], c: 'period' })).toEqual({ a: [{ b: 2 }], c: 'period' });
    expect(redactCycle(5)).toBe(5);
    expect(redactCycle(null)).toBeNull();
  });
});

describe('invites and cheers', () => {
  const now = new Date('2026-03-01T10:00:00Z');
  it('expire after 48 h', () => {
    expect(INVITE_TTL_MS).toBe(48 * 3_600_000);
    const exp = inviteExpiry(now);
    expect(isInviteValid(exp, new Date(now.getTime() + 47.9 * 3_600_000))).toBe(true);
    expect(isInviteValid(exp, new Date(now.getTime() + 48 * 3_600_000))).toBe(false);
  });
  it('allow one cheer per UTC day', () => {
    expect(canCheer(null, now)).toBe(true);
    expect(canCheer(new Date('2026-03-01T00:00:00Z'), now)).toBe(false);
    expect(canCheer(new Date('2026-02-28T23:59:59Z'), now)).toBe(true);
  });
});
