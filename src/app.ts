import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { getEnv } from './config/env';
import type { Services } from './interfaces';
import { requireAuth, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter, authLimiter } from './middleware/rateLimit';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { datasetRoutes } from './routes/datasets';
import { dietitianRoutes } from './routes/dietitians';
import { orderRoutes } from './routes/orders';
import { partnerRoutes } from './routes/partner';
import { planRoutes } from './routes/plans';
import { regionRoutes } from './routes/region';
import { packagesRoutes, subscriptionRoutes } from './routes/subscription';
import { syncRoutes } from './routes/sync';
import { log } from './utils/logger';
import mongoose from 'mongoose';

export function createApp(services: Services): Express {
  const env = getEnv();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Heroku / AWS load balancer: correct client IP for rate limiting
  app.use(helmet());
  if (env.CORS_ORIGINS.length) app.use(cors({ origin: env.CORS_ORIGINS }));
  // Plan documents (PDF / photo as base64) are the only large request.
  app.use('/v1/plans/import-ai', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));

  // request log: method, path, status, duration only (never bodies, headers or query strings)
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => log.info('req', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t }));
    next();
  });

  const health = (_req: express.Request, res: express.Response) =>
    res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'up' : 'down', uptimeSeconds: Math.round(process.uptime()) });
  app.get('/health', health);
  app.get('/v1/health', health);

  const v1 = express.Router();
  v1.use(apiLimiter);
  v1.use('/auth', authLimiter, authRoutes(services));
  v1.use('/datasets', datasetRoutes());
  v1.use('/region', regionRoutes());
  v1.use('/packages', packagesRoutes());
  v1.use('/dietitians', (req, res, next) => (req.method === 'GET' && (req.path === '/' || /^\/[a-f0-9]{24}$/.test(req.path)) ? next() : requireAuth(req, res, next)), dietitianRoutes());
  v1.use('/me', requireAuth, accountRoutes());
  v1.use('/sync', requireAuth, syncRoutes());
  v1.use('/subscription', requireAuth, subscriptionRoutes(services));
  v1.use('/plans', requireAuth, planRoutes(services));
  v1.use('/orders', requireAuth, orderRoutes(services));
  v1.use('/partner', requireAuth, partnerRoutes());
  v1.use('/admin', requireAuth, requireRole('admin'), adminRoutes(services));
  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
