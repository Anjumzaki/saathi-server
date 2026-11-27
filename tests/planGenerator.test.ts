import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// requirePremium reads the account from the database; this slice has no database in tests.
const premium = { subscription: { status: 'active', expiresAt: new Date(Date.now() + 86_400_000) }, deletedAt: null };
vi.mock('../src/models/User', () => ({
  User: { findById: () => ({ select: () => ({ lean: async () => premium }) }) },
}));

import { createApp } from '../src/app';
import { planProfileSchema, type PlanProfile } from '../src/schemas/plan';
import {
  AnthropicPlanGenerator, aiNotConfigured, applySafetyRules, buildProfileBrief, createPlanGenerator, foodKeywords,
  type AiPlanGenerator, type GeneratedPlan,
} from '../src/services/anthropicPlanGenerator';
import { normalizeDraft } from '../src/services/planDraft';
import { signAccessToken } from '../src/services/tokens';
import { createStubServices } from '../src/stubs';

const profile = (p: Partial<PlanProfile> = {}): PlanProfile =>
  planProfileSchema.parse({ cuisine: ['Pakistani / desi'], cookMinutes: 30, wakeMin: 420, bedMin: 1380, ...p });

const MODEL_JSON = JSON.stringify({
  title: 'Your week',
  items: [
    { key: 'breakfast', category: 'meal', title: 'Breakfast', time: '08:00', mealKind: 'breakfast', options: [{ label: 'A', text: 'Two eggs with roti' }, { label: 'B', text: 'Oats with milk' }] },
    { key: 'lunch', category: 'meal', title: 'Lunch', time: '13:00', mealKind: 'lunch', details: 'Dal, 1 roti, salad' },
    { key: 'snack', category: 'meal', title: 'Afternoon snack', time: '16:30', mealKind: 'snack', details: 'A fruit and a few nuts' },
    { key: 'dinner', category: 'meal', title: 'Dinner', time: '19:30', mealKind: 'dinner', details: 'Chicken salan with salad' },
    { key: 'walk', category: 'movement', title: 'Evening walk', time: '18:00' },
    { key: 'bed', category: 'sleep', title: 'Bedtime', time: '23:00' },
  ],
  rules: [{ id: 'r1', text: 'Water through the day', source: 'SAATHI' }],
  recipes: [],
  warnings: [],
});

const okFetch = (text: string, stop = 'end_turn') =>
  (async () => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }), { status: 200 })) as unknown as typeof fetch;

describe('what the generator is told about her', () => {
  it('sends only answered questions, as data, and never her tier', () => {
    const brief = buildProfileBrief({ profile: profile({ goals: ['Manage PCOS'], neverFoods: ['Fish'], usualFoods: [] }), note: '  no eggs this week  ' });
    expect(brief).toContain('<answers>');
    expect(brief).toContain('Goals: Manage PCOS');
    expect(brief).toContain('NEVER give her these foods: Fish');
    expect(brief).toContain('Wakes at: 07:00');
    expect(brief).toContain('In her own words: no eggs this week');
    expect(brief).not.toContain('Foods she eats most weeks'); // unanswered questions are left out
    expect(brief.toLowerCase()).not.toContain('premium');
  });
  it('splits food answers into the words that must be matched', () => {
    expect(foodKeywords(['Bitter gourd (karela)', 'Prawns / seafood', 'None', 'No'])).toEqual(['bitter gourd', 'karela', 'prawns', 'seafood']);
  });
});

describe('safety is enforced in code, not left to the prompt', () => {
  const bad = normalizeDraft({
    title: 'Week',
    items: [
      { key: 'b', category: 'meal', title: 'Breakfast', time: '08:00', options: [{ label: 'A', text: 'Fried fish' }, { label: 'B', text: 'Two eggs with roti' }] },
      { key: 'l', category: 'meal', title: 'Karela sabzi', time: '13:00', details: 'Bitter gourd with roti' },
      { key: 's', category: 'supplement', title: 'Inositol 2 g', time: '09:00' },
      { key: 'd', category: 'meal', title: 'Dinner', time: '19:30', details: 'Chicken, about 450 kcal' },
    ],
    rules: [{ id: 'r1', text: 'Water through the day' }, { id: 'r2', text: 'Cinnamon reverses insulin resistance' }],
    recipes: [{ title: 'Fish curry', ingredients: ['fish'], steps: ['cook'] }, { title: 'Daal', ingredients: ['daal'], steps: ['boil'] }],
  });
  const safe = applySafetyRules(bad, profile({ neverFoods: ['Fish', 'Bitter gourd (karela)'], supplements: [] }));

  it('drops a forbidden option and keeps the safe one, relabelled', () => {
    const breakfast = safe.items.find((i) => i.key === 'b')!;
    expect(breakfast.options).toEqual([{ label: 'A', text: 'Two eggs with roti' }]);
    expect(safe.warnings.join(' ')).toMatch(/Took one choice out of "Breakfast"/);
  });
  it('drops a whole item that is itself a forbidden food, and says so', () => {
    expect(safe.items.map((i) => i.key)).not.toContain('l');
    expect(safe.warnings.join(' ')).toMatch(/removed because of a food you avoid/);
  });
  it('never adds supplements or medicines, and drops medical claims and calories', () => {
    expect(safe.items.map((i) => i.key)).not.toContain('s');
    expect(safe.rules.map((r) => r.text)).toEqual(['Water through the day']);
    expect(safe.recipes.map((r) => r.title)).toEqual(['Daal']);
    expect(safe.items.find((i) => i.key === 'd')!.details).toBeUndefined();
  });
  it('keeps a plan she has no restrictions on untouched', () => {
    const clean = applySafetyRules(normalizeDraft(JSON.parse(MODEL_JSON)), profile());
    expect(clean.items).toHaveLength(6);
    expect(clean.warnings.join(' ')).not.toMatch(/removed/);
  });
});

