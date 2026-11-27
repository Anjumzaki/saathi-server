import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_DIR } from '../src/middleware/site';

/**
 * The website has contradicted the product twice now: once when the trial changed from 30 days to 7,
 * and again when cycle insights, the weekly recap and the calorie target became free. These read the
 * published pages as text, so a page that drifts back fails here rather than in the store review.
 */
const pages = fs.readdirSync(SITE_DIR).filter((f) => f.endsWith('.html'));
const read = (f: string) => fs.readFileSync(path.join(SITE_DIR, f), 'utf8');
/** Tags out, entities for quotes and dashes in, so a claim split across markup is still caught. */
const text = (f: string) =>
  read(f)
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');

/** The pages this slice rewrote on 27 Nov; each must stay complete in the head. */
const TOUCHED = [
  'pricing.html', 'index.html', 'help.html', 'features.html', 'privacy.html',
  'terms.html', 'disclaimer.html', 'pro.html', 'dietitians.html', 'security.html',
];

describe('site copy matches the product', () => {
  it('found the pages', () => {
    expect(pages.length).toBeGreaterThan(20);
    for (const p of TOUCHED) expect(pages).toContain(p);
  });

  it('never says the trial is 30 days', () => {
    // "within 30 days" is the deletion and response window and is allowed; a 30-day trial is not.
    const bad = /30[\s-]day(s)?\s+(free\s+)?(premium\s+)?trial|trial\s+(of|lasts|is|runs for)\s+30|free\s+for\s+30\s+days|30\s+days\s+free/i;
    for (const f of pages) expect(text(f), f).not.toMatch(bad);
  });

  it('says the trial is 7 days wherever it names a length', () => {
    for (const f of ['pricing.html', 'index.html', 'help.html', 'terms.html', 'download.html']) {
      expect(text(f), f).toMatch(/7[\s-]day|7 days/i);
    }
  });

  /**
   * One content element: a list item, a cell, a paragraph. Splitting on the tags that open a new unit
   * keeps a claim in the Free column from being read together with the Premium column beside it.
   */
  const blocks = (f: string): string[] =>
    read(f)
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .split(/<(?:li|td|th|p|h[1-4]|summary|div|section|tr)\b[^>]*>/)
      .map((b) => b.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());

  it('never sells cycle insights, the weekly recap or the calorie target as Premium', () => {
    const freed = ['cycle insight', 'weekly recap', 'sunday recap', 'calorie target', 'daily calorie'];
    for (const f of pages) {
      for (const b of blocks(f)) {
        for (const feature of freed) {
          if (!b.includes(feature)) continue;
          // Naming Premium in the same element is only honest when it is saying the feature is free of it.
          const paid = /premium|\bplus\b/.test(b);
          const denied = /free|every account|everyone|\bno\b|\bnot\b|without|instead/.test(b);
          expect(paid && !denied, `${f}: "${feature}" reads as a paid feature in: ${b}`).toBe(false);
        }
      }
    }
  });

  it('puts the three freed features in the free column', () => {
    for (const f of ['pricing.html', 'index.html']) {
      const free = blocks(f).filter((b) => /weekly recap|cycle insight|calorie target/.test(b));
      expect(free.length, f).toBeGreaterThan(0);
    }
    // The help page answers the question outright.
    expect(text('help.html')).toMatch(/calorie target for weight-loss goals is free|target .{0,30}free/i);
  });

  it('states plainly on Pricing what Premium is for', () => {
    const t = text('pricing.html').toLowerCase();
    for (const claim of ['read by ai', 'written for you by ai', 'guided strength', 'local produce']) {
      expect(t, claim).toContain(claim);
    }
  });

  it('names both paid packages on the pricing page, in the head as well as the body', () => {
    const t = read('pricing.html');
    expect(t).toContain('Premium Plus');
    expect(t.split('</head>')[0]).toContain('Premium Plus');
    const body = text('pricing.html');
    // Both packages have their own column, and Plus has no price yet.
    expect(body).toMatch(/Premium Plus/);
    expect(body).toMatch(/not set yet|price (is )?coming/i);
    expect(body).not.toMatch(/Premium Plus[^.]{0,40}Local price/);
  });

  it('says the dietitian and merchant discounts do not apply during the trial', () => {
    for (const f of ['pricing.html', 'help.html', 'terms.html', 'dietitians.html', 'pro.html']) {
      expect(text(f), f).toMatch(/not (be )?(available|given)? ?during (the|a|her|your)? ?(free )?trial|from (the|your|their|her) first (subscription )?payment|starts? with (the|your|her) first payment|pays? (your |the )?full price/i);
    }
  });

  it('says the partner view is paid after three free days, and pauses rather than ending', () => {
    for (const f of ['pricing.html', 'features.html', 'help.html', 'privacy.html', 'terms.html']) {
      expect(text(f), f).toMatch(/3 days|three days/i);
    }
    for (const f of ['features.html', 'help.html', 'privacy.html', 'terms.html']) {
      expect(text(f), f).toMatch(/pause/i);
    }
    // The old claim that no partner view exists at all must not come back.
    for (const f of pages) expect(text(f), f).not.toMatch(/no partner (or family )?view/i);
  });

  it('mentions the features that shipped since the site was written', () => {
    expect(text('features.html')).toMatch(/Your world/i);
    expect(text('features.html')).toMatch(/Quiet times/i);
    expect(text('features.html')).toMatch(/fasting/i);
    expect(text('index.html')).toMatch(/written for you by AI|plan written/i);
  });

  it('keeps the Pro fee table in step with the server fee model', () => {
    const t = text('pro.html');
    // DEFAULT_FEE_CONFIG: the store takes 15% of the payment, Saathi 20% of the rest, she keeps 68%.
    expect(t).toMatch(/15%/);
    expect(t).toMatch(/20%/);
    expect(t).toMatch(/68%/);
    // The old table claimed Saathi's own fee was 15%, with 5% on discounted plans, and 85% to her.
    expect(t).not.toMatch(/(^|\s)5%/);
    expect(t).not.toMatch(/(^|\s)85%/);
    expect(t).not.toMatch(/discount is shared/i);
    // And it must not promise a payout, because nothing can pay her yet.
    expect(t).not.toMatch(/monthly payout|paid out monthly/i);
    expect(t).toMatch(/cannot pay you yet/i);
  });

  it('covers AI, health data and the medical disclaimer on the legal pages', () => {
    const privacy = text('privacy.html');
    for (const claim of [/sent/i, /never sent/i, /not medical advice/i, /how long/i, /refuse/i]) {
      expect(privacy).toMatch(claim);
    }
    expect(privacy).toMatch(/health data/i);
    expect(privacy).toMatch(/never sold|do not sell/i);
    expect(privacy).toMatch(/Anthropic/);
    expect(privacy).toMatch(/30 days/); // the server-copy deletion window
    const disclaimer = text('disclaimer.html');
    expect(disclaimer).toMatch(/written or read by AI|read by AI/i);
    expect(disclaimer).toMatch(/also doctors|are also doctors/i);
    expect(disclaimer).toMatch(/not a consultation/i);
    expect(text('terms.html')).toMatch(/Plans and AI/i);
  });

  /**
   * Three claims on these pages described protections the code does not have: an encrypted local
   * database (MMKV is opened with no key), a second encryption key for the cycle tables (there is no
   * field encryption on the server) and a passphrase-encrypted Google Drive backup (backup is a sync
   * to her own account). They were corrected on 27 Nov; if one is built, loosen this test with it.
   */
  it('claims no protection the code does not have', () => {
    for (const f of pages) {
      const t = text(f);
      expect(t, f).not.toMatch(/backup to (your own )?(Google Drive|iCloud)|encrypted with your passphrase/i);
      expect(t, f).not.toMatch(/local database encrypted|encrypted with a device-bound key/i);
      expect(t, f).not.toMatch(/additionally encrypted with a key not available/i);
    }
  });

  it('gives every page this slice touched a title, a description and a canonical address', () => {
    for (const f of TOUCHED) {
      const head = read(f).split('</head>')[0] ?? '';
      expect(head, f).toMatch(/<title>[^<]{10,65}<\/title>/);
      expect(head, f).toMatch(/<meta name="description" content="[^"]{50,170}">/);
      expect(head, f).toContain(`<link rel="canonical" href="https://www.saathi-app.com/`);
      expect(head, f).toContain('og:title');
    }
  });

  it('keeps every page on its own scripts, with no outside source and no new dependency', () => {
    for (const f of pages) {
      const html = read(f);
      // An inline script is fine (the policy allows 'unsafe-inline'); a remote one is not.
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      expect(srcs, f).toEqual([]);
      const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1] ?? '');
      for (const href of sheets) expect(href.startsWith('https://fonts.googleapis.com/') || !href.startsWith('http'), `${f}: ${href}`).toBe(true);
      for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
        expect(m[1]!.startsWith('http'), `${f}: ${m[1]}`).toBe(false);
      }
    }
  });

  it('keeps the structured data on the help page valid', () => {
    const blocks = [...read('help.html').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      const parsed = JSON.parse(b[1]!) as { mainEntity?: unknown[] };
      expect(Array.isArray(parsed.mainEntity)).toBe(true);
    }
  });

  it('leaves no unfilled placeholder in the copy this slice wrote', () => {
    // dietitians.html is deliberately a mock-up until the marketplace opens ([PRICE], [City], [DN]).
    for (const f of TOUCHED.filter((p) => p !== 'dietitians.html')) {
      expect(text(f), f).not.toMatch(/\bTODO\b|\bTBD\b|lorem ipsum|\[PRICE\]/i);
    }
  });
});
