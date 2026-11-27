import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/services/tokens';
import { createStubServices } from '../src/stubs';
import {
  adminProfileView, documentBlockMessage, pickAdminDocument, purgeTargets, reviewAction, reviewActionsFor, reviewPatch,
} from '../src/services/adminReview';
import { invalidateConfigCaches } from '../src/services/adminConfigCache';
import { dietitianScope, newKey } from '../src/services/fileStore';

// No database here: the review rules are pure, and the routes are checked for their gates only.
let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp(createStubServices({ production: false, allowStubInProduction: false })).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The error envelope, typed just enough to assert on. */
const errorOf = async (r: Response): Promise<{ code: string; message: string }> => ((await r.json()) as { error: { code: string; message: string } }).error;

const admin = () => signAccessToken('507f1f77bcf86cd799439011', ['admin']);
const client = () => signAccessToken('507f1f77bcf86cd799439012', ['client']);
const OWNER = '64b7f1c2d3e4f5a6b7c8d9e0';
const OTHER = '64b7f1c2d3e4f5a6b7c8d9e1';

describe('what a reviewer may do', () => {
  it('offers only the decisions the application can actually take', () => {
    expect(reviewActionsFor('draft')).toEqual([]);
    expect(reviewActionsFor('submitted').map((a) => a.action)).toEqual(['start']);
    expect(reviewActionsFor('in_review').map((a) => a.action)).toEqual(['approve', 'more_info', 'decline']);
    // Nothing is offered on a settled application: approval is final and a rejection waits on her.
    expect(reviewActionsFor('approved')).toEqual([]);
    expect(reviewActionsFor('rejected')).toEqual([]);
  });
  it('marks approval as the one decision that cannot be undone, and says what each does', () => {
    const irreversible = reviewActionsFor('in_review').filter((a) => a.irreversible).map((a) => a.action);
    expect(irreversible).toEqual(['approve']);
    for (const a of reviewActionsFor('in_review')) {
      expect(a.effect.length).toBeGreaterThan(40);
      expect(a.deletesGovernmentId).toBe(true); // every decision starts the retention clock
    }
    expect(reviewAction('approve').effect).toContain('Nothing can take an approval back');
    expect(reviewAction('start').deletesGovernmentId).toBe(false);
  });
  it('asks for a note where she is owed a reason', () => {
    expect(reviewAction('more_info').noteRequired).toBe(true);
    expect(reviewAction('decline').noteRequired).toBe(true);
    expect(reviewAction('approve').noteRequired).toBe(false);
  });
});

describe('a review decision', () => {
  const now = new Date('2026-11-27T09:00:00Z');
  it('writes the note and the outcome she will be shown', () => {
    const p = reviewPatch({ decision: 'rejected', note: '  Send a clearer licence photo.  ', outcome: 'changes_requested' }, now);
    expect(p).toMatchObject({
      status: 'rejected', reviewNote: 'Send a clearer licence photo.', reviewOutcome: 'changes_requested',
      reviewedAt: now, flagDocuments: true, grantsDietitianRole: false,
    });
  });
  it('a decline keeps the note and records a final no', () => {
    const p = reviewPatch({ decision: 'rejected', note: 'Not eligible.', outcome: 'declined' }, now);
    expect(p.reviewOutcome).toBe('declined');
    expect(p.reviewNote).toBe('Not eligible.');
  });
  it('falls back to the note when no outcome was given, so she is not told the wrong thing', () => {
    expect(reviewPatch({ decision: 'rejected', note: 'Please add your ID.' }, now).reviewOutcome).toBe('changes_requested');
    expect(reviewPatch({ decision: 'rejected' }, now).reviewOutcome).toBe('declined');
    expect(reviewPatch({ decision: 'rejected', note: '   ' }, now).reviewOutcome).toBe('declined');
  });
  it('approving grants the role and clears any old outcome', () => {
    const p = reviewPatch({ decision: 'approved' }, now);
    expect(p).toMatchObject({ status: 'approved', reviewOutcome: null, grantsDietitianRole: true, flagDocuments: true });
  });
  it('picking it up is not a decision: no timestamp, no documents flagged', () => {
    const p = reviewPatch({ decision: 'in_review' }, now);
    expect(p).toMatchObject({ status: 'in_review', reviewedAt: null, flagDocuments: false, grantsDietitianRole: false });
  });
});

