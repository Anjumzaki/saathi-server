/**
 * "Let Saathi write it": a week's plan written from what the app already knows about her, in the same draft
 * shape the reader produces, so review, edit and install stay one path. Nothing is saved here.
 *
 * The model is never the last word on safety: whatever comes back is normalised (planDraft), then every
 * "never" food and allergy is enforced in code, medical claims are dropped, and the structural plan check
 * runs. Those rules, the prompt and the profile brief live in planSafety.ts, shared with the OpenAI
 * generator, so a plan written by either provider goes through the same gate.
 */
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';
import { extractJson, normalizeDraft, type NormalizedDraft } from './planDraft';
import { OpenaiPlanGenerator } from './openaiPlanGenerator';
import {
  GENERATOR_SYSTEM_PROMPT, applySafetyRules, buildProfileBrief, pickAiProvider, withPlanCheck,
  type AiEnv, type AiPlanGenerator, type GeneratedPlan, type PlanGenerateInput,
} from './planSafety';

// Kept on this module because the rest of the server has always imported them from here.
export {
  aiNotConfigured, applySafetyRules, buildProfileBrief, foodKeywords, line, withPlanCheck,
  GENERATOR_SYSTEM_PROMPT as SYSTEM_PROMPT,
  type AiPlanGenerator, type GeneratedPlan, type PlanGenerateInput,
} from './planSafety';

export interface AnthropicOptions { apiKey: string; model: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number }

export class AnthropicPlanGenerator implements AiPlanGenerator {
  private readonly f: typeof fetch;
  constructor(private readonly o: AnthropicOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  async generate(input: PlanGenerateInput): Promise<GeneratedPlan> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.o.model,
          max_tokens: 8000,
          system: GENERATOR_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildProfileBrief(input) }] }],
        }),
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(503, 'ai_unavailable', "We couldn't reach Saathi's writer just now. Please try again in a minute.");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      log.error('plan generator failed', { provider: 'anthropic', status: res.status }); // never her answers, never the key
      throw new ApiError(503, 'ai_unavailable', "We couldn't write your plan just now. Please try again in a minute.");
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    let draft: NormalizedDraft;
    try {
      draft = normalizeDraft(extractJson(text));
    } catch {
      throw new ApiError(502, 'ai_unusable', "Saathi couldn't write a usable plan this time. Please try again.");
    }
    if (data.stop_reason === 'max_tokens') draft.warnings.push('The plan was long, so the end may be missing. Please check it.');
    return withPlanCheck(applySafetyRules(draft, input.profile), input.profile);
  }
}

/** null when neither key is set: the route then returns `ai_not_configured` rather than a faked plan. */
export function createPlanGenerator(env: AiEnv): AiPlanGenerator | null {
  const ai = pickAiProvider(env);
  if (!ai) return null;
  return ai.provider === 'openai'
    ? new OpenaiPlanGenerator({ apiKey: ai.apiKey, model: ai.model })
    : new AnthropicPlanGenerator({ apiKey: ai.apiKey, model: ai.model });
}
