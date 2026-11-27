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

// ---------- "Let Saathi write it": what the app may tell the generator about her ----------

/** Labels, not option ids: the model reads them. Long lists are capped so one request stays small. */
const labels = (max: number, len = 80) => z.array(z.string().min(1).max(len)).max(max).default([]);
const minuteOfDay = z.number().int().min(0).max(1439);

/**
 * Everything the generator is allowed to know. Nothing about her account: her tier is read from the
 * database by `requirePremium`, never from this body, and unknown keys are stripped rather than trusted.
 */
export const planProfileSchema = z.object({
  goals: labels(12),
  cuisine: labels(8),
  dietPattern: labels(12),
  allergies: labels(12),
  usualFoods: labels(30),
  neverFoods: labels(30),
  drinks: labels(12),
  kitchenTools: labels(12),
  supplements: labels(20),
  fasting: labels(8),
  exerciseTypes: labels(14),
  movementBarriers: labels(12),
  sleepIssues: labels(8),
  cycleSymptoms: labels(10),
  /** Who cooks, and how long she has: both change what can be suggested. */
  cooks: z.string().max(60).optional(),
  cookMinutes: z.number().int().min(0).max(240).optional(),
  spice: z.enum(['mild', 'medium', 'hot']).optional(),
  workKind: z.string().max(40).optional(),
  fitnessLevel: z.string().max(60).optional(),
  walkWhere: z.string().max(60).optional(),
  walkWhen: z.string().max(60).optional(),
  cyclePattern: z.string().max(60).optional(),
  country: z.string().max(60).optional(),
  // Saathi is an 18+ app (see terms.html), so the body numbers start at an adult's. The old floors
  // (age 13, height 80 cm, weight 25 kg) described a child, and this body is what reaches the model.
  heightCm: z.number().min(120).max(250).optional(),
  weightKg: z.number().min(30).max(400).optional(),
  weightGoalKg: z.number().min(30).max(400).optional(),
  age: z.number().int().min(18).max(100).optional(),
  wakeMin: minuteOfDay.optional(),
  bedMin: minuteOfDay.optional(),
  mainMeals: z.number().int().min(1).max(5).optional(),
  snacks: z.number().int().min(0).max(4).optional(),
  waterTargetCups: z.number().int().min(0).max(20).optional(),
  stepTarget: z.number().int().min(0).max(40_000).optional(),
  workoutSlots: z
    .array(z.object({ kind: z.string().max(30), weekday: z.number().int().min(0).max(6), startMin: minuteOfDay }))
    .max(14)
    .default([]),
});
export type PlanProfile = z.infer<typeof planProfileSchema>;
