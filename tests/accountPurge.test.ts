import { describe, expect, it } from 'vitest';
import {
  PURGE_AFTER_DAYS, type PurgeColl, type PurgeOps, purgeCutoff, purgeDeletedAccounts, purgePlan,
} from '../src/services/accountPurge';
import { planProfileSchema } from '../src/schemas/plan';

const HER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';
const DIETITIAN = '507f1f77bcf86cd799439013';
const FRESH = '507f1f77bcf86cd799439014';
const NOW = new Date('2026-11-27T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3_600_000);

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

/**
 * Enough of a query engine for the filters the purge actually uses, so a test can watch rows disappear
 * instead of trusting a mock that was told what to say. Ids are compared as strings, which is what
 * Mongo's casting amounts to here.
 */
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return (want as Row[]).some((f) => matches(row, f));
    const have = row[key];
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      const op = want as Row;
      if ('$in' in op) return (op['$in'] as unknown[]).map(String).includes(String(have));
      if ('$regex' in op) return new RegExp(String(op['$regex'])).test(String(have ?? ''));
      if ('$ne' in op && String(have) === String(op['$ne'])) return false;
      if ('$lte' in op) return have instanceof Date && have <= (op['$lte'] as Date);
      if ('$ne' in op) return true;
    }
    return String(have) === String(want);
  });
}

function applyUpdate(row: Row, update: Row): void {
  for (const [k, v] of Object.entries((update['$set'] ?? {}) as Row)) row[k] = v;
  for (const k of Object.keys((update['$unset'] ?? {}) as Row)) delete row[k];
  for (const [k, cond] of Object.entries((update['$pull'] ?? {}) as Row)) {
    if (Array.isArray(row[k])) row[k] = (row[k] as Row[]).filter((e) => !matches(e, cond as Row));
  }
}

function seed(): Db {
  return {
    User: [
      { _id: HER, deletedAt: daysAgo(40), passwordHash: 'scrypt$her', emailVerifiedAt: daysAgo(400), roles: ['client'], purgedAt: null },
      { _id: FRESH, deletedAt: daysAgo(5), passwordHash: 'scrypt$fresh', roles: ['client'], purgedAt: null },
      { _id: OTHER, deletedAt: null, passwordHash: 'scrypt$other', roles: ['client'], purgedAt: null },
    ],
    SyncRecord: [
      { userId: HER, coll: 'cycleRecords', payload: { periodStart: '2026-10-01', symptoms: ['cramps'] } },
      { userId: HER, coll: 'metrics', payload: { kg: 61 } },
      { userId: FRESH, coll: 'cycleRecords', payload: { periodStart: '2026-11-01' } },
      { userId: OTHER, coll: 'logs', payload: {} },
    ],
    Plan: [{ userId: HER }, { userId: FRESH }, { userId: OTHER, dietitianId: HER }],
    DaySummary: [{ userId: HER, date: '2026-10-01' }, { userId: HER, date: '2026-10-02' }, { userId: OTHER, date: '2026-10-01' }],
    DeviceToken: [{ userId: HER, token: 'fcm-her' }, { userId: OTHER, token: 'fcm-other' }],
    UserOption: [{ userId: HER, label: 'Nani ka paratha' }, { userId: OTHER, label: 'Sheer khurma' }],
    RefreshToken: [{ userId: HER }, { userId: OTHER }],
    Otp: [
      { key: `phone:${HER}:+971500000001` },
      { key: `email-change:${HER}:new@example.com` },
      { key: `phone:${OTHER}:+971500000002` },
    ],
    Cheer: [
      { fromUserId: HER, toUserId: OTHER },
      { fromUserId: OTHER, toUserId: HER },
      { fromUserId: OTHER, toUserId: DIETITIAN },
    ],
    PartnerShare: [
      { _id: 'share-hers', ownerId: HER, partnerId: OTHER, inviteTokenHash: 'h1', status: 'active' },
      { _id: 'share-others', ownerId: OTHER, partnerId: HER, inviteTokenHash: 'h2', status: 'active', acceptedAt: daysAgo(90), previewEndsAt: daysAgo(87) },
    ],
    Thread: [
      { _id: 'thread-hers', kind: 'order', clientId: HER, dietitianId: DIETITIAN, offeredSlots: [] },
      {
        _id: 'thread-others', kind: 'order', clientId: OTHER, dietitianId: HER,
        offeredSlots: [{ offeredBy: HER, taken: false }, { offeredBy: OTHER, taken: true }],
      },
    ],
    Message: [
      { threadId: 'thread-hers', senderId: HER, text: 'I bled for nine days this month' },
      { threadId: 'thread-hers', senderId: HER, type: 'photo', photoRef: 'threads/her/bloating.jpg' },
      { threadId: 'thread-hers', senderId: DIETITIAN, text: 'Lets add iron' },
      { threadId: 'thread-others', senderId: HER, text: 'Here is your plan' },
      { threadId: 'thread-others', senderId: OTHER, text: 'Thank you' },
    ],
    CallBooking: [
      { clientId: HER, dietitianId: DIETITIAN, status: 'completed', phone: '+971500000001' },
      { clientId: OTHER, dietitianId: HER, status: 'completed', phone: '+971500000002' },
    ],
    Order: [
      { _id: 'order-hers', clientId: HER, dietitianId: DIETITIAN, status: 'released', pricePaid: 15000, currency: 'AED', purchaseToken: 'play-token-her', settlement: { dietitian: 10200 } },
      { _id: 'order-she-delivered', clientId: OTHER, dietitianId: HER, status: 'released', pricePaid: 15000, purchaseToken: 'play-token-other', settlement: { dietitian: 10200 } },
    ],
    StoreEvent: [
      { userId: HER, provider: 'google_play', eventId: 'e1', purchaseToken: 'play-token-her', originalTransactionId: 'otx', statusAfter: 'active' },
      { userId: OTHER, provider: 'google_play', eventId: 'e2', purchaseToken: 'play-token-other' },
    ],
    DietitianProfile: [{ userId: HER, photoRef: 'dietitians/her/face.jpg', documents: [{ ref: 'dietitians/her/licence.jpg' }, { ref: 'purged' }] }],
  };
}

