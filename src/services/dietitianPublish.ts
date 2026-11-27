/**
 * The gate a plan passes before it reaches a client. Pure.
 *
 * Two kinds of finding, kept apart on purpose: a `blocking` problem is the plan being broken (nothing
 * to send, a meal with no time, two items sharing a key) and can never be published; the structural
 * plan check's tweaks are advice, so they do not block — but she has to have seen each one, which is
 * what makes publishing deliberate rather than a stray tap.
 */
import { planContentSchema, type PlanContent } from '../schemas/plan';
import { DEFAULT_CHECK_CONFIG, checkPlan, type CheckItem, type CheckResult } from './planCheck';

export interface PublishProblem {
  code: 'invalid' | 'empty' | 'no_meals' | 'meal_without_time' | 'duplicate_key';
  message: string;
}

export interface PublishReview {
  blocking: PublishProblem[];
  /** The existing structural check, run over the plan she is about to send. */
  check: CheckResult;
  /** Every tweak id she must have seen before this can go. */
  tweakIds: string[];
  publishable: boolean;
}

export interface PublishOptions {
  /** Daily water target, so the check does not report a missing one for a plan that has it elsewhere. */
  waterTargetMl?: number | null;
  /** Tweak ids she has read. Publishing needs all of them. */
  acknowledgedTweakIds?: string[];
}

const toCheckItems = (content: PlanContent): CheckItem[] =>
  content.items.map((i) => ({
    key: i.key, category: i.category, title: i.title, time: i.time, endTime: i.endTime,
    daysOfWeek: i.daysOfWeek, mealKind: i.mealKind, options: i.options, details: i.details,
  }));

function structuralProblems(content: PlanContent): PublishProblem[] {
  const out: PublishProblem[] = [];
  if (content.items.length === 0) out.push({ code: 'empty', message: 'There is nothing in this plan yet.' });
  const meals = content.items.filter((i) => i.category === 'meal');
  if (content.items.length > 0 && meals.length === 0) out.push({ code: 'no_meals', message: 'A plan needs at least one meal.' });
  for (const m of meals) {
    if (!m.time) out.push({ code: 'meal_without_time', message: `"${m.title}" has no time. A meal needs one to remind her.` });
  }
  const seen = new Set<string>();
  for (const i of content.items) {
    if (seen.has(i.key)) out.push({ code: 'duplicate_key', message: `Two items share the name "${i.key}".` });
    seen.add(i.key);
  }
  return out;
}

const emptyCheck: CheckResult = { verdict: 'needs_work', tweaks: [], good: [] };

/** Review a plan before it is published. Accepts unvalidated input: a plan that fails the schema blocks. */
export function reviewPlanForPublish(input: unknown, opts: PublishOptions = {}): PublishReview {
  const parsed = planContentSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.');
    return {
      blocking: [{ code: 'invalid', message: `This plan cannot be sent as it is${where ? ` (${where}: ${first?.message})` : ''}.` }],
      check: emptyCheck, tweakIds: [], publishable: false,
    };
  }
  const content = parsed.data;
  const blocking = structuralProblems(content);
  const check = checkPlan(toCheckItems(content), { ...DEFAULT_CHECK_CONFIG, waterTargetMl: opts.waterTargetMl ?? null });
  const tweakIds = check.tweaks.map((t) => t.id);
  const seen = new Set(opts.acknowledgedTweakIds ?? []);
  const allSeen = tweakIds.every((id) => seen.has(id));
  return { blocking, check, tweakIds, publishable: blocking.length === 0 && allSeen };
}

/** Why a publish was refused, for the API response and for her. */
export function publishRefusal(r: PublishReview): string | null {
  if (r.blocking.length) return r.blocking[0]!.message;
  if (!r.publishable) return 'Read the notes on the plan before you send it.';
  return null;
}
