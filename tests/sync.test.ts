import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_MS, clampUpdatedAt, dedupeBatch, incomingWins, payloadFor } from '../src/services/syncLogic';

const d = (s: string) => new Date(s);

describe('last-write-wins', () => {
  it('newer incoming wins, older and equal lose', () => {
    expect(incomingWins(d('2026-01-01T00:00:00Z'), d('2026-01-01T00:00:01Z'))).toBe(true);
    expect(incomingWins(d('2026-01-01T00:00:01Z'), d('2026-01-01T00:00:00Z'))).toBe(false);
    expect(incomingWins(d('2026-01-01T00:00:00Z'), d('2026-01-01T00:00:00Z'))).toBe(false);
  });
  it('anything beats a missing record', () => {
    expect(incomingWins(null, d('2020-01-01'))).toBe(true);
    expect(incomingWins(undefined, d('2020-01-01'))).toBe(true);
  });
});

describe('clampUpdatedAt', () => {
  const now = d('2026-01-01T12:00:00Z');
  it('leaves sane timestamps alone', () => {
    const t = d('2026-01-01T11:00:00Z');
    expect(clampUpdatedAt(t, now)).toBe(t);
  });
  it('clamps far-future clocks to now + tolerance', () => {
    expect(clampUpdatedAt(d('2030-01-01T00:00:00Z'), now).getTime()).toBe(now.getTime() + MAX_CLOCK_SKEW_MS);
  });
});

describe('dedupeBatch', () => {
  it('keeps the newest per collection+clientId and distinguishes collections', () => {
    const out = dedupeBatch([
      { collection: 'logs', clientId: 'a', updatedAt: d('2026-01-01T00:00:02Z'), v: 'new' },
      { collection: 'logs', clientId: 'a', updatedAt: d('2026-01-01T00:00:01Z'), v: 'old' },
      { collection: 'metrics', clientId: 'a', updatedAt: d('2026-01-01T00:00:00Z'), v: 'other' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.collection === 'logs')!.v).toBe('new');
  });
});

describe('payloadFor', () => {
  it('drops payload for tombstones', () => {
    expect(payloadFor({ collection: 'logs', clientId: 'a', updatedAt: new Date(), deleted: true, payload: { x: 1 } })).toEqual({});
    expect(payloadFor({ collection: 'logs', clientId: 'a', updatedAt: new Date(), deleted: false, payload: { x: 1 } })).toEqual({ x: 1 });
  });
});