function ops(db: Db): PurgeOps & { removed: string[] } {
  const rows = (coll: PurgeColl) => (db[coll] ??= []);
  const removed: string[] = [];
  return {
    removed,
    async dueAccounts(cutoff, limit) {
      return rows('User')
        .filter((u) => matches(u, { deletedAt: { $ne: null, $lte: cutoff }, purgedAt: null }))
        .slice(0, limit)
        .map((u) => String(u['_id']));
    },
    async ids(coll, filter) {
      return rows(coll).filter((r) => matches(r, filter)).map((r) => String(r['_id']));
    },
    async deleteMany(coll, filter) {
      const keep = rows(coll).filter((r) => !matches(r, filter));
      const n = rows(coll).length - keep.length;
      db[coll] = keep;
      return n;
    },
    async updateMany(coll, filter, update) {
      // Counts rows it actually changed, which is what Mongo's modifiedCount means: a step that runs
      // twice must report nothing the second time.
      let changed = 0;
      for (const r of rows(coll).filter((x) => matches(x, filter))) {
        const before = JSON.stringify(r);
        applyUpdate(r, update);
        if (JSON.stringify(r) !== before) changed++;
      }
      return changed;
    },
    async storedFiles(userId, threadIds) {
      const p = rows('DietitianProfile').find((r) => String(r['userId']) === userId);
      const refs = [
        ...((p?.['documents'] ?? []) as { ref?: string }[]).map((d) => d.ref),
        p?.['photoRef'] as string | undefined,
        ...rows('Message')
          .filter((m) => String(m['senderId']) === userId || threadIds.includes(String(m['threadId'])))
          .map((m) => m['photoRef'] as string | undefined),
      ];
      return [...new Set(refs.filter((r): r is string => !!r && r !== 'purged'))];
    },
    async removeFile(ref) {
      removed.push(ref);
    },
  };
}

/** Every id in the database, so "nothing of hers is left" can be asserted rather than listed. */
const mentions = (db: Db, id: string): string[] => {
  const out: string[] = [];
  for (const [coll, rs] of Object.entries(db)) {
    for (const r of rs) {
      for (const [k, v] of Object.entries(r)) {
        if (JSON.stringify(v ?? null).includes(id)) out.push(`${coll}.${k}`);
      }
    }
  }
  return [...new Set(out)].sort();
};

describe('the thirty days', () => {
  it('is the window the privacy page promises', () => {
    expect(PURGE_AFTER_DAYS).toBe(30);
    expect(purgeCutoff(NOW)).toEqual(daysAgo(30));
  });

  it('leaves an account still inside the window completely alone', async () => {
    const db = seed();
    const o = ops(db);
    const res = await purgeDeletedAccounts(o, { now: NOW });
    expect(res.accounts).toBe(1); // her, not FRESH
    expect(db['SyncRecord']!.filter((r) => String(r['userId']) === FRESH)).toHaveLength(1);
    expect(db['Plan']!.some((r) => String(r['userId']) === FRESH)).toBe(true);
    expect(db['User']!.find((u) => String(u['_id']) === FRESH)).toMatchObject({ passwordHash: 'scrypt$fresh' });
  });

  it('takes a live account for nothing', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(db['User']!.find((u) => String(u['_id']) === OTHER)).toMatchObject({ passwordHash: 'scrypt$other', roles: ['client'] });
  });
});

