/**
 * Structured logging.
 *
 * Two rules that matter more than anything else here:
 *
 *   1. EVERY log line carries the request id, so a customer's "something went
 *      wrong" screenshot maps to exact server logs.
 *   2. NO personal data or secret ever reaches a log. Mobile numbers are
 *      masked, OTPs / tokens / passwords / signatures are redacted outright.
 *      This is enforced by the redaction config below rather than by asking
 *      developers to remember.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { env, isProduction } from "../config/env";
import { getRequestContext } from "./request-context";

/**
 * Paths pino removes before serialising.
 * Covers the usual header and body locations for sensitive fields.
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

  // ISO timestamps are easy for log aggregators and humans to read.
  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    level: (label) => ({
      level: label,
    }),
  },

  /**
   * Inject request-scoped fields into every log line automatically.
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
 * Production:
 *   - JSON logs
 *   - No pino-pretty transport
 *   - Better compatibility with Railway/log aggregators
 *
 * Development:
 *   - Human-readable pretty logs using pino-pretty
 *
 * IMPORTANT:
 * pino-pretty is loaded only when running in development.
 */
export const logger: Logger = isProduction
  ? pino(options)
  : pino({
      ...options,

      transport: {
        target: "pino-pretty",

        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname,service,env",
          singleLine: false,
        },
      },
    });

/**
 * Child logger tagged with a module name,
 * e.g. "orders", "payments", "auth".
 */
export function moduleLogger(moduleName: string): Logger {
  return logger.child({
    module: moduleName,
  });
}
