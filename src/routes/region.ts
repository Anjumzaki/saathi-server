import { Router } from 'express';
import { z } from 'zod';
import { RegionPack } from '../models/RegionPack';
import { notFound } from '../utils/errors';
import { asyncHandler, parse } from '../utils/http';

export function regionRoutes(): Router {
  const r = Router();
  r.get('/:country', asyncHandler(async (req, res) => {
    const country = parse(z.string().length(2).toUpperCase(), req.params['country']);
    const pack = await RegionPack.findOne({ country }).select('-_id -__v').lean();
    if (!pack) throw notFound(`No region pack for ${country}`);
    res.json({ region: pack });
  }));
  return r;
}
