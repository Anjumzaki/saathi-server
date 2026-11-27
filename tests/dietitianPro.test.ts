import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENTS, canAddDocument, canEditProfile, documentView, liveDocuments, profileCompleteness,
  proProfileSchema, reviewHeadline, reviewStateOf, submitBlock, tidyProfile, unknownBands,
} from '../src/services/dietitianProfile';
import { PAYOUT_NOTE, summariseEarnings } from '../src/services/dietitianEarnings';
import { reviewPlanForPublish, publishRefusal } from '../src/services/dietitianPublish';
import { clientOrderView, dueLine } from '../src/services/dietitianClients';
import {
  checkUpload, dietitianScope, isSafeKey, keyBelongsTo, keyScope, localDiskFileStore, makeFileStore,
  newKey, readFileStoreConfig, registerFileStoreDriver, resetFileStore, type FileStore, type FileStoreConfig,
} from '../src/services/fileStore';

const COMPLETE = {
  displayName: 'Ayesha Khan', credentials: 'BSc Nutrition, RD', specialties: ['PCOS'], languages: ['Urdu'],
  yearsOfPractice: 6, countries: ['PK'], cities: ['Lahore'], bandIds: ['band_standard'],
};
const GOV_ID = { kind: 'government_id' as const, ref: 'a', flaggedForDeletion: false, deletedAt: null };
const LICENCE = { kind: 'license' as const, ref: 'b', flaggedForDeletion: false, deletedAt: null };

describe('profile validation', () => {
  it('accepts a full profile and fills the optional lists', () => {
    const p = proProfileSchema.parse({ displayName: '  Ayesha Khan ', countries: ['pk'] });
    expect(p.displayName).toBe('Ayesha Khan');
    expect(p.countries).toEqual(['PK']); // stored uppercase, whatever she typed
    expect(p).toMatchObject({ specialties: [], languages: [], cities: [], bandIds: [] });
  });
  it('refuses a name too short to be a name, and a country that is not a code', () => {
    expect(proProfileSchema.safeParse({ displayName: 'A' }).success).toBe(false);
    expect(proProfileSchema.safeParse({ displayName: 'Ayesha', countries: ['Pakistan'] }).success).toBe(false);
  });
  it('caps the long lists and the bio', () => {
    expect(proProfileSchema.safeParse({ displayName: 'Ayesha', specialties: Array(21).fill('PCOS') }).success).toBe(false);
    expect(proProfileSchema.safeParse({ displayName: 'Ayesha', bandIds: Array(11).fill('b') }).success).toBe(false);
    expect(proProfileSchema.safeParse({ displayName: 'Ayesha', bio: 'x'.repeat(2001) }).success).toBe(false);
    expect(proProfileSchema.safeParse({ displayName: 'Ayesha', yearsOfPractice: 61 }).success).toBe(false);
  });
  it('drops the same thing typed twice', () => {
    const p = tidyProfile(proProfileSchema.parse({ displayName: 'Ayesha', cities: ['Lahore', 'lahore'], bandIds: ['b1', 'b1'] }));
    expect(p.cities).toEqual(['Lahore']);
    expect(p.bandIds).toEqual(['b1']);
  });
  it('names what is still missing, in her words', () => {
    expect(profileCompleteness(COMPLETE).ready).toBe(true);
    const bare = profileCompleteness({ displayName: 'Ayesha' });
    expect(bare.ready).toBe(false);
    expect(bare.missing.map((m) => m.field)).toEqual(['credentials', 'specialties', 'languages', 'yearsOfPractice', 'places', 'bandIds']);
    expect(bare.missing[0]!.label).toBe('Your qualifications');
  });
  it('counts a city alone, or a country alone, as where she works', () => {
    expect(profileCompleteness({ ...COMPLETE, cities: [] }).ready).toBe(true);
    expect(profileCompleteness({ ...COMPLETE, countries: [] }).ready).toBe(true);
    expect(profileCompleteness({ ...COMPLETE, countries: [], cities: [] }).missing.map((m) => m.field)).toEqual(['places']);
  });
  it('refuses a price band Saathi does not offer', () => {
    expect(unknownBands(['band_standard', 'band_made_up'], ['band_standard'])).toEqual(['band_made_up']);
    expect(unknownBands(['band_standard'], ['band_standard', 'band_premium'])).toEqual([]);
  });
});

