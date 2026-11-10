import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import type { ZodTypeAny, z } from 'zod';
import { badRequest, notFound, unauthorized } from './errors';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Parse with zod; ZodError is converted to a 400 by the error handler. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export function objectId(id: string | undefined): string {
  if (!id || !isValidObjectId(id)) throw notFound();
  return id;
}

export function authOf(req: Request): { userId: string; roles: string[] } {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw badRequest(`${name} is required`);
  return v;
}
