/**
 * Idempotency (Task 8.2, PRD §48).
 *
 * On a 3G connection a request routinely succeeds server-side while the
 * response never arrives. The customer taps again. Without this, they get two
 * orders and two charges — the single most damaging bug this system could
 * ship.
 *
 * The DATABASE is the arbiter, via `UNIQUE (user_id, key)`. An in-memory
 * mutex would not survive a restart and would not work across processes.
 *
 * Three outcomes for a repeated key:
 *   COMPLETED   → replay the stored response verbatim, no side effects
 *   IN_PROGRESS → 409, the first request is still running
 *   different body for the same key → 409, that is a client bug, not a retry
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode, HEADER_IDEMPOTENCY_KEY, IdempotencyStatus } from '../shared';
import { AppError } from '../common/errors';
import { sha256 } from '../common/crypto';
import { prisma } from '../infra/db/prisma';
import { moduleLogger } from '../common/logger';

const log = moduleLogger('idempotency');

/** Long enough to cover any realistic retry, short enough to keep the table small. */
const RETENTION_HOURS = 24;

export function idempotency(endpoint: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.header(HEADER_IDEMPOTENCY_KEY);
      const user = req.user;

      if (!user) {
        return next(
          new AppError(ErrorCode.UNAUTHENTICATED, {
            internalMessage: 'idempotency middleware used before authenticate',
          }),
        );
      }

      if (!key || key.length < 8 || key.length > 120) {
        return next(
          new AppError(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, {
            internalMessage: `missing or malformed ${HEADER_IDEMPOTENCY_KEY} header`,
          }),
        );
      }

      const requestHash = sha256(`${endpoint}:${JSON.stringify(req.body ?? {})}`);
      const existing = await prisma.idempotencyKey.findUnique({
        where: { userId_key: { userId: user.id, key } },
      });

      if (existing) {
        // Same key, different payload: the client reused a key for a genuinely
        // different request. Replaying would be wrong and creating a second
        // order would defeat the purpose, so it is refused.
        if (existing.requestHash !== requestHash) {
          return next(
            new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED, {
              internalMessage: `key ${key} reused with a different body`,
            }),
          );
        }

        if (existing.status === IdempotencyStatus.COMPLETED) {
          log.info({ key, userId: user.id }, 'replaying stored idempotent response');
          res
            .status(existing.responseStatus ?? 200)
            .json(existing.responseBody as Record<string, unknown>);
          return;
        }

        return next(
          new AppError(ErrorCode.ORDER_IN_PROGRESS, {
            internalMessage: `key ${key} is still in progress`,
          }),
        );
      }

      // Claim the key. The unique constraint means a genuinely simultaneous
      // double-tap loses the race here rather than creating two orders.
      try {
        await prisma.idempotencyKey.create({
          data: {
            userId: user.id,
            key,
            endpoint,
            requestHash,
            status: IdempotencyStatus.IN_PROGRESS,
            expiresAt: new Date(Date.now() + RETENTION_HOURS * 3600_000),
          },
        });
      } catch {
        return next(
          new AppError(ErrorCode.ORDER_IN_PROGRESS, {
            internalMessage: `concurrent claim of key ${key}`,
          }),
        );
      }

      req.idempotencyKey = key;

      // Capture the response so a later retry can replay it.
      //
      // The key's outcome is recorded BEFORE the response leaves. Sent first
      // (as it used to be), a client that got its 201 — or timed out just as
      // it arrived — and retried at once could still find the key IN_PROGRESS
      // and be told "still in progress" (409) for an order that already
      // existed. Recording first means any retry after a response replays it.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        const status = res.statusCode;
        // Only successful responses are stored. A failed attempt must be
        // retryable — otherwise a transient error would permanently lock the
        // customer out of placing that order.
        const settled =
          status >= 200 && status < 300
            ? prisma.idempotencyKey
                .update({
                  where: { userId_key: { userId: user.id, key } },
                  data: {
                    status: IdempotencyStatus.COMPLETED,
                    responseStatus: status,
                    responseBody: body as never,
                  },
                })
                .catch((error) => log.error({ err: error, key }, 'failed to store response'))
            : prisma.idempotencyKey
                .delete({ where: { userId_key: { userId: user.id, key } } })
                .catch(() => undefined);
        // Sent either way — a failed bookkeeping write is logged, never
        // turned into a failed request for something that already happened.
        void settled.finally(() => originalJson(body));
        return res;
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Releases a claimed key when the handler throws, so the client can retry. */
export async function releaseIdempotencyKey(userId: string, key: string): Promise<void> {
  await prisma.idempotencyKey
    .deleteMany({ where: { userId, key, status: IdempotencyStatus.IN_PROGRESS } })
    .catch(() => undefined);
}