describe('review state, honestly', () => {
  it('shows each state and who is waiting on whom', () => {
    expect(reviewStateOf({ status: 'draft' })).toMatchObject({ state: 'draft', canEdit: true, canSubmit: true, settled: false });
    expect(reviewStateOf({ status: 'submitted' })).toMatchObject({ state: 'submitted', canEdit: false, canSubmit: false });
    expect(reviewStateOf({ status: 'in_review' })).toMatchObject({ state: 'in_review', canEdit: false, canSubmit: false });
    expect(reviewStateOf({ status: 'approved' })).toMatchObject({ state: 'approved', canEdit: false, settled: true });
  });
  it('a rejection with a note reads as more information needed, and she may resubmit', () => {
    const v = reviewStateOf({ status: 'rejected', reviewNote: 'Please send a clearer licence photo.' });
    expect(v).toMatchObject({ state: 'more_info', canEdit: true, canSubmit: true, settled: false });
    expect(v.note).toBe('Please send a clearer licence photo.');
    expect(reviewHeadline(v)).toBe('More information needed');
  });
  it('a final no stays a no, even with a note', () => {
    expect(reviewStateOf({ status: 'rejected', reviewNote: 'Not eligible.', reviewOutcome: 'declined' }).state).toBe('rejected');
    expect(reviewStateOf({ status: 'rejected' }).state).toBe('rejected');
    expect(reviewStateOf({ status: 'rejected', reviewOutcome: 'changes_requested' }).state).toBe('more_info');
  });
  it('never invents a note', () => {
    expect(reviewStateOf({ status: 'rejected', reviewNote: '   ' }).note).toBeNull();
    expect(reviewStateOf({ status: 'approved' }).note).toBeNull();
  });
  it('only draft and rejected are editable', () => {
    expect([canEditProfile('draft'), canEditProfile('rejected')]).toEqual([true, true]);
    expect([canEditProfile('submitted'), canEditProfile('in_review'), canEditProfile('approved')]).toEqual([false, false, false]);
  });
});

describe('submit transitions', () => {
  const docs = [GOV_ID, LICENCE];
  it('a complete draft with both documents can go', () => {
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: docs })).toBeNull();
  });
  it('resubmission after a review is allowed', () => {
    expect(submitBlock({ ...COMPLETE, status: 'rejected', documents: docs })).toBeNull();
  });
  it('cannot be sent twice, or after approval', () => {
    for (const status of ['submitted', 'in_review', 'approved'] as const) {
      expect(submitBlock({ ...COMPLETE, status, documents: docs })).toBe('wrong_status');
    }
  });
  it('reports the profile before the documents, so she fixes them in order', () => {
    expect(submitBlock({ displayName: 'Ayesha', status: 'draft', documents: [] })).toBe('profile_incomplete');
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: [] })).toBe('documents_missing');
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: [GOV_ID] })).toBe('documents_missing');
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: [LICENCE] })).toBe('documents_missing');
  });
  it('a certificate counts instead of a licence, and a purged ID does not count', () => {
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: [GOV_ID, { ...LICENCE, kind: 'certificate' }] })).toBeNull();
    expect(submitBlock({ ...COMPLETE, status: 'draft', documents: [{ ...GOV_ID, deletedAt: new Date() }, LICENCE] })).toBe('documents_missing');
  });
});

