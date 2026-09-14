/**
 * Structured logging.
 *
 * Production uses plain JSON logs so Railway and other log aggregators
 * can parse them reliably.
 *
 * Sensitive fields are redacted before being written to logs.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { env } from "../config/env";
import { getRequestContext } from "./request-context";

/**
 * Sensitive fields that must never appear in logs.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',

  "password",
  "*.password",

  "otp",
  "*.otp",

  "token",
  "*.token",

  "accessToken",
  "*.accessToken",

  "refreshToken",
  "*.refreshToken",

  "signature",
  "*.signature",

  "jwtSecret",
  "otpPepper",
  "keySecret",
  "webhookSecret",
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,

  redact: {
    paths: REDACT_PATHS,
    censor: "[redacted]",
  },

  base: {
    service: "adione-api",
    env: env.NODE_ENV,
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    level: (label) => ({
      level: label,
    }),
  },

  /**
   * Add request-scoped information automatically.
   */
  mixin() {
    const context = getRequestContext();

    if (!context) {
      return {};
    }

    return {
      requestId: context.requestId,

      ...(context.userId
        ? {
            userId: context.userId,
          }
        : {}),

      ...(context.route
        ? {
            route: context.route,
          }
        : {}),
    };
  },
};

/**
 * Production-safe logger.
 *
 * IMPORTANT:
 * Do NOT use pino-pretty here.
 *
 * Railway expects standard JSON logs and this avoids the
 * "unable to determine transport target for pino-pretty" error.
 */
export const logger: Logger = pino(options);

/**
 * Child logger tagged with a module name,
 * e.g. "orders", "payments", "auth".
 */
export function moduleLogger(moduleName: string): Logger {
  return logger.child({
    module: moduleName,
  });
}