describe('what the reviewer is shown', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    _id: 'd1', kind: 'license' as const, ref: `${dietitianScope(OWNER)}/0f1e2d3c-1111-2222-3333-444455556666.pdf`,
    mime: 'application/pdf', bytes: 4096, storedBy: 'local', flaggedForDeletion: false, deleteAfter: null,
    deletedAt: null, uploadedAt: new Date('2026-11-20T10:00:00Z'), ...over,
  });
  const profile = (over: Record<string, unknown> = {}) => ({
    _id: '507f1f77bcf86cd799439055', userId: OWNER, displayName: 'Ayesha Khan', credentials: 'BSc Nutrition, RD',
    specialties: ['PCOS'], languages: ['Urdu'], countries: ['PK'], cities: ['Lahore'], bandIds: ['band_standard'],
    yearsOfPractice: 6, status: 'in_review' as const, documents: [doc()], ...over,
  });

  it('never puts a storage key on the wire, and says when an ID is on its way out', () => {
    const v = adminProfileView(profile({ documents: [doc({ flaggedForDeletion: true, deleteAfter: new Date('2026-12-04T09:00:00Z'), kind: 'government_id' })] }));
    expect(JSON.stringify(v)).not.toContain('0f1e2d3c');
    expect(JSON.stringify(v)).not.toContain('dietitians/');
    expect(v.documents[0]).toMatchObject({ id: 'd1', kind: 'government_id', flaggedForDeletion: true, removed: false, bytes: 4096 });
    expect(v.documents[0]!.deleteAfter).toEqual(new Date('2026-12-04T09:00:00Z'));
  });
  it('carries the decisions this status allows, so the tool cannot offer an illegal one', () => {
    expect(adminProfileView(profile()).actions.map((a) => a.action)).toEqual(['approve', 'more_info', 'decline']);
    expect(adminProfileView(profile({ status: 'submitted' })).actions.map((a) => a.action)).toEqual(['start']);
  });
  it('says whether she has a photo and a payout reference without repeating either', () => {
    const v = adminProfileView(profile({ photoRef: 'dietitians/x/p.jpg', payoutAccountRef: 'IBAN-SECRET' }));
    expect(v).toMatchObject({ hasPhoto: true, hasPayoutAccount: true });
    expect(JSON.stringify(v)).not.toContain('IBAN-SECRET');
  });

  it('hands back only a document stored under the owner of this application', () => {
    const p = profile();
    expect(pickAdminDocument(p, 'd1')).toEqual({ ok: true, ref: p.documents[0]!.ref });
    expect(pickAdminDocument(p, 'nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(pickAdminDocument(profile({ documents: [doc({ deletedAt: new Date() })] }), 'd1')).toEqual({ ok: false, reason: 'purged' });
    // A key from another dietitian's folder, or an outside reference with no driver, is not a reviewer's to read.
    expect(pickAdminDocument(profile({ documents: [doc({ ref: `${dietitianScope(OTHER)}/a.pdf` })] }), 'd1')).toEqual({ ok: false, reason: 'not_stored_here' });
    expect(pickAdminDocument(profile({ documents: [doc({ storedBy: null })] }), 'd1')).toEqual({ ok: false, reason: 'not_stored_here' });
    expect(pickAdminDocument(profile({ documents: [doc({ ref: '../../etc/passwd' })] }), 'd1')).toEqual({ ok: false, reason: 'not_stored_here' });
  });
  it('is the same isolation rule the owner download uses', () => {
    const mine = newKey(dietitianScope(OWNER), 'image/jpeg');
    expect(pickAdminDocument(profile({ documents: [doc({ ref: mine, mime: 'image/jpeg' })] }), 'd1').ok).toBe(true);
    expect(pickAdminDocument(profile({ userId: OTHER, documents: [doc({ ref: mine })] }), 'd1').ok).toBe(false);
  });
  it('names the documents whose retention window has run out, and what to delete', () => {
    const now = new Date('2026-12-05T09:00:00Z');
    const due = { flaggedForDeletion: true, deleteAfter: new Date('2026-12-04T09:00:00Z') };
    const notYet = { flaggedForDeletion: true, deleteAfter: new Date('2026-12-06T09:00:00Z') };
    expect(purgeTargets(profile({ documents: [doc({ ...due, _id: 'a' })] }), now)).toEqual([{ id: 'a', ref: profile().documents[0]!.ref }]);
    expect(purgeTargets(profile({ documents: [doc({ ...notYet })] }), now)).toEqual([]);
    expect(purgeTargets(profile({ documents: [doc({ flaggedForDeletion: false, deleteAfter: due.deleteAfter })] }), now)).toEqual([]);
    expect(purgeTargets(profile({ documents: [doc({ ...due, deletedAt: new Date() })] }), now)).toEqual([]);
    // Bytes somebody else stored are marked purged but never deleted by us.
    expect(purgeTargets(profile({ documents: [doc({ ...due, _id: 'b', storedBy: null })] }), now)).toEqual([{ id: 'b', ref: null }]);
    expect(purgeTargets(profile({ documents: [doc({ ...due, _id: 'c', ref: `${dietitianScope(OTHER)}/x.pdf` })] }), now)).toEqual([{ id: 'c', ref: null }]);
  });
  it('never says whether the id existed', () => {
    expect(documentBlockMessage('not_found')).toBe(documentBlockMessage('not_stored_here'));
  });
});

