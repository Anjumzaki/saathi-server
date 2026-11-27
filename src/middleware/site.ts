import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';

/** The marketing website: static files in server/public, served by the same app as the API. */
export const SITE_DIR = path.resolve(__dirname, '..', '..', 'public');

/** Everything that is not the website. */
export const isApiPath = (p: string): boolean => p === '/health' || p === '/v1' || p.startsWith('/v1/');

/**
 * The pages carry their own inline scripts and styles and load Poppins from Google Fonts, so they need a wider
 * content policy than the API. Images may be embedded elsewhere (the mascot in emails, og.png in link previews).
 */
const siteHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
const apiHelmet = helmet();

/** Security headers: strict for the API, the site's own policy for pages. */
export const securityHeaders: RequestHandler = (req, res, next) => {
  if (!isApiPath(req.path)) return siteHelmet(req, res, next);
  res.setHeader('X-Robots-Tag', 'noindex'); // API answers are never search results
  apiHelmet(req, res, next);
};

/** Pages are checked again after five minutes so a deploy shows quickly; images and other files are kept for a day. */
function cacheFor(res: express.Response, file: string): void {
  // The admin shell holds no data, but it is not a page to cache at a proxy or offer to a crawler.
  if (file.includes(`${path.sep}admin${path.sep}`)) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    return;
  }
  res.setHeader('Cache-Control', file.endsWith('.html') ? 'public, max-age=300' : 'public, max-age=86400');
}

/** Mount the website. Call after the API routes and before the JSON not-found handler. */
export function mountSite(app: Express, opts: { production: boolean; host?: string | undefined }): void {
  if (!fs.existsSync(path.join(SITE_DIR, 'index.html'))) return; // API-only checkout

  // Heroku answers plain http too; pages should always be https.
  if (opts.production) {
    app.use((req, res, next) => {
      if (isApiPath(req.path) || req.secure || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
      res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    });
  }

  // One address per page, so search engines never see the same page twice:
  // the app's other host names go to the main one, "/index.html" to "/", and "/pricing" to "/pricing.html".
  app.use((req, res, next) => {
    if (isApiPath(req.path) || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const query = req.originalUrl.slice(req.path.length);
    let target = req.path;
    if (target === '/index.html') target = '/';
    else if (/^\/[a-z0-9-]+$/.test(target) && fs.existsSync(path.join(SITE_DIR, `${target.slice(1)}.html`))) target += '.html';
    const wrongHost = opts.production && !!opts.host && req.hostname !== opts.host;
    if (!wrongHost && target === req.path) return next();
    res.redirect(301, (wrongHost ? `https://${opts.host}` : '') + target + query);
  });

  app.use(express.static(SITE_DIR, { extensions: ['html'], dotfiles: 'ignore', setHeaders: cacheFor }));

  // A page that does not exist gets the site's own 404; anything else falls through to the JSON one.
  const notFoundPage = path.join(SITE_DIR, '404.html');
  app.use((req, res, next) => {
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(req.path) && !!req.accepts('html') && req.headers.accept?.includes('text/html');
    if (!wantsPage || !fs.existsSync(notFoundPage)) return next();
    res.status(404).sendFile(notFoundPage);
  });
}
