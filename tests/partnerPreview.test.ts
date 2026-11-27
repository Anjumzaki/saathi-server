import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_DAYS, PREVIEW_MS, SENDING_REQUIRES_PACKAGE, partnerAccess, previewDaysLeft, previewEnd, previewWindowFor,
} from '../src/services/partnerLogic';
import { DAY } from '../src/utils/time';

/** The gate is asserted against the route file itself, so a new route cannot quietly skip it. */
const ROUTES = resolve(process.cwd(), 'src/routes/partner.ts');

const accepted = new Date('2026-11-27T09:30:00Z');
const at = (ms: number) => new Date(accepted.getTime() + ms);
const share = (o: Partial<Parameters<typeof partnerAccess>[0]> = {}) => ({ status: 'active', previewEndsAt: previewEnd(accepted), ...o });

describe('the free preview', () => {
  it('is three days and starts the moment the invite is accepted', () => {
    expect(PREVIEW_DAYS).toBe(3);
    expect(PREVIEW_MS).toBe(3 * DAY);
    expect(previewEnd(accepted).toISOString()).toBe('2026-11-30T09:30:00.000Z');
    const a = partnerAccess(share(), false, accepted);
    expect(a).toMatchObject({ state: 'preview', daysLeft: 3, lastPreviewDay: false, canSeeDay: true });
    expect(a.previewEndsAt?.toISOString()).toBe('2026-11-30T09:30:00.000Z');
  });

  it('counts down whole days and spends its last day on the Paywall', () => {
    expect(partnerAccess(share(), false, at(DAY - 1)).daysLeft).toBe(3);
    expect(partnerAccess(share(), false, at(DAY)).daysLeft).toBe(2);
    expect(partnerAccess(share(), false, at(2 * DAY)).daysLeft).toBe(1);
    expect(partnerAccess(share(), false, at(2 * DAY))).toMatchObject({ state: 'preview', lastPreviewDay: true, canSeeDay: true });
    // day 3 boundary: the last minute is still free, the first minute after it is not
    expect(partnerAccess(share(), false, at(3 * DAY - 60_000))).toMatchObject({ state: 'preview', daysLeft: 1, canSeeDay: true });
    expect(partnerAccess(share(), false, at(3 * DAY))).toMatchObject({ state: 'paused', daysLeft: 0, canSeeDay: false });
    expect(partnerAccess(share(), false, at(3 * DAY + 1))).toMatchObject({ state: 'paused', canSeeDay: false });
  });

  it('is counted from the stored end, and the gate never reads anything the phone sent', () => {
    expect(previewDaysLeft(previewEnd(accepted), at(10 * DAY))).toBe(0);
    expect(previewDaysLeft(null, accepted)).toBe(0);
    const src = readFileSync(ROUTES, 'utf8');
    const guard = /async function viewerShare[\s\S]*?\n}/.exec(src)![0];
    // no req.body, no req.query and no client date: only the share's own dates and the server clock
    expect(guard).not.toMatch(/req\.(body|query)/);
    expect(guard).toContain('new Date()');
  });

  it('cannot be restarted by inviting the same person again', () => {
    const first = previewWindowFor(null, accepted);
    expect(first.toISOString()).toBe(previewEnd(accepted).toISOString());
    // a second invite two days later joins the window the first acceptance opened
    expect(previewWindowFor(first, at(2 * DAY)).toISOString()).toBe(first.toISOString());
    expect(partnerAccess(share({ previewEndsAt: previewWindowFor(first, at(2 * DAY)) }), false, at(2 * DAY)).daysLeft).toBe(1);
    expect(partnerAccess(share({ previewEndsAt: previewWindowFor(first, at(4 * DAY)) }), false, at(4 * DAY)).state).toBe('paused');
    const src = readFileSync(ROUTES, 'utf8');
    expect(src).toContain('previewWindowFor(await earliestPreviewEndsAtForViewer(userId), now)');
    expect(src).not.toMatch(/previewEndsAt = previewEnd\(now\)/); // never a fresh window on accept
  });

  it('reports an invite nobody has accepted as invited, and never lets it read the day', () => {
    const a = partnerAccess({ status: 'pending', previewEndsAt: null }, false, accepted);
    expect(a).toMatchObject({ state: 'invited', canSeeDay: false });
    expect(partnerAccess({ status: 'pending', previewEndsAt: null }, true, accepted).canSeeDay).toBe(false);
  });
});