describe('document limits', () => {
  const cfg = { maxBytes: 1000, allowedMimeTypes: ['application/pdf', 'image/jpeg'] };
  it('refuses an empty file, one over the limit, and a type we cannot store', () => {
    expect(checkUpload({ mime: 'application/pdf', bytes: 0 }, cfg)).toBe('empty');
    expect(checkUpload({ mime: 'application/pdf', bytes: 1001 }, cfg)).toBe('too_big');
    expect(checkUpload({ mime: 'application/zip', bytes: 10 }, cfg)).toBe('mime_not_allowed');
    expect(checkUpload({ mime: 'image/png', bytes: 10 }, cfg)).toBe('mime_not_allowed'); // not in this config
  });
  it('accepts the limit exactly, and ignores a charset on the type', () => {
    expect(checkUpload({ mime: 'application/pdf', bytes: 1000 }, cfg)).toBeNull();
    expect(checkUpload({ mime: 'APPLICATION/PDF; charset=binary', bytes: 10 }, cfg)).toBeNull();
  });
  it('keeps at most eight, and a replacement always fits', () => {
    const many = Array.from({ length: MAX_DOCUMENTS }, () => ({ ...LICENCE }));
    expect(canAddDocument(many, false)).toBe('too_many');
    expect(canAddDocument(many, true)).toBeNull();
    expect(canAddDocument(many.slice(1), false)).toBeNull();
    // A purged ID no longer takes up a slot.
    expect(canAddDocument([...many.slice(1), { ...GOV_ID, deletedAt: new Date() }], false)).toBeNull();
  });
  it('tells the app a purged document is gone and never leaks the storage key', () => {
    const v = documentView({ ...GOV_ID, _id: 'd1', ref: 'dietitians/abc/secret.pdf', mime: 'application/pdf', bytes: 12, deletedAt: new Date(), uploadedAt: null });
    expect(v).toMatchObject({ id: 'd1', kind: 'government_id', removed: true, bytes: 12 });
    expect(JSON.stringify(v)).not.toContain('secret');
    expect(liveDocuments([GOV_ID, { ...LICENCE, deletedAt: new Date() }])).toEqual([GOV_ID]);
  });
});

describe('document keys and isolation between dietitians', () => {
  const a = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e0');
  const b = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e1');
  it('never keeps the uploader\'s filename', () => {
    const key = newKey(a, 'application/pdf');
    expect(key.startsWith(`${a}/`)).toBe(true);
    expect(key.endsWith('.pdf')).toBe(true);
    expect(key).not.toContain('..');
    expect(newKey(a, 'application/pdf')).not.toBe(newKey(a, 'application/pdf'));
    expect(() => newKey(a, 'application/zip')).toThrow();
  });
  it('rejects traversal, absolute paths and types we do not serve', () => {
    for (const bad of ['../etc/passwd', '/etc/passwd.pdf', 'a//b.pdf', 'dietitians/x/../y.pdf', 'x.exe', 'no-extension', 'x\\y.pdf', '']) {
      expect(isSafeKey(bad), bad).toBe(false);
    }
    expect(isSafeKey(`${a}/0f1e2d3c-1111-2222-3333-444455556666.pdf`)).toBe(true);
  });
  it('a key is readable only under the scope it was stored in', () => {
    const key = newKey(a, 'image/jpeg');
    expect(keyScope(key)).toBe(a);
    expect(keyBelongsTo(key, a)).toBe(true);
    expect(keyBelongsTo(key, b)).toBe(false);
    // The obvious attempt to reach into another dietitian's folder is not even a valid key.
    expect(keyBelongsTo(`${b}/../${a.split('/')[1]}/x.pdf`, b)).toBe(false);
  });
});