describe('the admin API', () => {
  const get = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const DOC_PATH = '/v1/admin/dietitians/507f1f77bcf86cd799439055/documents/d1/file';

  it('serves a document only to an admin', async () => {
    expect((await get(DOC_PATH)).status).toBe(401);
    const asClient = await get(DOC_PATH, client());
    expect(asClient.status).toBe(403);
    // The refusal says nothing about the document or whether the application exists.
    const body = await asClient.text();
    expect(body).not.toContain('document');
    expect(body).not.toContain('dietitians/');
  });
  it('404s an application id that cannot be one, before any lookup', async () => {
    for (const p of ['/v1/admin/dietitians/not-an-id', '/v1/admin/dietitians/not-an-id/documents/d1/file']) {
      const r = await get(p, admin());
      expect(r.status).toBe(404);
      expect((await errorOf(r)).code).toBe('not_found');
    }
  });
  it('refuses a status filter it does not know', async () => {
    const r = await get('/v1/admin/dietitians?status=submitted,made_up', admin());
    expect(r.status).toBe(400);
    expect((await errorOf(r)).message).toContain('made_up');
  });
  it('keeps the whole admin API behind the admin role', async () => {
    for (const p of ['/v1/admin/dietitians', '/v1/admin/leads', '/v1/admin/packages', '/v1/admin/fee-config']) {
      expect((await get(p)).status).toBe(401);
      expect((await get(p, client())).status).toBe(403);
    }
  });
});

describe('the review tool pages', () => {
  const page = (path: string) => fetch(base + path, { headers: { accept: 'text/html' }, redirect: 'manual' });

  it('is served beside the website', async () => {
    const r = await page('/admin/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('Saathi review tool');
    expect(html).toContain('/v1/admin/dietitians');
    const bare = await page('/admin');
    expect([200, 301]).toContain(bare.status);
  });
  it('is not for search engines and is not in the sitemap', async () => {
    const head = (await (await page('/admin/')).text()).split('</head>')[0] ?? '';
    expect(head).toContain('<meta name="robots" content="noindex');
    expect(await (await fetch(base + '/sitemap.xml')).text()).not.toContain('/admin');
  });
  it('holds the token in memory only: no cookie, no storage', async () => {
    const html = await (await page('/admin/')).text();
    const script = html.split('<script>')[1] ?? '';
    expect(script).not.toMatch(/localStorage\s*[.[]/);
    expect(script).not.toMatch(/sessionStorage\s*[.[]/);
    expect(script).not.toMatch(/document\.cookie/);
  });
  it('runs under the site policy it was written for', async () => {
    const csp = (await page('/admin/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    // Nothing in the page may need a source the policy forbids.
    const html = await (await page('/admin/')).text();
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('blob:');
  });
});

describe('config caches', () => {
  it('clears every cached view of pricing, not just one', () => {
    const rang: string[] = [];
    invalidateConfigCaches([() => rang.push('fee'), () => rang.push('packages'), () => rang.push('paid')]);
    expect(rang).toEqual(['fee', 'packages', 'paid']);
  });
});