describe('pause and resume', () => {
  it('pauses rather than ends: the share stays, only the day stops', () => {
    const a = partnerAccess(share(), false, at(5 * DAY));
    expect(a.state).toBe('paused');
    expect(a.canSeeDay).toBe(false);
    // the stored window is still there, which is how the history survives
    expect(a.previewEndsAt?.toISOString()).toBe('2026-11-30T09:30:00.000Z');
  });
  it('paying resumes a paused share with its window and history intact', () => {
    const paused = share({ status: 'paused' });
    expect(partnerAccess(paused, false, at(5 * DAY))).toMatchObject({ state: 'paused', canSeeDay: false });
    const resumed = partnerAccess(paused, true, at(5 * DAY));
    expect(resumed).toMatchObject({ state: 'active', canSeeDay: true });
    expect(resumed.previewEndsAt?.toISOString()).toBe('2026-11-30T09:30:00.000Z');
  });
  it('a package wins at any moment, inside the preview or long after it', () => {
    for (const ms of [0, DAY, 3 * DAY, 400 * DAY]) {
      expect(partnerAccess(share(), true, at(ms))).toMatchObject({ state: 'active', canSeeDay: true });
    }
  });
});

describe('her own sending', () => {
  it('stays free behind one named switch', () => {
    expect(SENDING_REQUIRES_PACKAGE).toBe(false);
    const src = readFileSync(ROUTES, 'utf8');
    // the switch is read in exactly one place, which both sending routes go through
    expect(src.match(/if \(!SENDING_REQUIRES_PACKAGE\)/g)).toHaveLength(1);
    expect(src.match(/requireOwnerMaySend\(/g)?.length).toBe(3); // the helper plus PUT /summary and POST /invites
  });
});

/**
 * The gate has to hold on every viewer-side route, not just the obvious one, so this reads the route file:
 * anything that reaches her day or writes a cheer must come through viewerShare().
 */
describe('no viewer route can skip the gate', () => {
  const src = readFileSync(ROUTES, 'utf8');
  const blocks = src.split(/\n  r\.(get|post|put|patch|delete)\(/).slice(1);
  const routes = blocks.filter((_, i) => i % 2 === 1).map((b) => ({ path: /^'([^']+)'/.exec(b)?.[1] ?? '?', body: b }));

  it('finds every route in the file', () => {
    expect(routes.map((r) => r.path)).toEqual([
      '/summary', '/invites', '/invites/accept', '/shares', '/shares/:id', '/shares/:id', '/shared-with-me', '/shares/:id/view', '/shares/:id/cheer', '/cheers',
    ]);
  });

  it('gates every route that hands over her day or takes a cheer', () => {
    for (const r of routes) {
      if (/buildSnapshot\(|serializePartnerView\(|Cheer\.create\(/.test(r.body)) {
        expect(r.body, `${r.path} must call viewerShare()`).toContain('viewerShare(req, req.params[\'id\'], true)');
      }
    }
  });

  it('never trusts a bare partnerId query for day data again', () => {
    for (const r of routes) {
      if (/partnerId: (userId|authOf)/.test(r.body) && !/viewerShare\(/.test(r.body)) {
        // only the list of who shares with her may do this, and it carries no day data
        expect(r.path).toBe('/shared-with-me');
        expect(r.body).not.toMatch(/buildSnapshot\(|serializePartnerView\(/);
        expect(r.body).toContain('accessView(');
      }
    }
  });

  it('refuses a paused viewer with a 402 the app can read, not a crash or a 404', () => {
    expect(src).toContain("new ApiError(402, 'preview_ended'");
    // the cheer route no longer has its own share lookup to drift from the gate
    const cheer = routes.find((r) => r.path === '/shares/:id/cheer')!;
    expect(cheer.body).not.toMatch(/PartnerShare\.findOne/);
  });
});
