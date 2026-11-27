import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DEFAULT_COUNTRY, producePacks, selectProduce } from '../data/produce';
import type { ProduceKind, ProducePack } from '../data/produce';
import { REGION_SUMMARY_FIELDS, RegionPack } from '../models/RegionPack';
import { notFound } from '../utils/errors';
import { asyncHandler, parse } from '../utils/http';

const iso = (d: Date | null | undefined): string => (d ?? new Date(0)).toISOString().slice(0, 10);

/**
 * Seasonal lists held in the database, where they can be corrected without a deploy. Empty when the database is
 * not reachable or nothing has been seeded yet, and the lists written in `data/produce` are served instead.
 */
async function storedPacks(countries: string[]): Promise<ProducePack[]> {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const rows = await RegionPack.find({ country: { $in: countries } }).lean();
    return rows
      .filter((r) => r.produceItems.length > 0 || r.produceRegions.length > 0)
      .map((r) => ({
        country: r.country,
        name: r.name ?? r.country,
        version: r.produceVersion ?? 1,
        updatedAt: iso(r.produceUpdatedAt),
        items: r.produceItems.map((i) => ({ name: i.name, kind: i.kind as ProduceKind, use: i.use ?? '', months: i.months ?? [] })),
        regions: r.produceRegions.map((g) => ({
          region: g.region,
          cities: g.cities ?? [],
          items: g.items.map((i) => ({ name: i.name, kind: i.kind as ProduceKind, use: i.use ?? '', months: i.months ?? [] })),
        })),
      }));
  } catch {
    return [];
  }
}

/** Corrected lists first, then the ones written in the code for every country they do not cover. */
async function packsFor(country: string): Promise<ProducePack[]> {
  const written = producePacks();
  const stored = await storedPacks([country, DEFAULT_COUNTRY]);
  return stored.length ? [...stored, ...written.filter((w) => !stored.some((s) => s.country === w.country))] : written;
}

export function regionRoutes(): Router {
  const r = Router();

  // What is in season where she is, for one month. `region` may be a province or just the city she picked:
  // the answer falls back from her region to her country to a neutral list, and says which it used.
  r.get('/:country/produce', asyncHandler(async (req, res) => {
    const country = parse(z.string().length(2).toUpperCase(), req.params['country']);
    const q = parse(
      z.object({
        region: z.string().trim().max(80).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
        max: z.coerce.number().int().min(2).max(12).optional(),
      }),
      req.query,
    );
    const produce = selectProduce(
      await packsFor(country),
      { country, place: q.region, month: q.month ?? new Date().getUTCMonth() + 1 },
      q.max ?? 8,
    );
    if (!produce) throw notFound(`No seasonal produce for ${country}`);
    res.json({ produce });
  }));

  r.get('/:country', asyncHandler(async (req, res) => {
    const country = parse(z.string().length(2).toUpperCase(), req.params['country']);
    const pack = await RegionPack.findOne({ country }).select(REGION_SUMMARY_FIELDS).lean();
    if (!pack) throw notFound(`No region pack for ${country}`);
    res.json({ region: pack });
  }));
  return r;
}
