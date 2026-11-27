/**
 * Reads a plan with OpenAI, behind the same `AiPlanReader` seam as the Anthropic reader: the same prompt
 * (planSafety.ts), the same normalisation, the same typed errors the app already knows how to show.
 *
 * Plain `fetch` against the Responses API, with no SDK, and the draft is asked for as structured output
 * against a JSON schema rather than hoped for in prose. `fetchImpl` is injectable so the whole path can be
 * tested with a stub. The document is never stored and never logged.
 */
import type { AiPlanDraft, AiPlanReader, PlanReadInput } from '../interfaces';
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';
import { extractJson, normalizeDraft } from './planDraft';
import { OPENAI_SOURCE, READER_SYSTEM_PROMPT, READ_CATEGORIES, planDraftJsonSchema } from './planSafety';

export interface OpenaiOptions { apiKey: string; model: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number }

/** The largest answer either service asks for. A week of meals is well inside it. */
export const MAX_OUTPUT_TOKENS = 8000;

type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; filename: string; file_data: string };

/** Builds the user message for text, a PDF, or an image. Exported for tests. */
export function buildInput(input: PlanReadInput): InputPart[] {
  if (input.file) {
    const dataUrl = `data:${input.file.mediaType};base64,${input.file.dataBase64}`;
    return [
      input.file.mediaType === 'application/pdf'
        ? { type: 'input_file', filename: 'plan.pdf', file_data: dataUrl }
        : { type: 'input_image', image_url: dataUrl, detail: 'auto' },
      { type: 'input_text', text: 'Read this plan and return the JSON.' },
    ];
  }
  return [{ type: 'input_text', text: `Here is the plan text:\n\n<document>\n${input.text ?? ''}\n</document>\n\nReturn the JSON.` }];
}

/** What one answer amounts to: the text it carries, whether it was refused, whether it ran out of room. */
export interface OpenaiOutcome { text: string; refusal: string | null; truncated: boolean }

/**
 * Either an answer or the reason there is none. A discriminated result rather than a thrown error, because
 * the reader and the generator word their failures differently for her.
 */
export type OpenaiResult =
  | { ok: true; outcome: OpenaiOutcome }
  | { ok: false; reason: 'network' }
  | { ok: false; reason: 'http'; status: number };

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] | null }[] | null;
}

/** Pure: pulls the text, a refusal and "it was cut off" out of a Responses answer. Exported for tests. */
export function readOutcome(data: unknown): OpenaiOutcome {
  const body = (data ?? {}) as ResponsesBody;
  const parts = (body.output ?? []).flatMap((o) => o.content ?? []);
  const refused = parts.find((p) => p?.type === 'refusal')?.refusal?.trim();
  const reason = body.incomplete_details?.reason;
  // Either marker on its own means a half-answer, so neither is trusted alone.
  const incomplete = body.status === 'incomplete' || !!reason;
  return {
    text: parts.filter((p) => p?.type === 'output_text').map((p) => p.text ?? '').join('\n'),
    // The safety filter stopping mid-answer is a refusal, not a long plan: it must not read as "try again".
    refusal: refused || (incomplete && reason && reason !== 'max_output_tokens' ? reason : null),
    truncated: incomplete && (!reason || reason === 'max_output_tokens'),
  };
}

/**
 * One Responses API call. Shared by both OpenAI services (they are the only two callers, and the slice may
 * not add another file for it). The key goes in the header and into nothing else: no log line here or in
 * either caller carries the key or the request body.
 */
export async function callOpenaiResponses(o: OpenaiOptions, body: Record<string, unknown>, timeoutMs: number): Promise<OpenaiResult> {
  const f = o.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await f(`${o.baseUrl ?? 'https://api.openai.com'}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { ok: false, reason: 'http', status: res.status };
  try {
    return { ok: true, outcome: readOutcome(await res.json()) };
  } catch {
    // A 200 whose body is not JSON at all: nothing came back that could be a plan.
    return { ok: true, outcome: { text: '', refusal: null, truncated: false } };
  }
}

/** The request body for a read. Exported so a test can see the prompt and the schema that were sent. */
export function readRequest(o: { model: string }, input: PlanReadInput): Record<string, unknown> {
  return {
    model: o.model,
    instructions: READER_SYSTEM_PROMPT,
    input: [{ role: 'user', content: buildInput(input) }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text: { format: planDraftJsonSchema({ name: 'plan_draft', categories: READ_CATEGORIES, ruleSource: 'DIETITIAN' }) },
  };
}

export class OpenaiPlanReader implements AiPlanReader {
  constructor(private readonly o: OpenaiOptions) {}

  async read(input: PlanReadInput): Promise<AiPlanDraft> {
    if (!input.text && !input.file) throw new ApiError(400, 'bad_request', 'Send the plan as text, a PDF or a photo.');
    const r = await callOpenaiResponses(this.o, readRequest(this.o, input), this.o.timeoutMs ?? 90_000);
    if (!r.ok) {
      if (r.reason === 'http') {
        log.error('plan reader failed', { provider: 'openai', status: r.status }); // never the document, never the key
        if (r.status === 413 || r.status === 400) throw new ApiError(422, 'unreadable', "This file couldn't be read. Try a clearer photo or a smaller PDF, or paste the text.");
      }
      throw new ApiError(503, 'ai_unavailable', "We couldn't read your plan just now. Please try again in a minute.");
    }
    const { text, refusal, truncated } = r.outcome;
    if (refusal) {
      log.warn('plan reader refused the document', { provider: 'openai' }); // the refusal text is not hers to see
      throw new ApiError(422, 'ai_refused', "The reader wouldn't read this document. Please paste the text of your plan instead.");
    }
    // Half a plan is worse than none: she would install a week with the evenings missing without knowing.
    if (truncated) throw new ApiError(422, 'ai_truncated', 'This plan was too long to read in one go. Try one page at a time, or paste the text.');
    let draft;
    try {
      draft = normalizeDraft(extractJson(text));
    } catch {
      throw new ApiError(422, 'unreadable', "We couldn't turn this into a plan. Try a clearer photo, or paste the text.");
    }
    return { ...draft, isSample: false, source: OPENAI_SOURCE };
  }
}
