/** Idempotent seed: inserts defaults only where missing, so admin edits are never overwritten. */
import mongoose from 'mongoose';
import { getEnv } from './config/env';
import seedData from './data/datasets-seed.json';
import { Dataset } from './models/Dataset';
import { FeeConfigModel, PackageConfig } from './models/PackageConfig';
import { RegionPack } from './models/RegionPack';
import { User } from './models/User';
import { DEFAULT_FEE_CONFIG } from './services/feeConfig';
import { applyDiscount } from './services/money';
import { log } from './utils/logger';

/** Sample price points in minor units. ILLUSTRATIVE ONLY: set real prices through the admin API. */
const COUNTRIES = [
  { country: 'PK', currency: 'PKR' },
  { country: 'IN', currency: 'INR' },
  { country: 'AE', currency: 'AED' },
  { country: 'GB', currency: 'GBP' },
  { country: 'US', currency: 'USD' },
] as const;
const BANDS: { id: string; label: string; major: Record<string, number> }[] = [
  { id: 'band_a', label: 'Starter plan', major: { PK: 3000, IN: 1200, AE: 99, GB: 25, US: 30 } },
  { id: 'band_b', label: 'Standard plan', major: { PK: 6000, IN: 2500, AE: 199, GB: 50, US: 60 } },
  { id: 'band_c', label: 'Complete plan', major: { PK: 10000, IN: 4000, AE: 349, GB: 85, US: 100 } },
];
const PREMIUM_SUB: Record<string, { monthly: number; yearly: number }> = {
  PK: { monthly: 1000, yearly: 9000 }, IN: { monthly: 399, yearly: 3499 }, AE: { monthly: 19, yearly: 169 }, GB: { monthly: 4.99, yearly: 44.99 }, US: { monthly: 5.99, yearly: 54.99 },
};
/** PLACEHOLDERS. Premium Plus carries the cost of real dietitian time; set the real prices in the admin API. */
const PLUS_SUB: Record<string, { monthly: number; yearly: number }> = {
  PK: { monthly: 2500, yearly: 22500 }, IN: { monthly: 999, yearly: 8999 }, AE: { monthly: 49, yearly: 449 }, GB: { monthly: 12.99, yearly: 119.99 }, US: { monthly: 14.99, yearly: 139.99 },
};
const minor = (x: number) => Math.round(x * 100);

/** The trial is the same length on both packages, and the store takes the first payment when it ends. */
const TRIAL_DAYS = 7;

/**
 * What each package opens. The server is the authority (see services/entitlement), but the config carries
 * the same list so a package can be re-cut without an app release.
 */
const PREMIUM_PKG_FEATURES = ['plan_read_ai', 'plan_generate_ai', 'guided_routines', 'local_produce', 'partner_view', 'dietitian_discount', 'merchant_discount', 'watch_access'];
const PLUS_PKG_FEATURES = [...PREMIUM_PKG_FEATURES, 'representative_help', 'saathi_plan_request'];

/** Paywall copy, in order. Merchant discounts and watch access are deliberately not advertised. */
const PREMIUM_PERKS = [
  'Read your plan from a PDF, photo or pasted text',
  'Let Saathi write a plan around your days',
  'Guided strength and yoga routines',
  'Produce that is in season where you live',
  'Let someone you trust follow along and cheer you on',
  'A lower price on a dietitian plan, once your first payment goes through',
];
const PLUS_PERKS = [
  'Everything in Premium',
  'Chat with a Saathi dietitian whenever something is unclear',
  'Ask a Saathi dietitian to write your plan for you',
];

export const REGION_PACKS = [
  { country: 'PK', name: 'Pakistan', quietHourProvider: true, powerCutMode: true, produce: ['okra', 'spinach', 'cauliflower', 'mango', 'guava', 'dates'], proteinKeywords: ['anda', 'daal', 'dal', 'chana', 'lobia', 'dahi', 'chicken', 'gosht', 'machli', 'paneer'] },
  { country: 'IN', name: 'India', quietHourProvider: true, powerCutMode: true, produce: ['palak', 'bhindi', 'lauki', 'banana', 'papaya', 'amla'], proteinKeywords: ['anda', 'dal', 'rajma', 'chana', 'paneer', 'dahi', 'curd', 'sprouts', 'soya', 'chicken'] },
  { country: 'AE', name: 'United Arab Emirates', quietHourProvider: false, powerCutMode: false, produce: ['dates', 'tomato', 'cucumber', 'zucchini', 'orange'], proteinKeywords: ['labneh', 'hummus', 'foul', 'ful', 'chicken', 'lamb', 'fish', 'egg', 'halloumi'] },
  { country: 'GB', name: 'United Kingdom', quietHourProvider: false, powerCutMode: false, produce: ['apple', 'pear', 'kale', 'leek', 'parsnip', 'berries'], proteinKeywords: ['egg', 'beans', 'cottage cheese', 'skyr', 'greek yogurt', 'chicken', 'fish', 'tofu', 'quorn'] },
  { country: 'US', name: 'United States', quietHourProvider: false, powerCutMode: false, produce: ['apple', 'broccoli', 'sweet potato', 'blueberries', 'avocado'], proteinKeywords: ['egg', 'turkey', 'chicken', 'beans', 'greek yogurt', 'cottage cheese', 'tofu', 'tempeh', 'protein shake'] },
] as const;

