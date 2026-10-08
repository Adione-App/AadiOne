/**
 * Process entry point: boot, then shut down cleanly.
 *
 * Graceful shutdown matters more than it looks. A `SIGTERM` during a deploy
 * must not kill a request that is halfway through creating an order and has
 * inventory rows locked — so we stop accepting new connections, let in-flight
 * requests finish, then close the database and cache.
 */

import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './common/logger';
import { cache } from './infra/cache';
import { disconnectDatabase, checkDatabaseConnection } from './infra/db/prisma';
import { checkPrismaClientMatchesSchema } from './infra/db/prisma-client-check';
import { checkDatabaseIsV2 } from './infra/db/database-identity';
import { initRealtime, shutdownRealtime } from './realtime/socket';
import { startJobs, stopJobs } from './jobs';

const SHUTDOWN_TIMEOUT_MS = 15_000;

let server: Server | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  // A Prisma Client generated from another schema boots fine and then fails
  // every query on a changed model with a 500 — refuse to start instead.
  const client = checkPrismaClientMatchesSchema();
  if (!client.ok) {
    logger.error(client.message);
    process.exit(1);
  }
  if ('skipped' in client) logger.warn({ reason: client.skipped }, 'Prisma Client / schema check skipped');

  const app = createApp();

  // Verify the database is reachable before announcing readiness. Booting
  // "successfully" against an unreachable database only moves the failure to
  // the first customer request.
  const databaseUp = await checkDatabaseConnection();
  if (!databaseUp) {
    logger.error(
      'database unreachable at startup — check DATABASE_URL and that PostgreSQL is running',
    );
    process.exit(1);
  }

  // Before anything can write: never run against a V1 or unmigrated database.
  const database = await checkDatabaseIsV2();
  if (!database.ok) {
    logger.error({ reason: database.reason }, database.message);
    process.exit(1);
  }

  server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        environment: env.NODE_ENV,
        cache: env.REDIS ? 'redis' : 'node-cache',
        otpProvider: env.OTP_PROVIDER,
        paymentProvider: env.PAYMENT_PROVIDER,
        storageProvider: env.STORAGE_PROVIDER,
      },
      `AdiOne API listening on http://localhost:${env.PORT}`,
    );
  });

  // Realtime shares the HTTP server: one port, one TLS termination point,
  // rather than a second listener to expose and secure.
  initRealtime(server);
  startJobs();

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error({ port: env.PORT }, 'port already in use');
      process.exit(1);
    }
    throw error;
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  // Hard deadline: if something hangs, exit non-zero rather than linger
  // forever holding database connections.
  const timer = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  try {
    // Stop taking new work before closing connections, so an in-flight order
    // transaction is not cut off mid-commit.
    stopJobs();
    shutdownRealtime();

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info('http server closed');
    }

    await Promise.allSettled([disconnectDatabase(), cache.disconnect()]);
    logger.info('connections closed — bye');
    clearTimeout(timer);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// An unhandled rejection or uncaught exception leaves the process in an
// unknown state. Log it, then exit and let the supervisor restart cleanly.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});

void start();

