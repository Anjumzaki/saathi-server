import { describe, expect, it } from 'vitest';
import { MongoRateStore, type HitModel } from '../src/middleware/mongoRateStore';

function fakeModel() {
  const rows = new Map<string, { hits: number; resetAt: Date }>();
  const m: HitModel = {
    async findOneAndUpdate(f, u) {
      const key = (f as { key: string }).key;
      const row = rows.get(key) ?? { hits: 0, resetAt: (u as { $setOnInsert: { resetAt: Date } }).$setOnInsert.resetAt };
      row.hits += 1; rows.set(key, row); return row;
    },
    async updateOne(f) { const r = rows.get((f as { key: string }).key); if (r && r.hits > 0) r.hits -= 1; },
    async deleteOne(f) { rows.delete((f as { key: string }).key); },
  };
  return { m, rows };
}

describe('plan-read limit kept in the database', () => {
  it('a second server process sees the same count, and a new hour starts from one', async () => {
    const { m } = fakeModel();
    let now = 10 * 3_600_000 + 5_000;
    const a = new MongoRateStore('ai-read', m, () => true, () => now);
    const b = new MongoRateStore('ai-read', m, () => true, () => now); // "another process" or "after a restart"
    expect((await a.increment('u1')).totalHits).toBe(1);
    expect((await b.increment('u1')).totalHits).toBe(2);
    expect((await b.increment('u2')).totalHits).toBe(1);
    await a.decrement('u1');
    expect((await a.increment('u1')).totalHits).toBe(2);
    now += 3_600_000;
    expect((await a.increment('u1')).totalHits).toBe(1);
  });

  it('still counts when the database is not connected', async () => {
    const s = new MongoRateStore('ai-read', fakeModel().m, () => false);
    await s.increment('u1');
    expect((await s.increment('u1')).totalHits).toBe(2);
    await s.resetKey('u1');
    expect((await s.increment('u1')).totalHits).toBe(1);
  });
});