describe('AnthropicPlanGenerator', () => {
  it('writes a draft and runs the plan check over it', async () => {
    let sent: any;
    const f = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n' + MODEL_JSON + '\n```' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new AnthropicPlanGenerator({ apiKey: 'k', model: 'm', fetchImpl: f }).generate({ profile: profile({ waterTargetCups: 8 }) });
    expect(sent.model).toBe('m');
    expect(sent.system).toMatch(/No medical claims/);
    expect(r.draft).toMatchObject({ title: 'Your week', source: 'anthropic', isSample: false });
    expect(r.draft.items.map((i) => i.title)).toEqual(['Breakfast', 'Lunch', 'Afternoon snack', 'Dinner', 'Evening walk', 'Bedtime']);
    expect(r.check.verdict).toBe('good');
  });
  it('folds what the plan check found into the warnings she reviews', async () => {
    const r = await new AnthropicPlanGenerator({ apiKey: 'k', model: 'm', fetchImpl: okFetch(MODEL_JSON) }).generate({ profile: profile() });
    expect(r.check.tweaks.map((t) => t.id)).toContain('water-missing'); // no water target answered
    expect(r.draft.warnings.join(' ')).toMatch(/No water target/);
  });
  it('maps a broken answer and a dead API to typed errors', async () => {
    const g = (f: typeof fetch) => new AnthropicPlanGenerator({ apiKey: 'k', model: 'm', fetchImpl: f }).generate({ profile: profile() });
    await expect(g(okFetch('sorry, I cannot'))).rejects.toMatchObject({ status: 502, code: 'ai_unusable' });
    await expect(g((async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)).rejects.toMatchObject({ status: 503, code: 'ai_unavailable' });
    await expect(g((async () => { throw new Error('net'); }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 503, code: 'ai_unavailable' });
  });
  it('notes a plan that was cut short', async () => {
    const r = await new AnthropicPlanGenerator({ apiKey: 'k', model: 'm', fetchImpl: okFetch(MODEL_JSON, 'max_tokens') }).generate({ profile: profile() });
    expect(r.draft.warnings.join(' ')).toMatch(/end may be missing/);
  });
  it('has no generator at all when the key is missing', () => {
    expect(createPlanGenerator({ ANTHROPIC_MODEL: 'm' })).toBeNull();
    expect(createPlanGenerator({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' })).toBeInstanceOf(AnthropicPlanGenerator);
    expect(aiNotConfigured()).toMatchObject({ status: 503, code: 'ai_not_configured' });
  });
});

describe('POST /v1/plans/generate-ai', () => {
  let server: Server;
  let base: string;
  let generator: AiPlanGenerator | undefined;
  const calls: unknown[] = [];
  const stub: AiPlanGenerator = {
    async generate(input) {
      calls.push(input);
      return new AnthropicPlanGenerator({ apiKey: 'k', model: 'm', fetchImpl: okFetch(MODEL_JSON) }).generate(input) as Promise<GeneratedPlan>;
    },
  };

  beforeAll(() => {
    const services = { ...createStubServices({ production: false, allowStubInProduction: false }), get aiPlanGenerator() { return generator; } };
    server = createApp(services).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, userId: string) =>
    fetch(`${base}/v1/plans/generate-ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signAccessToken(userId, ['client'])}` },
      body: JSON.stringify(body),
    });

  it('needs a signed-in account', async () => {
    expect((await fetch(`${base}/v1/plans/generate-ai`, { method: 'POST' })).status).toBe(401);
  });

  it('returns a draft for review and saves nothing', async () => {
    generator = stub;
    const r = await post({ profile: { cuisine: ['Pakistani / desi'], neverFoods: ['Fish'], cookMinutes: 30, premium: true, tier: 'plus' }, note: 'light dinners' }, '507f1f77bcf86cd799439011');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { draft: { source: string }; check: { verdict: string } };
    expect(body).toMatchObject({ saved: false, requiresReview: true });
    expect(body.draft.source).toBe('anthropic');
    expect(body.check.verdict).toBeTruthy();
    // The client's idea of her tier is dropped by the schema; only requirePremium decides.
    expect(Object.keys((calls[0] as { profile: object }).profile)).not.toContain('premium');
    expect((calls[0] as { note: string }).note).toBe('light dinners');
  });

  it('validates her answers', async () => {
    generator = stub;
    const r = await post({ profile: { cookMinutes: 9000 } }, '507f1f77bcf86cd799439011');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('says plainly that the AI is not set up when there is no key', async () => {
    generator = undefined; // ANTHROPIC_API_KEY missing
    const r = await post({ profile: {} }, '507f1f77bcf86cd799439012');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('ai_not_configured');
  });

  it('shares the reader’s hourly limit, because it costs the same', async () => {
    generator = stub;
    const user = '507f1f77bcf86cd799439013';
    let last = 0;
    for (let i = 0; i < 13; i++) last = (await post({ profile: { cuisine: ['Indian'] } }, user)).status;
    expect(last).toBe(429);
  });
});
