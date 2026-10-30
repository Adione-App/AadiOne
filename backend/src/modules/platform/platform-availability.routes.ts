/**
 * App-wide availability routes.
 *
 *   GET  /availability                                   public (guests too): the computed status
 *
 *   GET  /admin/platform-availability                    CONFIG_READ: settings + computed status
 *   PUT  /admin/platform-availability/hours              CONFIG_WRITE: weekly hours ([] = none)
 *   PUT  /admin/platform-availability/mode               CONFIG_WRITE: FIXED_TIMING / ALWAYS_OPEN
 *   PUT  /admin/platform-availability/location           CONFIG_WRITE: main location (null = clear)
 *   POST /admin/platform-availability/pauses             CONFIG_WRITE: pause now / scheduled / emergency
 *   PATCH /admin/platform-availability/pauses/:id        CONFIG_WRITE: message, reschedule, resume time
 *   POST /admin/platform-availability/pauses/:id/cancel  CONFIG_WRITE: cancel before it starts
 *   POST /admin/platform-availability/pauses/:id/end     CONFIG_WRITE: resume now / end emergency
 *   POST /admin/platform-availability/holidays           CONFIG_WRITE
 *   PUT  /admin/platform-availability/holidays/:id       CONFIG_WRITE
 *   DELETE /admin/platform-availability/holidays/:id     CONFIG_WRITE
 *
 * The master switch, its message, the timezone and the default radius stay
 * on PATCH /admin/config (their existing keys). Every write returns the full
 * admin view, recomputed.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, created, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import * as service from './platform-availability.service';

/* public ------------------------------------------------------------------------ */

export const platformAvailabilityRouter: Router = Router();

platformAvailabilityRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    // Never cached by a client or proxy: it changes the moment an admin acts.
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await service.getPlatformAvailability());
  }),
);

/* admin ------------------------------------------------------------------------- */

export const adminPlatformAvailabilityRouter: Router = Router();

const BASE = '/platform-availability';
const id = z.object({ id: z.string().uuid() });
const message = z.string().trim().max(200).nullable().optional();
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm.');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm.');

adminPlatformAvailabilityRouter.get(
  BASE,
  requirePermission(Permission.CONFIG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.getAdminView());
  }),
);

adminPlatformAvailabilityRouter.put(
  `${BASE}/hours`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    body: z
      .object({
        // 7 days or none — the full rules are checked by the configuration service.
        hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), isClosed: z.boolean(), opensAt: time, closesAt: time }).strict()).max(7),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.setOperatingHours(req.body.hours, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.put(
  `${BASE}/mode`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ body: z.object({ mode: z.enum(['FIXED_TIMING', 'ALWAYS_OPEN']) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.setOperatingMode(req.body.mode, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.put(
  `${BASE}/location`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    body: z
      .object({
        location: z
          .object({
            name: z.string().trim().max(120).nullable().optional(),
            addressLine: z.string().trim().min(2).max(300),
            landmark: z.string().trim().max(160).nullable().optional(),
            // Range, (0, 0), swapped and India are checked by the configuration service.
            latitude: z.number().finite(),
            longitude: z.number().finite(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const location = req.body.location as { name?: string | null; addressLine: string; landmark?: string | null; latitude: number; longitude: number } | null;
    ok(res, await service.setLocation(location ? { ...location, landmark: location.landmark ?? null } : null, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.post(
  `${BASE}/pauses`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    body: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('IMMEDIATE'),
          message,
          resumeAtLocal: localDateTime.nullable().optional(),
          // "Pause for 30 minutes": from the server's clock, at most 31 days.
          durationMinutes: z.number().int().min(1).max(31 * 24 * 60).nullable().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('EMERGENCY'), message }).strict(),
      z.object({ kind: z.literal('SCHEDULED'), message, startsAtLocal: localDateTime, endsAtLocal: localDateTime }).strict(),
    ]),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createPause(req.body, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.patch(
  `${BASE}/pauses/:id`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    params: id,
    body: z.object({ message, startsAtLocal: localDateTime.optional(), endsAtLocal: localDateTime.nullable().optional() }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.updatePause(req.params['id'] as string, req.body, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.post(
  `${BASE}/pauses/:id/cancel`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ params: id }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.cancelPause(req.params['id'] as string, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.post(
  `${BASE}/pauses/:id/end`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ params: id }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.endPause(req.params['id'] as string, requireUser(req).id));
  }),
);

const holidayBody = z
  .object({ name: z.string().trim().min(2).max(80), message, startDate: localDate, endDate: localDate })
  .strict();

adminPlatformAvailabilityRouter.post(
  `${BASE}/holidays`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ body: holidayBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createHoliday(req.body, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.put(
  `${BASE}/holidays/:id`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ params: id, body: holidayBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.updateHoliday(req.params['id'] as string, req.body, requireUser(req).id));
  }),
);

adminPlatformAvailabilityRouter.delete(
  `${BASE}/holidays/:id`,
  requirePermission(Permission.CONFIG_WRITE),
  validate({ params: id }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.deleteHoliday(req.params['id'] as string, requireUser(req).id));
  }),
);
