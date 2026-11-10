/** Idempotent seed: inserts defaults only where missing, so admin edits are never overwritten. */
import mongoose from 'mongoose';
import { getEnv } from './config/env';
import seedData from './data/datasets-seed.json';
import { Dataset } from './models/Dataset';
import { FeeConfigModel, PackageConfig } from './models/PackageConfig';
import { RegionPack } from './models/RegionPack';
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
const minor = (x: number) => Math.round(x * 100);

export const REGION_PACKS = [
  { country: 'PK', name: 'Pakistan', quietHourProvider: true, powerCutMode: true, produce: ['okra', 'spinach', 'cauliflower', 'mango', 'guava', 'dates'], proteinKeywords: ['anda', 'daal', 'dal', 'chana', 'lobia', 'dahi', 'chicken', 'gosht', 'machli', 'paneer'] },
  { country: 'IN', name: 'India', quietHourProvider: true, powerCutMode: true, produce: ['palak', 'bhindi', 'lauki', 'banana', 'papaya', 'amla'], proteinKeywords: ['anda', 'dal', 'rajma', 'chana', 'paneer', 'dahi', 'curd', 'sprouts', 'soya', 'chicken'] },
  { country: 'AE', name: 'United Arab Emirates', quietHourProvider: false, powerCutMode: false, produce: ['dates', 'tomato', 'cucumber', 'zucchini', 'orange'], proteinKeywords: ['labneh', 'hummus', 'foul', 'ful', 'chicken', 'lamb', 'fish', 'egg', 'halloumi'] },
  { country: 'GB', name: 'United Kingdom', quietHourProvider: false, powerCutMode: false, produce: ['apple', 'pear', 'kale', 'leek', 'parsnip', 'berries'], proteinKeywords: ['egg', 'beans', 'cottage cheese', 'skyr', 'greek yogurt', 'chicken', 'fish', 'tofu', 'quorn'] },
  { country: 'US', name: 'United States', quietHourProvider: false, powerCutMode: false, produce: ['apple', 'broccoli', 'sweet potato', 'blueberries', 'avocado'], proteinKeywords: ['egg', 'turkey', 'chicken', 'beans', 'greek yogurt', 'cottage cheese', 'tofu', 'tempeh', 'protein shake'] },
] as const;

type SeedOption = { id: string; label: string; labelUr?: string; icon?: string; tags?: string[]; regions?: string[] };
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

  const sub = (k: 'monthly' | 'yearly') => COUNTRIES.map((c) => ({ ...c, amountMinor: minor(PREMIUM_SUB[c.country]![k]) }));
  await PackageConfig.updateOne(
    { key: 'premium_default' },
    { $setOnInsert: { key: 'premium_default', kind: 'premium', label: 'Saathi Premium', trialDays: 30, active: true, sortOrder: 0, variants: [
      { variant: 'monthly', productId: 'saathi_premium_monthly', prices: sub('monthly') },
      { variant: 'yearly', productId: 'saathi_premium_yearly', prices: sub('yearly') },
    ] } },
    { upsert: true },
  );

  for (const rp of REGION_PACKS) await RegionPack.updateOne({ country: rp.country }, { $setOnInsert: rp }, { upsert: true });
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
