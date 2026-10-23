/**
 * POST /api/v1/client-errors — crash reports from the mobile app.
 *
 * Until a crash-reporting service (e.g. Sentry) is set up, this is how a
 * JavaScript crash in the app reaches the team at all: the app's root error
 * boundary and global error handler send a short, sanitised report, written
 * here to the server log (level `error`, module `client-errors`) with the app
 * version, platform, screen and the request id that ties it to API calls.
 *
 *   - Public (a crash can happen before or after sign-in), strictly
 *     validated, size-limited and rate-limited per IP; nothing is stored in
 *     the database.
 *   - Redacted again on the server whatever the client sent: emails, phone
 *     numbers, bearer tokens, JWTs and long token-like strings never reach
 *     the log.
 *   - Answers 204 — the app never waits on it or retries it.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, noContent } from '../../common/response';
import { moduleLogger } from '../../common/logger';
import { validate } from '../../middleware/validate';
import { clientErrorPerIp } from '../../middleware/rateLimit';

const log = moduleLogger('client-errors');

/** Strips anything personal or secret from free text before it is logged. */
export function redactClientText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?<![A-Za-z0-9])(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![0-9])/g, '[mobile]')
    .replace(/\b\d{11,}\b/g, '[number]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]');
}

const text = (max: number) => z.string().trim().max(max * 4).transform((value) => redactClientText(value).slice(0, max));

const clientErrorSchema = z
  .object({
    source: z.enum(['error-boundary', 'global-handler', 'unhandled-rejection']),
    fatal: z.boolean(),
    name: text(100).optional(),
    message: text(500),
    stack: text(4000).optional(),
    componentStack: text(2000).optional(),
    screen: z.string().trim().max(80).regex(/^[A-Za-z0-9_ -]*$/).optional(),
    appVersion: z.string().trim().max(20).regex(/^[0-9A-Za-z.+-]*$/).optional(),
    build: z.string().trim().max(20).regex(/^[0-9A-Za-z.+-]*$/).optional(),
    platform: z.enum(['android', 'ios', 'web']).optional(),
    /** The X-Request-Id of the app's last API call, to find it in the server log. */
    lastRequestId: z.string().trim().max(64).regex(/^[A-Za-z0-9-]*$/).optional(),
  })
  .strict();

export const clientErrorRouter: Router = Router();

clientErrorRouter.post(
  '/',
  clientErrorPerIp,
  validate({ body: clientErrorSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const report = req.body as z.infer<typeof clientErrorSchema>;
    log.error({ clientError: report, requestId: res.getHeader('x-request-id') }, `app crash report (${report.source}${report.fatal ? ', fatal' : ''})`);
    noContent(res);
  }),
);