describe('local disk file store', () => {
  let root = '';
  let store: FileStore;
  const scopeA = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e0');
  const scopeB = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e1');

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'saathi-filestore-test-'));
    store = localDiskFileStore({ driver: 'local', root, maxBytes: 1000, allowedMimeTypes: ['application/pdf', 'image/jpeg'] });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('stores and returns the same bytes, under the owner\'s folder', async () => {
    const data = Buffer.from('%PDF-1.4 licence');
    const stored = await store.put({ scope: scopeA, mime: 'application/pdf', data });
    expect(stored).toMatchObject({ mime: 'application/pdf', bytes: data.byteLength, driver: 'local' });
    const got = await store.get(stored.key);
    expect(got?.data.equals(data)).toBe(true);
    expect(await readdir(path.join(root, scopeA))).toHaveLength(1);
  });
  it('refuses a file over the limit or of the wrong type', async () => {
    await expect(store.put({ scope: scopeA, mime: 'application/pdf', data: Buffer.alloc(1001) })).rejects.toThrow(/too_big/);
    await expect(store.put({ scope: scopeA, mime: 'application/zip', data: Buffer.from('x') })).rejects.toThrow();
    await expect(store.put({ scope: scopeA, mime: 'application/pdf', data: Buffer.alloc(0) })).rejects.toThrow(/empty/);
  });
  it('cannot be talked out of its own folder', async () => {
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(await store.get(`${scopeB}/../${scopeA.split('/')[1]}/x.pdf`)).toBeNull();
    expect(await store.get('unknown/ffffffff-0000-0000-0000-000000000000.pdf')).toBeNull();
  });
  it('one dietitian\'s key is not the other\'s to read', async () => {
    const mine = await store.put({ scope: scopeA, mime: 'image/jpeg', data: Buffer.from('jpegbytes') });
    // The route only fetches a key that belongs to the caller, so this is the check that protects it.
    expect(keyBelongsTo(mine.key, scopeB)).toBe(false);
    expect(keyBelongsTo(mine.key, scopeA)).toBe(true);
  });
  it('removes what it stored, and is quiet about a key it never had', async () => {
    const s = await store.put({ scope: scopeA, mime: 'application/pdf', data: Buffer.from('bye') });
    await store.remove(s.key);
    expect(await store.get(s.key)).toBeNull();
    await expect(store.remove('../nope.pdf')).resolves.toBeUndefined();
  });
});

describe('file store seam', () => {
  it('defaults to local disk, outside the repo', () => {
    const cfg = readFileStoreConfig({});
    expect(cfg.driver).toBe('local');
    expect(cfg.root.startsWith(tmpdir())).toBe(true);
    expect(cfg.maxBytes).toBeGreaterThan(0);
  });
  it('reads the driver, root and limits from the environment', () => {
    const cfg = readFileStoreConfig({ FILE_STORE_DRIVER: 'S3', FILE_STORE_ROOT: '/srv/files', FILE_STORE_MAX_BYTES: '2048', FILE_STORE_MIME_TYPES: 'application/pdf' });
    expect(cfg).toMatchObject({ driver: 's3', root: '/srv/files', maxBytes: 2048, allowedMimeTypes: ['application/pdf'] });
  });
  it('a second driver slots in without the routes changing', () => {
    const calls: FileStoreConfig[] = [];
    const fake: FileStore = { driver: 's3', put: async () => ({ key: 'k.pdf', mime: 'application/pdf', bytes: 1, sha256: '', driver: 's3' }), get: async () => null, remove: async () => undefined };
    registerFileStoreDriver('s3', (cfg) => { calls.push(cfg); return fake; });
    const cfg = readFileStoreConfig({ FILE_STORE_DRIVER: 's3' });
    expect(makeFileStore(cfg).driver).toBe('s3');
    expect(calls[0]).toMatchObject({ driver: 's3' });
    resetFileStore();
  });
  it('says so loudly when the configured driver does not exist', () => {
    expect(() => makeFileStore({ ...readFileStoreConfig({}), driver: 'ftp' })).toThrow(/Unknown FILE_STORE_DRIVER/);
  });
});