describe('what the purge erases', () => {
  it('empties every collection keyed on her, including the three nothing used to touch', async () => {
    const db = seed();
    const res = await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(res.failed).toBe(0);
    for (const coll of ['SyncRecord', 'Plan', 'DaySummary', 'DeviceToken', 'UserOption', 'RefreshToken'] as const) {
      expect(db[coll]!.filter((r) => String(r['userId']) === HER), coll).toHaveLength(0);
    }
    // The ones DELETE /me never cleared at all.
    expect(res.counts['daySummaries']).toBe(2);
    expect(res.counts['deviceTokens']).toBe(1);
    expect(res.counts['ownDatasetOptions']).toBe(1);
    expect(db['Otp']!.map((r) => r['key'])).toEqual([`phone:${OTHER}:+971500000002`]);
    expect(db['Cheer']).toEqual([{ fromUserId: OTHER, toUserId: DIETITIAN }]);
    expect(db['CallBooking']!.filter((r) => String(r['clientId']) === HER)).toHaveLength(0);
  });

  it('deletes her stored files - licence, profile photo, chat photo - and skips one already purged', async () => {
    const db = seed();
    const o = ops(db);
    const res = await purgeDeletedAccounts(o, { now: NOW });
    expect(o.removed.sort()).toEqual(['dietitians/her/face.jpg', 'dietitians/her/licence.jpg', 'threads/her/bloating.jpg']);
    expect(res.files).toBe(3);
    expect(db['DietitianProfile']).toHaveLength(0);
  });

  it('leaves nothing that could name her or sign her in', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    const u = db['User']!.find((x) => String(x['_id']) === HER)!;
    expect(u['passwordHash']).toBeUndefined();
    expect(u['email']).toBeUndefined();
    expect(u['emailVerifiedAt']).toBeUndefined();
    expect(u['roles']).toEqual([]);
    expect(u['purgedAt']).toBeInstanceOf(Date);
    // The whole chat she ever had, both sides of it.
    expect(JSON.stringify(db)).not.toContain('bled for nine days');
    expect(JSON.stringify(db)).not.toContain('Nani ka paratha');
  });

  it('leaves her id only where a record has to survive', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(mentions(db, HER)).toEqual([
      'CallBooking.dietitianId', // another woman's call, with her as the dietitian
      'Order.clientId', // her own order, kept for the dietitian and for tax
      'Order.dietitianId', // the order she delivered
      'Plan.dietitianId', // the plan she wrote for another woman
      'User._id', // the empty marker those three point at
    ]);
  });
});

describe('two-sided rows', () => {
  it('detaches her from a share another woman owns instead of deleting it', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(db['PartnerShare']).toHaveLength(1);
    const share = db['PartnerShare']![0]!;
    expect(String(share['_id'])).toBe('share-others');
    expect(String(share['ownerId'])).toBe(OTHER);
    expect(share['partnerId']).toBeNull();
    expect(share['status']).toBe('revoked');
    expect(share['inviteTokenHash']).toBeNull();
    expect(share['acceptedAt']).toBeUndefined();
  });

  it('keeps the thread of a woman she was the dietitian for, minus her', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(db['Thread']).toHaveLength(1);
    const t = db['Thread']![0]!;
    expect(String(t['_id'])).toBe('thread-others');
    expect(t['dietitianId']).toBeNull();
    expect(t['offeredSlots']).toEqual([{ offeredBy: OTHER, taken: true }]);
    // The client's own messages stay; everything she wrote in that thread goes.
    expect(db['Message']).toEqual([{ threadId: 'thread-others', senderId: OTHER, text: 'Thank you' }]);
    expect(JSON.stringify(db)).not.toContain('bloating.jpg');
  });

  it('keeps the dietitian record of an order she delivered untouched', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    const delivered = db['Order']!.find((o) => String(o['_id']) === 'order-she-delivered')!;
    expect(delivered).toMatchObject({ clientId: OTHER, dietitianId: HER, pricePaid: 15000, purchaseToken: 'play-token-other' });
  });

  it('keeps the order she bought for the dietitian and for tax, with the store credential gone', async () => {
    const db = seed();
    await purgeDeletedAccounts(ops(db), { now: NOW });
    const bought = db['Order']!.find((o) => String(o['_id']) === 'order-hers')!;
    expect(bought).toMatchObject({ dietitianId: DIETITIAN, pricePaid: 15000, currency: 'AED', settlement: { dietitian: 10200 } });
    expect(bought['purchaseToken']).toBeUndefined();
    const ev = db['StoreEvent']!.find((e) => e['eventId'] === 'e1')!;
    expect(ev).toMatchObject({ provider: 'google_play', statusAfter: 'active', userId: null });
    expect(ev['purchaseToken']).toBeUndefined();
    expect(ev['originalTransactionId']).toBeUndefined();
  });
});

