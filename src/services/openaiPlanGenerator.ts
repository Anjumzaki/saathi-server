/**
 * "Let Saathi write it", written by OpenAI. The same seam, the same prompt and the same safety gate as the
 * Anthropic generator: both import them from planSafety.ts, so neither prompt nor provider decides what is
 * safe. Whatever comes back is normalised, every "never" food and allergy is enforced in code, supplements
 * and medical claims are stripped, and the structural plan check runs before she ever sees a draft.
 *
 * Plain `fetch` against the Responses API, no SDK, with the draft asked for as structured output against a
 * JSON schema. `fetchImpl` is injectable so the whole path is testable with a stub. Nothing is saved here.
 */
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';
import { extractJson, normalizeDraft, type NormalizedDraft } from './planDraft';
import { MAX_OUTPUT_TOKENS, callOpenaiResponses, type OpenaiOptions } from './openaiPlanReader';
import {
  GENERATOR_SYSTEM_PROMPT, OPENAI_SOURCE, WRITE_CATEGORIES, applySafetyRules, buildProfileBrief,
  planDraftJsonSchema, withPlanCheck, type AiPlanGenerator, type GeneratedPlan, type PlanGenerateInput,
} from './planSafety';

export type { OpenaiOptions };

/** The request body for a week. Exported so a test can see the prompt and the schema that were sent. */
export function generateRequest(o: { model: string }, input: PlanGenerateInput): Record<string, unknown> {
  return {
    model: o.model,
    instructions: GENERATOR_SYSTEM_PROMPT,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildProfileBrief(input) }] }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text: { format: planDraftJsonSchema({ name: 'plan_week', categories: WRITE_CATEGORIES, ruleSource: 'SAATHI' }) },
  };
}

export class OpenaiPlanGenerator implements AiPlanGenerator {
  constructor(private readonly o: OpenaiOptions) {}

  async generate(input: PlanGenerateInput): Promise<GeneratedPlan> {
    const r = await callOpenaiResponses(this.o, generateRequest(this.o, input), this.o.timeoutMs ?? 120_000);
    if (!r.ok) {
      // Her answers and the key stay out of the logs; the status is all that helps anyone.
      log.error('plan generator failed', { provider: 'openai', ...(r.reason === 'http' ? { status: r.status } : { network: true }) });
      throw new ApiError(503, 'ai_unavailable', "We couldn't write your plan just now. Please try again in a minute.");
    }
    const { text, refusal, truncated } = r.outcome;
    if (refusal) {
      log.warn('plan generator refused', { provider: 'openai' });
      throw new ApiError(502, 'ai_refused', "Saathi couldn't write your plan this time. Please try again, or build it yourself.");
    }
    // A week that stops at Wednesday lunch is not a week, so none of it is used.
    if (truncated) throw new ApiError(502, 'ai_truncated', "Saathi's plan came back unfinished, so it was not used. Please try again.");
    let draft: NormalizedDraft;
    try {
      draft = normalizeDraft(extractJson(text));
    } catch {
      throw new ApiError(502, 'ai_unusable', "Saathi couldn't write a usable plan this time. Please try again.");
    }
    return withPlanCheck(applySafetyRules(draft, input.profile), input.profile, OPENAI_SOURCE);
  }
}