describe('publish validates the plan', () => {
  const meal = (key: string, title: string, time: string, text: string) => ({ key, category: 'meal' as const, title, time, details: text });
  const good = {
    items: [
      meal('b', 'Breakfast', '08:00', '2 eggs and toast'),
      meal('l', 'Lunch', '13:00', 'dal, rice and salad'),
      { ...meal('t', 'Afternoon snack', '16:00', 'yogurt and a pear'), mealKind: 'snack' as const },
      meal('d', 'Dinner', '19:00', 'chicken and vegetables'),
      { key: 's', category: 'sleep' as const, title: 'Bedtime', time: '23:00' },
    ],
  };

  it('passes a sound plan with nothing to acknowledge', () => {
    const r = reviewPlanForPublish(good, { waterTargetMl: 2000 });
    expect(r.check.verdict).toBe('good');
    expect(r.blocking).toEqual([]);
    expect(r.tweakIds).toEqual([]);
    expect(r.publishable).toBe(true);
    expect(publishRefusal(r)).toBeNull();
  });

  it('runs the existing plan check and will not send until she has read each note', () => {
    const late = { items: [...good.items.filter((i) => i.key !== 'l'), meal('l', 'Lunch', '14:30', 'dal and rice')] };
    const r = reviewPlanForPublish(late, { waterTargetMl: 2000 });
    expect(r.check.tweaks.map((t) => t.id)).toContain('meal-gap-long');
    expect(r.publishable).toBe(false);
    expect(publishRefusal(r)).toBe('Read the notes on the plan before you send it.');
    expect(reviewPlanForPublish(late, { waterTargetMl: 2000, acknowledgedTweakIds: r.tweakIds }).publishable).toBe(true);
    // Acknowledging something else is not acknowledging this.
    expect(reviewPlanForPublish(late, { waterTargetMl: 2000, acknowledgedTweakIds: ['something-else'] }).publishable).toBe(false);
  });

  it('a missing water target is a note, not a refusal', () => {
    const r = reviewPlanForPublish(good, {});
    expect(r.check.tweaks.map((t) => t.id)).toContain('water-missing');
    expect(r.blocking).toEqual([]);
    expect(reviewPlanForPublish(good, { acknowledgedTweakIds: r.tweakIds }).publishable).toBe(true);
  });

  it('a broken plan can never be sent, however much is acknowledged', () => {
    const cases: [unknown, string][] = [
      [{ items: [] }, 'empty'],
      [{ items: [{ key: 's', category: 'sleep', title: 'Bedtime', time: '23:00' }] }, 'no_meals'],
      [{ items: [{ key: 'b', category: 'meal', title: 'Breakfast' }] }, 'meal_without_time'],
      [{ items: [meal('b', 'Breakfast', '08:00', 'eggs'), meal('b', 'Second breakfast', '10:00', 'eggs')] }, 'duplicate_key'],
      [{ items: 'not a list' }, 'invalid'],
      [{ items: [{ key: 'b', category: 'feast', title: 'Breakfast', time: '08:00' }] }, 'invalid'],
      [{ items: [meal('b', 'Breakfast', '8am', 'eggs')] }, 'invalid'],
      [null, 'invalid'],
    ];
    for (const [plan, code] of cases) {
      const r = reviewPlanForPublish(plan, { waterTargetMl: 2000, acknowledgedTweakIds: ['meal-count-low', 'water-missing'] });
      expect(r.blocking.map((b) => b.code), code).toContain(code);
      expect(r.publishable).toBe(false);
      expect(publishRefusal(r)).toBe(r.blocking[0]!.message);
    }
  });

  it('publishing an update to a plan she already sent is the same check', () => {
    const updated = { items: [...good.items, { key: 'walk', category: 'movement' as const, title: 'Evening walk', time: '20:00' }] };
    expect(reviewPlanForPublish(updated, { waterTargetMl: 2000 }).publishable).toBe(true);
  });
});

