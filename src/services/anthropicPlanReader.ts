import type { AiPlanDraft, AiPlanReader, PlanReadInput } from '../interfaces';
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';
import { extractJson, normalizeDraft } from './planDraft';
import { OpenaiPlanReader } from './openaiPlanReader';
import { READER_SYSTEM_PROMPT, type AiProviderConfig } from './planSafety';

// The prompt now lives in planSafety.ts, shared with the OpenAI reader so both are told the same rules.
export { READER_SYSTEM_PROMPT as SYSTEM_PROMPT } from './planSafety';

export interface AnthropicOptions { apiKey: string; model: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number }

type Block = { type: 'text'; text: string } | { type: 'document' | 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Builds the user message for text, a PDF, or an image. Exported for tests. */
export function buildContent(input: PlanReadInput): Block[] {
  if (input.file) {
    const kind = input.file.mediaType === 'application/pdf' ? 'document' : 'image';
    return [
      { type: kind, source: { type: 'base64', media_type: input.file.mediaType, data: input.file.dataBase64 } },
      { type: 'text', text: 'Read this plan and return the JSON.' },
    ];
  }
  return [{ type: 'text', text: `Here is the plan text:\n\n<document>\n${input.text ?? ''}\n</document>\n\nReturn the JSON.` }];
}

/** Reads plans with the Anthropic Messages API. Never stores the document; the route returns a draft for review. */
export class AnthropicPlanReader implements AiPlanReader {
  private readonly f: typeof fetch;
  constructor(private readonly o: AnthropicOptions) { this.f = o.fetchImpl ?? fetch; }

  async read(input: PlanReadInput): Promise<AiPlanDraft> {
    if (!input.text && !input.file) throw new ApiError(400, 'bad_request', 'Send the plan as text, a PDF or a photo.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 90_000);
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.o.model, max_tokens: 8000, system: READER_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildContent(input) }] }),
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(503, 'ai_unavailable', "We couldn't reach the reader just now. Please try again in a minute.");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      log.error('plan reader failed', { provider: 'anthropic', status: res.status }); // never the document, never the key
      if (res.status === 413 || res.status === 400) throw new ApiError(422, 'unreadable', "This file couldn't be read. Try a clearer photo or a smaller PDF, or paste the text.");
      throw new ApiError(503, 'ai_unavailable', "We couldn't read your plan just now. Please try again in a minute.");
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    let draft;
    try {
      draft = normalizeDraft(extractJson(text));
    } catch {
      throw new ApiError(422, 'unreadable', "We couldn't turn this into a plan. Try a clearer photo, or paste the text.");
    }
    if (data.stop_reason === 'max_tokens') draft.warnings.push('The plan was long, so the end may be missing. Please check it.');
    return { ...draft, isSample: false, source: 'anthropic' };
  }
}

/**
 * The reader for a configured provider. Takes the config `pickAiProvider` resolved, so the caller can say
 * in one log line which provider is reading her plans.
 */
export function createPlanReader(ai: AiProviderConfig): AiPlanReader {
  return ai.provider === 'openai'
    ? new OpenaiPlanReader({ apiKey: ai.apiKey, model: ai.model })
    : new AnthropicPlanReader({ apiKey: ai.apiKey, model: ai.model });
}
