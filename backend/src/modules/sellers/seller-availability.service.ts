/**
 * Seller availability management — the seller's own Store Open / Store
 * Closed switch (`Seller.isAcceptingOrders`), weekly hours (SellerHours) and
 * date closures (SellerClosure). The RULE combining them lives in
 * seller.service.ts's `evaluateSellerAvailability`; this module only reads
 * and writes the inputs.
 *
 * `Seller.isActive` (admin deactivation) is deliberately NOT writable here.
 * Seller-panel callers always pass their own `req.sellerId`; another seller's
 * closure is reported exactly like a missing one (NOT_FOUND).
 */

import { ErrorCode, type SellerHoursDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { getZonedParts } from '../../shared/datetime';
import * as sellerRepository from './seller.repository';
import * as sellerService from './seller.service';
import { saveWeeklyHours } from './admin-seller.service';

async function loadSeller(sellerId: string) {
  const seller = await sellerRepository.findSellerById(sellerId);
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

/** Today's date in the seller's own timezone, as a UTC-midnight Date (the
 * same key `hasClosureOn` uses for SellerClosure.closedOn). */
function localToday(timezone: string): Date {
  const parts = getZonedParts(new Date(), timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

export async function getAvailability(sellerId: string) {
  const seller = await loadSeller(sellerId);
  const [availability, closures] = await Promise.all([
    sellerService.evaluateSellerAvailability(seller),
    prisma.sellerClosure.findMany({
      where: { sellerId, closedOn: { gte: localToday(seller.timezone) } },
      orderBy: { closedOn: 'asc' },
    }),
  ]);
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    // The seller panel needs it to pick the category source: a RESTAURANT
    // lists under its own menu sections, every other type the shared tree.
    sellerType: seller.sellerType,
    timezone: seller.timezone,
    isActive: availability.isActive,
    isAcceptingOrders: availability.isAcceptingOrders,
    isOpenNow: availability.isOpen,
    acceptingOrdersNow: availability.acceptingOrders,
    closedReason: availability.closedReason,
    nextOpenText: availability.nextOpenText,
    // Today's window as the rule evaluated it ("HH:MM"); null when no
    // window applies (no hours saved, closed today, switched off, paused).
    todayOpensAt: availability.todayOpensAt,
    todayClosesAt: availability.todayClosesAt,
    hoursConfigured: availability.hoursConfigured,
    hours: seller.hours.map(
      (h): SellerHoursDto => ({ dayOfWeek: h.dayOfWeek, opensAt: h.opensAt, closesAt: h.closesAt, isClosed: h.isClosed }),
    ),
    upcomingClosures: closures.map((c) => ({ id: c.id, date: c.closedOn.toISOString().slice(0, 10), reason: c.reason })),
  };
}

/** The seller's own switch. Never reset automatically — see the schema. */
export async function setAcceptingOrders(sellerId: string, isAcceptingOrders: boolean, actorUserId: string) {
  const seller = await loadSeller(sellerId);
  if (seller.isAcceptingOrders !== isAcceptingOrders) {
    await prisma.$transaction([
      prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders } }),
      prisma.auditLog.create({
        data: {
          actorUserId,
          action: isAcceptingOrders ? 'seller.store_open' : 'seller.store_close',
          entityType: 'Seller',
          entityId: sellerId,
          before: { isAcceptingOrders: seller.isAcceptingOrders },
          after: { isAcceptingOrders },
        },
      }),
    ]);
  }
  return getAvailability(sellerId);
}

export async function updateHours(sellerId: string, hours: SellerHoursDto[], actorUserId: string) {
  await saveWeeklyHours(sellerId, { hours }, actorUserId);
  return getAvailability(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Date closures (existing SellerClosure model: one full local day each)    */
/* -------------------------------------------------------------------------- */

export async function addClosure(sellerId: string, input: { date: string; reason?: string | null }, actorUserId: string) {
  const seller = await loadSeller(sellerId);
  const closedOn = new Date(`${input.date}T00:00:00.000Z`);
  if (Number.isNaN(closedOn.getTime()) || closedOn.toISOString().slice(0, 10) !== input.date) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Use a real calendar date (YYYY-MM-DD).' });
  }
  if (closedOn < localToday(seller.timezone)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'A closure cannot be added for a past date.' });
  }
  const existing = await prisma.sellerClosure.findUnique({ where: { sellerId_closedOn: { sellerId, closedOn } } });
  if (existing) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message: 'That date is already marked closed.' });
  }
  const closure = await prisma.sellerClosure.create({ data: { sellerId, closedOn, reason: input.reason ?? null } });
  await prisma.auditLog.create({
    data: { actorUserId, action: 'seller.add_closure', entityType: 'SellerClosure', entityId: closure.id, after: { sellerId, date: input.date } },
  });
  return getAvailability(sellerId);
}

export async function removeClosure(sellerId: string, closureId: string, actorUserId: string) {
  const closure = await prisma.sellerClosure.findUnique({ where: { id: closureId } });
  if (!closure || closure.sellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Closure not found.' });
  }
  await prisma.sellerClosure.delete({ where: { id: closureId } });
  await prisma.auditLog.create({
    data: { actorUserId, action: 'seller.remove_closure', entityType: 'SellerClosure', entityId: closureId, before: { sellerId, date: closure.closedOn.toISOString().slice(0, 10) } },
  });
  return getAvailability(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Admin — effective availability across sellers                             */
/* -------------------------------------------------------------------------- */

export async function listAvailability() {
  const sellers = await prisma.seller.findMany({
    where: { deletedAt: null },
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  return Promise.all(
    sellers.map(async (seller) => {
      const a = await sellerService.evaluateSellerAvailability(seller);
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        sellerType: seller.sellerType,
        onboardingStatus: seller.onboardingStatus,
        isActive: a.isActive,
        isAcceptingOrders: a.isAcceptingOrders,
        isOpenNow: a.isOpen,
        acceptingOrdersNow: a.acceptingOrders,
        closedReason: a.closedReason,
        hoursConfigured: a.hoursConfigured,
        nextOpenText: a.nextOpenText,
      };
    }),
  );
}
