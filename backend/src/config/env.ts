/**
 * Environment loader with fail-fast validation.
 *
 * The process REFUSES TO START if a required variable is missing or malformed.
 *
 * Production-only guards are enforced here too: dev stubs (console OTP, mock
 * payments, in-memory cache) are rejected outright in production.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// `backend/.env` is the real configuration file for this project. A `.env` at
// the repository root is read first, if present, so shared local values
// (such as a common DATABASE_URL) can be kept in one place — but the backend's
// own file always wins.

/**
 * Locates a dotenv file.
 */
function findEnvFile(fileName: string): string | null {
  const candidates = [
    path.resolve(__dirname, "../..", fileName), // src/config -> backend/
    path.resolve(__dirname, "../../..", fileName), // dist/config -> backend/
    path.resolve(process.cwd(), fileName), // run from backend/
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const isTestRun = process.env["NODE_ENV"] === "test";

if (isTestRun) {
  // TEST MODE LOADS ONLY `.env.test`.
  const testEnv = findEnvFile(".env.test");

  if (!testEnv) {
    // eslint-disable-next-line no-console
    console.error(
      "\n[AdiOne] NODE_ENV=test but backend/.env.test was not found.\n",
    );
    process.exit(1);
  }

  dotenv.config({ path: testEnv });
} else {
  const rootEnv = path.resolve(process.cwd(), "..", ".env");

  if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
  }

  const backendEnv = findEnvFile(".env");

  if (backendEnv) {
    dotenv.config({
      path: backendEnv,
      override: true,
    });
  }
}

const nonEmpty = (label: string) =>
  z.string().trim().min(1, `${label} must not be empty`);

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "staging", "production"])
      .default("development"),

    PORT: z.coerce.number().int().positive().default(4000),

    API_BASE_URL: z.string().url().default("http://localhost:4000"),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: nonEmpty("DATABASE_URL").startsWith(
      "postgres",
      "DATABASE_URL must be a PostgreSQL connection string",
    ),

    /**
     * Single switch for the cache backend.
     *
     * false -> in-process node-cache
     * true  -> Redis
     *
     * Backs OTP storage, rate limiting and business-config cache.
     */
    REDIS: booleanish.default("false"),

    REDIS_URL: z.string().optional(),

    /**
     * Escape hatch for running production on the in-process cache.
     */
    ALLOW_MEMORY_CACHE_IN_PRODUCTION: booleanish.default("false"),

    // JWT
    JWT_SECRET: nonEmpty("JWT_SECRET").min(
      32,
      "JWT_SECRET must be at least 32 characters",
    ),

    JWT_ACCESS_TTL: z.string().default("15m"),

    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // OTP
    OTP_PEPPER: nonEmpty("OTP_PEPPER").min(
      32,
      "OTP_PEPPER must be at least 32 characters",
    ),

    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),

    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),

    /**
     * Dedicated Google Play reviewer account.
     *
     * These values are optional so local development can continue to use the
     * normal console OTP provider.
     *
     * IMPORTANT:
     * - Never hardcode the real values in source code.
     * - Never expose the OTP in production API responses.
     */
    PLAY_REVIEW_MOBILE: z.string().trim().optional(),

    PLAY_REVIEW_OTP: z.string().trim().optional(),

    CORS_ORIGINS: z.string().default(""),

    // OTP provider
    OTP_PROVIDER: z.enum(["console", "msg91"]).default("console"),

    MSG91_AUTH_KEY: z.string().optional(),

    MSG91_TEMPLATE_ID: z.string().optional(),

    MSG91_SENDER_ID: z.string().optional(),

    // Payment
    //
    // mock       = dev stub
    // upi_intent = pay directly to shop VPA
    // razorpay   = full gateway
    PAYMENT_PROVIDER: z
      .enum(["mock", "upi_intent", "razorpay"])
      .default("mock"),

    /** The shop's UPI address. */
    UPI_VPA: z.string().optional(),

    /** Shown in the customer's UPI app as the payee. */
    UPI_PAYEE_NAME: z.string().default("AdiOne"),

    RAZORPAY_KEY_ID: z.string().optional(),

    RAZORPAY_KEY_SECRET: z.string().optional(),

    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    // Notifications
    NOTIFICATION_PROVIDER: z.enum(["console", "fcm"]).default("console"),

    FCM_PROJECT_ID: z.string().optional(),

    FCM_CLIENT_EMAIL: z.string().optional(),

    FCM_PRIVATE_KEY: z.string().optional(),

    // Storage
    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),

    STORAGE_PUBLIC_BASE_URL: z.string().default("http://localhost:4000/static"),

    S3_ENDPOINT: z.string().optional(),

    S3_REGION: z.string().default("auto"),

    S3_BUCKET: z.string().optional(),

    S3_ACCESS_KEY_ID: z.string().optional(),

    S3_SECRET_ACCESS_KEY: z.string().optional(),

    SEARCH_PROVIDER: z.enum(["postgres"]).default("postgres"),

    // Admin
    ADMIN_EMAIL: z.string().email().default("owner@adione.in"),

    ADMIN_PASSWORD: z.string().min(8).default("ChangeMe@123"),

    ADMIN_NAME: z.string().default("Store Owner"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
      });

    /*
     * ------------------------------------------------------------------------
     * Redis
     * ------------------------------------------------------------------------
     */

    if (env.REDIS && !env.REDIS_URL) {
      fail("REDIS_URL", "REDIS_URL is required when REDIS=true");
    }

    /*
     * ------------------------------------------------------------------------
     * OTP provider
     * ------------------------------------------------------------------------
     */

    if (env.OTP_PROVIDER === "msg91" && !env.MSG91_AUTH_KEY) {
      fail(
        "MSG91_AUTH_KEY",
        "MSG91_AUTH_KEY is required when OTP_PROVIDER=msg91",
      );
    }

    /*
     * ------------------------------------------------------------------------
     * Google Play reviewer credentials
     * ------------------------------------------------------------------------
     */

    const hasReviewMobile = Boolean(env.PLAY_REVIEW_MOBILE);
    const hasReviewOtp = Boolean(env.PLAY_REVIEW_OTP);

    if (hasReviewMobile) {
      if (!/^\d{10}$/.test(env.PLAY_REVIEW_MOBILE!)) {
        fail("PLAY_REVIEW_MOBILE", "must be exactly 10 digits");
      }
    }

    if (hasReviewOtp) {
      const otpPattern = new RegExp(`^\\d{${env.OTP_LENGTH}}$`);

      if (!otpPattern.test(env.PLAY_REVIEW_OTP!)) {
        fail("PLAY_REVIEW_OTP", `must be exactly ${env.OTP_LENGTH} digits`);
      }
    }

    if (hasReviewMobile && !hasReviewOtp) {
      fail("PLAY_REVIEW_OTP", "required when PLAY_REVIEW_MOBILE is configured");
    }

    if (hasReviewOtp && !hasReviewMobile) {
      fail("PLAY_REVIEW_MOBILE", "required when PLAY_REVIEW_OTP is configured");
    }

    /*
     * ------------------------------------------------------------------------
     * Payments
     * ------------------------------------------------------------------------
     */

    if (env.PAYMENT_PROVIDER === "upi_intent" && !env.UPI_VPA) {
      fail("UPI_VPA", "UPI_VPA is required when PAYMENT_PROVIDER=upi_intent");
    }

    if (env.PAYMENT_PROVIDER === "razorpay") {
      if (!env.RAZORPAY_KEY_ID) {
        fail("RAZORPAY_KEY_ID", "required when PAYMENT_PROVIDER=razorpay");
      }

      if (!env.RAZORPAY_KEY_SECRET) {
        fail("RAZORPAY_KEY_SECRET", "required when PAYMENT_PROVIDER=razorpay");
      }

      if (!env.RAZORPAY_WEBHOOK_SECRET) {
        fail(
          "RAZORPAY_WEBHOOK_SECRET",
          "required when PAYMENT_PROVIDER=razorpay",
        );
      }
    }

    /*
     * ------------------------------------------------------------------------
     * Storage
     * ------------------------------------------------------------------------
     */

    if (env.STORAGE_PROVIDER === "s3") {
      if (!env.S3_BUCKET) {
        fail("S3_BUCKET", "required when STORAGE_PROVIDER=s3");
      }

      if (!env.S3_ACCESS_KEY_ID) {
        fail("S3_ACCESS_KEY_ID", "required when STORAGE_PROVIDER=s3");
      }

      if (!env.S3_SECRET_ACCESS_KEY) {
        fail("S3_SECRET_ACCESS_KEY", "required when STORAGE_PROVIDER=s3");
      }
    }

    /*
     * ------------------------------------------------------------------------
     * Test database safety
     * ------------------------------------------------------------------------
     */

    if (env.NODE_ENV === "test" && !/_test(\?|$)/.test(env.DATABASE_URL)) {
      fail(
        "DATABASE_URL",
        `NODE_ENV=test requires a database whose name ends in "_test" (got: ${env.DATABASE_URL}). ` +
          "The test suite truncates every table.",
      );
    }

    /*
     * ------------------------------------------------------------------------
     * Production guards
     * ------------------------------------------------------------------------
     */

    if (env.NODE_ENV === "production") {
      if (!env.REDIS && !env.ALLOW_MEMORY_CACHE_IN_PRODUCTION) {
        fail(
          "REDIS",
          "the in-process cache is per-process and loses OTP + rate-limit state on restart. " +
            "Set REDIS=true, or ALLOW_MEMORY_CACHE_IN_PRODUCTION=true if you accept that on a single-instance deployment",
        );
      }

      if (env.OTP_PROVIDER === "console") {
        fail(
          "OTP_PROVIDER",
          "the console OTP provider prints OTPs to logs; not allowed in production",
        );
      }

      if (env.PAYMENT_PROVIDER === "mock") {
        fail(
          "PAYMENT_PROVIDER",
          "the mock payment provider takes no real money; not allowed in production",
        );
      }

      if (env.STORAGE_PROVIDER === "local") {
        fail(
          "STORAGE_PROVIDER",
          "local disk storage is not durable; use s3 in production",
        );
      }

      if (env.JWT_SECRET.includes("change-me")) {
        fail("JWT_SECRET", "JWT_SECRET still holds the example value");
      }

      if (env.OTP_PEPPER.includes("change-me")) {
        fail("OTP_PEPPER", "OTP_PEPPER still holds the example value");
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");

    // eslint-disable-next-line no-console
    console.error(
      `\n[AdiOne] Invalid environment configuration.\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.\n`,
    );

    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";

export const isTest = env.NODE_ENV === "test";

export const isDevelopment = env.NODE_ENV === "development";

/** Parsed CORS allow-list. Empty means no browser origin permitted. */
export const corsOrigins: string[] = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
