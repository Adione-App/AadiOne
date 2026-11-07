/**
 * Express application assembly.
 *
 * Middleware order is deliberate and load-bearing:
 *
 *   1. trust proxy      — so req.ip is the real client, not the load balancer
 *   2. requestLogger    — assign the request id BEFORE anything can fail
 *   3. helmet           — security headers on every response, including errors
 *   4. cors             — reject disallowed origins before doing any work
 *   5. webhook raw body — MUST precede the JSON parser (signatures are computed
 *                          over the exact bytes; a re-serialised body will not
 *                          verify)
 *   6. json / urlencoded / cookies
 *   7. compression
 *   8. routes
 *   9. 404 handler
 *  10. error handler    — last, always
 */

import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { corsOrigins, corsOriginsIgnored, env, isProduction } from './config/env';
import { isAllowedOrigin } from './config/cors';
import { AppError } from './common/errors';
import { moduleLogger } from './common/logger';
import { ErrorCode } from './shared';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './modules/health/health.routes';
import { apiRouter } from './routes';

/**
 * Public, read-only routes any website may fetch (see the CORS set-up below):
 * the legal pages and business details — NOT /legal/consent, which is a
 * signed-in customer's own record and keeps the CORS_ORIGINS allow-list.
 */
export const PUBLIC_READ_PATH = /^\/api\/v1\/legal(?:\/(?!consent(?:\/|$))|$)/;

export function createApp(): Express {
  const app = express();

  // Behind Nginx/Caddy in every deployed environment.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // "/orders" and "/orders/" are the same endpoint.
  app.set('strict routing', false);

  app.use(requestLogger);

  app.use(
    helmet({
      // The API serves JSON and (in dev) uploaded images; it renders no HTML,
      // so a CSP here would only constrain the static image route.
      contentSecurityPolicy: isProduction
        ? { directives: { defaultSrc: ["'none'"], imgSrc: ["'self'", 'data:'] } }
        : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  const log = moduleLogger('cors');
  if (corsOriginsIgnored.length > 0) {
    log.warn({ ignored: corsOriginsIgnored }, 'CORS_ORIGINS entries ignored — each must be an exact http(s) origin such as https://adione.in');
  }

  // A disallowed origin used to reach `cors` as an Error, which the error
  // handler answered as a 500 "Something went wrong" — preflights included.
  // Requests carrying no Origin (the native app, curl, server-to-server) are
  // not browser cross-origin requests and pass through untouched.
  const allowListCors = cors({
    origin(origin, callback) {
      callback(null, !origin || isAllowedOrigin(origin, corsOrigins));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Client-Version',
      'X-Client-Platform',
      // Sent by the web and mobile clients to suppress ngrok's HTML
      // interstitial. It is a custom header, so the browser lists it in
      // Access-Control-Request-Headers and the preflight fails with
      // HeaderDisallowedByPreflightResponse unless it is allowed here.
      'ngrok-skip-browser-warning',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 86_400,
  });
  // The public legal pages and business details (GET /api/v1/legal/*) are read
  // by the website (adione.in) as well as the app: any origin may read them,
  // WITHOUT credentials — they carry nothing private. An allow-listed origin
  // (the admin panel) keeps its usual credentialed CORS; every other route
  // keeps the CORS_ORIGINS allow-list.
  const publicReadCors = cors({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS'], credentials: false, maxAge: 86_400 });
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = isAllowedOrigin(origin, corsOrigins);
    const publicRead =
      PUBLIC_READ_PATH.test(req.path) && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') && !allowed;
    if (publicRead) return publicReadCors(req, res, next);
    if (origin && !allowed) {
      // A website that is not on CORS_ORIGINS: a clear 403 (no CORS headers,
      // no internal detail), before the request does any work.
      log.warn({ origin, method: req.method, path: req.path }, 'request from a website not on CORS_ORIGINS');
      return next(new AppError(ErrorCode.FORBIDDEN, { message: 'Requests from this website are not allowed.' }));
    }
    return allowListCors(req, res, next);
  });

  // Payment webhooks are verified against an HMAC of the raw bytes. Parsing to
  // JSON first and re-stringifying changes key order and whitespace, and the
  // signature then never matches. This must stay above express.json().
  app.use('/api/v1/payments/webhook', express.raw({ type: '*/*', limit: '256kb' }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(compression());

  // Local development image storage. In production STORAGE_PROVIDER=s3 and
  // images are served from object storage / CDN instead.
  if (env.STORAGE_PROVIDER === 'local') {
    app.use('/static', express.static('storage', { maxAge: '7d', fallthrough: true }));
  }

  app.use('/health', healthRouter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