describe('a run that has to be repeated', () => {
  it('finds nothing the second time, and changes nothing', async () => {
    const db = seed();
    const first = await purgeDeletedAccounts(ops(db), { now: NOW });
    const after = JSON.stringify(db);
    const second = await purgeDeletedAccounts(ops(db), { now: NOW });
    expect(first.accounts).toBe(1);
    expect(second.accounts).toBe(0);
    expect(second.counts).toEqual({});
    expect(JSON.stringify(db)).toBe(after);
  });

  it('re-purging the same account by hand is also a no-op', async () => {
    const db = seed();
    const o = ops(db);
    await purgeDeletedAccounts(o, { now: NOW });
    // The marker is what stops the sweep, so clear it and run the steps again.
    db['User']!.find((u) => String(u['_id']) === HER)!['purgedAt'] = null;
    const again = await purgeDeletedAccounts(o, { now: NOW });
    expect(again.accounts).toBe(1);
    // Only the account row is written again (a fresh purgedAt); every other step finds nothing left.
    expect(Object.entries(again.counts).filter(([, n]) => n > 0)).toEqual([['account', 1]]);
  });

  it('leaves an account due when one of its steps throws', async () => {
    const db = seed();
    const o = ops(db);
    const broken: PurgeOps = { ...o, deleteMany: async (coll, f) => { if (coll === 'DaySummary') throw new Error('mongo went away'); return o.deleteMany(coll, f); } };
    const res = await purgeDeletedAccounts(broken, { now: NOW });
    expect(res).toMatchObject({ accounts: 0, failed: 1 });
    expect(db['User']!.find((u) => String(u['_id']) === HER)!['purgedAt']).toBeNull();
    // And the next, working run finishes the job.
    expect((await purgeDeletedAccounts(o, { now: NOW })).accounts).toBe(1);
  });

  it('runs in batches so one run is bounded', async () => {
    const db = seed();
    db['User']!.push({ _id: '507f1f77bcf86cd79943901a', deletedAt: daysAgo(60), purgedAt: null });
    const res = await purgeDeletedAccounts(ops(db), { now: NOW, limit: 1 });
    expect(res.accounts).toBe(1);
  });
});

describe('the plan itself', () => {
  it('covers every collection keyed on a user', () => {
    const colls = new Set(purgePlan(HER).map((s) => s.coll));
    for (const c of ['SyncRecord', 'Plan', 'DaySummary', 'DeviceToken', 'UserOption', 'RefreshToken', 'Otp',
      'Cheer', 'PartnerShare', 'Thread', 'Message', 'CallBooking', 'Order', 'StoreEvent', 'DietitianProfile', 'User'] as const) {
      expect(colls.has(c), c).toBe(true);
    }
  });
  it('says why, wherever a row survives', () => {
    for (const s of purgePlan(HER).filter((x) => x.op === 'anonymise')) {
      expect(s.keeps, s.name).toBeTruthy();
      expect(s.update, s.name).toBeTruthy();
    }
  });
  it('writes the account row last, so a failure leaves it due', () => {
    const steps = purgePlan(HER);
    expect(steps[steps.length - 1]!.name).toBe('account');
  });
});

describe('the age floor', () => {
  const body = (patch: Record<string, unknown>) => planProfileSchema.safeParse({ ...patch });

  it('refuses a child, and an adult goes through', () => {
    expect(body({ age: 17 }).success).toBe(false);
    expect(body({ age: 13 }).success).toBe(false);
    expect(body({ age: 18 }).success).toBe(true);
    expect(body({ age: 34 }).success).toBe(true);
  });

  it('refuses body numbers that could only be a child', () => {
    expect(body({ heightCm: 80 }).success).toBe(false);
    expect(body({ heightCm: 150 }).success).toBe(true);
    expect(body({ weightKg: 25 }).success).toBe(false);
    expect(body({ weightKg: 48 }).success).toBe(true);
    expect(body({ weightGoalKg: 25 }).success).toBe(false);
  });
});