type SeedOption = { id: string; label: string; icon?: string; tags?: string[]; regions?: string[] };
type SeedDataset = { key: string; question: string; selection: 'single' | 'multi'; allowCustom?: boolean; minPick?: number; showIf?: Record<string, string[]>; options: SeedOption[] };

/** Inserts each dataset only when its key is missing, so admin edits and promoted options survive re-seeding. */
export async function seedDatasets(): Promise<void> {
  for (const [i, d] of (seedData.datasets as SeedDataset[]).entries()) {
    const options = d.options.map((o, n) => ({ ...o, source: 'seed' as const, order: n, active: true }));
    await Dataset.updateOne(
      { key: d.key },
      { $setOnInsert: { ...d, showIf: d.showIf ?? null, allowCustom: d.allowCustom ?? false, minPick: d.minPick ?? 0, order: i, version: 1, active: true, options } },
      { upsert: true },
    );
  }
}

export async function seed(): Promise<void> {
  await seedDatasets();
  await FeeConfigModel.updateOne({ key: 'default' }, { $setOnInsert: { key: 'default', ...DEFAULT_FEE_CONFIG } }, { upsert: true });

  for (const [i, b] of BANDS.entries()) {
    const full = COUNTRIES.map((c) => ({ ...c, amountMinor: minor(b.major[c.country]!) }));
    const derive = (pct: number) => full.map((p) => ({ ...p, amountMinor: applyDiscount(p.amountMinor, pct) }));
    await PackageConfig.updateOne(
      { key: `dietitian_${b.id}` },
      {
        $setOnInsert: {
          key: `dietitian_${b.id}`, kind: 'dietitian_plan', label: b.label, bandId: b.id, active: true, sortOrder: i,
          variants: [
            { variant: 'full', productId: `saathi_${b.id}_full`, prices: full },
            { variant: 'premium', productId: `saathi_${b.id}_premium`, prices: derive(DEFAULT_FEE_CONFIG.premiumDiscountPercent) },
            { variant: 'followUp', productId: `saathi_${b.id}_followup`, prices: derive(DEFAULT_FEE_CONFIG.followUpDiscountPercent) },
          ],
        },
      },
      { upsert: true },
    );
  }

  const sub = (table: Record<string, { monthly: number; yearly: number }>, k: 'monthly' | 'yearly') =>
    COUNTRIES.map((c) => ({ ...c, amountMinor: minor(table[c.country]![k]) }));

  const PAID_PACKAGES = [
    { key: 'premium_default', tier: 'premium', label: 'Saathi Premium', sortOrder: 0, table: PREMIUM_SUB, features: PREMIUM_PKG_FEATURES, perks: PREMIUM_PERKS, sku: 'saathi_premium' },
    { key: 'premium_plus', tier: 'plus', label: 'Saathi Premium Plus', sortOrder: 1, table: PLUS_SUB, features: PLUS_PKG_FEATURES, perks: PLUS_PERKS, sku: 'saathi_plus' },
  ] as const;

  for (const p of PAID_PACKAGES) {
    await PackageConfig.updateOne(
      { key: p.key },
      { $setOnInsert: { key: p.key, kind: 'premium', label: p.label, trialDays: TRIAL_DAYS, active: true, sortOrder: p.sortOrder, tier: p.tier, features: p.features, perks: p.perks, variants: [
        { variant: 'monthly', productId: `${p.sku}_monthly`, prices: sub(p.table, 'monthly') },
        { variant: 'yearly', productId: `${p.sku}_yearly`, prices: sub(p.table, 'yearly') },
      ] } },
      { upsert: true },
    );
    // Tier, features and perks are new fields: fill them in where an earlier seed left them empty,
    // without touching prices or anything an admin may have edited.
    await PackageConfig.updateOne(
      { key: p.key, $or: [{ tier: null }, { tier: { $exists: false } }, { features: { $size: 0 } }] },
      { $set: { tier: p.tier, features: p.features, perks: p.perks } },
    );
  }

  // The trial was first seeded at 30 days and is now 7. Only the old seeded value is corrected, so a
  // length an admin has since chosen stays as they set it.
  await PackageConfig.updateOne({ key: 'premium_default', trialDays: 30 }, { $set: { trialDays: TRIAL_DAYS } });

  for (const rp of REGION_PACKS) await RegionPack.updateOne({ country: rp.country }, { $setOnInsert: rp }, { upsert: true });

  // One-time backfill for accounts that predate email verification. They signed up when no code was
  // asked for, so locking them out now would be punishing them for our change. Runs in the release
  // phase before the new code serves traffic; `$exists: false` makes it a no-op on every later deploy.
  const backfilled = await User.updateMany(
    { emailVerifiedAt: { $exists: false } },
    [{ $set: { emailVerifiedAt: { $ifNull: ['$createdAt', new Date()] } } }],
  );
  if (backfilled.modifiedCount) log.info('backfilled emailVerifiedAt', { users: backfilled.modifiedCount });
}

if (require.main === module) {
  (async () => {
    await mongoose.connect(getEnv().MONGODB_URI);
    await seed();
    log.info('seed complete');
    await mongoose.disconnect();
  })().catch((e) => {
    log.error('seed failed', { message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
