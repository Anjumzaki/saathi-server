import { describe, expect, it } from 'vitest';
import { AnthropicPlanReader, buildContent } from '../src/services/anthropicPlanReader';
import { extractJson, normalizeDraft, toHhmm } from '../src/services/planDraft';

describe('toHhmm', () => {
  it('reads common time spellings', () => {
    expect(toHhmm('8')).toBe('08:00');
    expect(toHhmm('8:30 pm')).toBe('20:30');
    expect(toHhmm('12am')).toBe('00:00');
    expect(toHhmm('12 pm')).toBe('12:00');
    expect(toHhmm('07.15')).toBe('07:15');
    expect(toHhmm('25:00')).toBeUndefined();
    expect(toHhmm('soon')).toBeUndefined();
  });
});

describe('extractJson', () => {
  it('handles fences and surrounding text', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":2} thanks')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('normalizeDraft', () => {
  it('cleans items, keeps good ones and warns about the rest', () => {
    const d = normalizeDraft({
      title: ' Dr Sana plan ',
      items: [
        { title: 'Breakfast', category: 'food', time: '8am', mealKind: 'breakfast', options: ['2 eggs', { text: 'Oats' }] },
        { title: '', category: 'meal' },
        { title: 'Vitamin D', category: 'supplements', time: '21:00', key: 'x' },
        { title: 'Vitamin D', category: 'supplement', time: '09:00', key: 'x' },
        { title: 'Walk' },
      ],
      rules: [{ text: 'No tea with iron' }, 'Drink water'],
      recipes: [{ title: 'Oats', ingredients: ['oats'], steps: ['cook'] }],
    });
    expect(d.title).toBe('Dr Sana plan');
    expect(d.items.map((i) => i.title)).toEqual(['Breakfast', 'Vitamin D', 'Vitamin D', 'Walk']);
    expect(d.items[0]).toMatchObject({ category: 'meal', time: '08:00', mealKind: 'breakfast' });
    expect(d.items[0]!.options).toEqual([{ label: 'A', text: '2 eggs' }, { label: 'B', text: 'Oats' }]);
    expect(d.items[1]!.category).toBe('supplement');
    expect(new Set(d.items.map((i) => i.key)).size).toBe(4);
    expect(d.rules).toHaveLength(2);
    expect(d.rules[0]!.source).toBe('DIETITIAN');
    expect(d.warnings.join(' ')).toMatch(/had no title/);
    expect(d.warnings.join(' ')).toMatch(/no time/);
  });
  it('warns when nothing is found', () => {
    expect(normalizeDraft({}).warnings.join(' ')).toMatch(/No meals/);
    expect(normalizeDraft(null).items).toEqual([]);
  });
});

describe('AnthropicPlanReader', () => {
  const ok = (text: string, stop = 'end_turn') => (async () => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }), { status: 200 })) as unknown as typeof fetch;
  it('sends a PDF as a document block and returns a normalised draft', async () => {
    let body: any;
    const f = (async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"title":"T","items":[{"title":"Lunch","category":"meal","time":"13:00"}]}' }] }), { status: 200 }); }) as unknown as typeof fetch;
    const d = await new AnthropicPlanReader({ apiKey: 'k', model: 'm', fetchImpl: f }).read({ file: { mediaType: 'application/pdf', dataBase64: 'QUJD' } });
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf', data: 'QUJD' } });
    expect(d).toMatchObject({ source: 'anthropic', isSample: false, title: 'T' });
    expect(d.items[0]!.time).toBe('13:00');
  });
  it('uses an image block for photos and a text block for pasted text', () => {
    expect(buildContent({ file: { mediaType: 'image/jpeg', dataBase64: 'AA' } })[0]!.type).toBe('image');
    expect(buildContent({ text: 'Breakfast 8am' })[0]).toMatchObject({ type: 'text' });
  });
  it('maps failures to friendly errors', async () => {
    const r = (f: typeof fetch) => new AnthropicPlanReader({ apiKey: 'k', model: 'm', fetchImpl: f }).read({ text: 'x' });
    await expect(r(ok('not json at all'))).rejects.toMatchObject({ status: 422 });
    await expect(r((async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)).rejects.toMatchObject({ status: 503 });
    await expect(r((async () => { throw new Error('net'); }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 503 });
  });
  it('notes when the answer was cut short', async () => {
    const d = await new AnthropicPlanReader({ apiKey: 'k', model: 'm', fetchImpl: ok('{"items":[{"title":"A","time":"8"}]}', 'max_tokens') }).read({ text: 'x' });
    expect(d.warnings.join(' ')).toMatch(/end may be missing/);
  });
});
