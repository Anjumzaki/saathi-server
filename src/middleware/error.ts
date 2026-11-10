import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } });
    return;
  }
  if (err instanceof ApiError) {
    const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (err.status === 429 && retry) res.setHeader('Retry-After', String(retry));
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON' } });
    return;
  }
  log.error('unhandled error', { method: req.method, path: req.path, message: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
};