describe('earnings arithmetic', () => {
  const fees = { playFeePercent: 15, platformFeePercent: 20 };
  // 10000 -> store 1500, net 8500, Saathi 1700, her 6800
  const row = (status: string, currency = 'PKR', pricePaid = 10000) => ({
    status: status as never, currency, pricePaid,
    settlement: { playFee: 1500, platform: 1700, dietitian: 6800 },
  });

  it('splits what she has delivered into held and cleared, and shows the fee taken', () => {
    const s = summariseEarnings([row('delivered'), row('released'), row('released')], fees);
    expect(s.currencies).toHaveLength(1);
    expect(s.currencies[0]).toMatchObject({ currency: 'PKR', orders: 3, heldMinor: 6800, clearedMinor: 13600, earnedMinor: 20400, feeMinor: 9600 });
  });

  it('counts nothing for work not delivered, or money given back', () => {
    expect(summariseEarnings([row('requested'), row('paid'), row('in_progress'), row('refunded')], fees).currencies).toEqual([]);
  });

  it('says plainly that nothing has been paid out, because payouts are not live', () => {
    const s = summariseEarnings([row('released'), row('delivered')], fees);
    expect(s.payoutsLive).toBe(false);
    expect(s.currencies[0]!.paidOutMinor).toBe(0);
    expect(PAYOUT_NOTE).toMatch(/nothing has been sent and nothing is on its way/);
  });

  it('keeps currencies apart and in a steady order', () => {
    const s = summariseEarnings([row('released', 'PKR'), row('released', 'AED', 20000), row('delivered', 'PKR')], fees);
    expect(s.currencies.map((c) => c.currency)).toEqual(['AED', 'PKR']);
    expect(s.currencies[0]).toMatchObject({ clearedMinor: 6800, orders: 1 });
    expect(s.currencies[1]).toMatchObject({ clearedMinor: 6800, heldMinor: 6800 });
  });

  it('falls back to the fee rates for an order with no snapshot', () => {
    const s = summariseEarnings([{ status: 'released' as never, currency: 'PKR', pricePaid: 10000, settlement: null }], fees);
    expect(s.currencies[0]).toMatchObject({ clearedMinor: 6800, feeMinor: 3200 });
  });

  it('uses the snapshot even when the fee rates have since changed', () => {
    expect(summariseEarnings([row('released')], { playFeePercent: 30, platformFeePercent: 50 }).currencies[0]!.clearedMinor).toBe(6800);
  });

  it('her share plus the fee is exactly what the client paid', () => {
    for (const price of [1, 3, 99, 10_000, 123_457]) {
      const c = summariseEarnings([{ status: 'released' as never, currency: 'PKR', pricePaid: price, settlement: null }], fees).currencies[0]!;
      expect(c.clearedMinor + c.feeMinor).toBe(price);
    }
  });
});

describe('what she owes a client, and by when', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);

  it('walks her through the order', () => {
    expect(clientOrderView({ status: 'requested' }, t0, 72)).toMatchObject({ todo: 'wait_for_payment', canStart: false, canSeeClientData: false });
    expect(clientOrderView({ status: 'paid', paidAt: t0 }, t0, 72)).toMatchObject({ todo: 'start', canStart: true, canDeliver: false, canSeeClientData: true });
    expect(clientOrderView({ status: 'in_progress', paidAt: t0 }, t0, 72)).toMatchObject({ todo: 'write_plan', canDeliver: false, canPublish: true });
    expect(clientOrderView({ status: 'in_progress', paidAt: t0, planId: 'p1' }, t0, 72)).toMatchObject({ todo: 'deliver', canDeliver: true });
    expect(clientOrderView({ status: 'delivered', paidAt: t0, deliveredAt: h(1), planId: 'p1' }, t0, 72)).toMatchObject({ todo: 'done', dueAt: null });
  });
  it('the deadline is the client\'s refund window, and it goes once she has delivered', () => {
    expect(clientOrderView({ status: 'paid', paidAt: t0 }, t0, 72).dueAt).toEqual(h(72));
    expect(clientOrderView({ status: 'paid', paidAt: t0 }, h(71), 72).overdue).toBe(false);
    expect(clientOrderView({ status: 'in_progress', paidAt: t0 }, h(73), 72).overdue).toBe(true);
    expect(clientOrderView({ status: 'delivered', paidAt: t0, deliveredAt: h(2) }, h(73), 72).overdue).toBe(false);
  });
  it('counts the time left in plain words', () => {
    expect(dueLine(h(72), t0)).toBe('3 days left');
    expect(dueLine(h(5), t0)).toBe('5 hours left');
    expect(dueLine(h(1), t0)).toBe('1 hour left');
    expect(dueLine(h(-48), t0)).toBe('2 days late');
    expect(dueLine(null, t0)).toBeNull();
  });
});
