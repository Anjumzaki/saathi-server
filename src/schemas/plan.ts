import { z } from 'zod';

export const CATEGORIES = ['meal', 'supplement', 'movement', 'selfcare', 'cycle', 'sleep'] as const;
export const RULE_SOURCES = ['DIETITIAN', 'SAATHI', 'OWN'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const planItemSchema = z.object({
  /** Stable id of the item across versions (used for diffs). */
  key: z.string().min(1).max(64),
  category: z.enum(CATEGORIES),
  title: z.string().min(1).max(200),
  time: hhmm.optional(),
  endTime: hhmm.optional(),
  /** 0=Sunday..6=Saturday. Empty/omitted = every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  tier: z.enum(['alarm', 'notification']).default('notification'),
  /** Meals only; unset meals are treated as main meals. */
  mealKind: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
  options: z
    .array(z.object({ label: z.enum(['A', 'B', 'C']), text: z.string().min(1).max(500) }))
    .max(3)
    .default([]),
  details: z.string().max(2000).optional(),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const planRuleSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  source: z.enum(RULE_SOURCES),
});
export type PlanRule = z.infer<typeof planRuleSchema>;

export const recipeSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  ingredients: z.array(z.string().max(200)).max(60).default([]),
  steps: z.array(z.string().max(1000)).max(40).default([]),
  notes: z.string().max(1000).optional(),
});
export type Recipe = z.infer<typeof recipeSchema>;

export const planContentSchema = z.object({
  items: z.array(planItemSchema).max(200),
  rules: z.array(planRuleSchema).max(100).default([]),
  recipes: z.array(recipeSchema).max(100).default([]),
});
export type PlanContent = z.infer<typeof planContentSchema>;
