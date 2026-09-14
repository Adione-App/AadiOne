import { createHmac, randomInt } from "node:crypto";

import { AppError } from "../../common/errors";
import { moduleLogger } from "../../common/logger";
import { safeEqual } from "../../common/crypto";
import { cache, CacheKey } from "../../infra/cache";
import { env, isProduction } from "../../config/env";
import { otpProvider } from "../../infra/otp";
import { maskMobile } from "../../shared/phone";

const log = moduleLogger("otp");

export interface SendOtpOutcome {
  resendAfterSeconds: number;
  expiresInSeconds: number;
  devOtp?: string;
}

/**
 * Hash OTP before storing it.
 *
 * The plaintext OTP is never stored in cache.
 */
function hashCode(code: string): string {
  return createHmac("sha256", env.OTP_PEPPER).update(code).digest("hex");
}

/**
 * Generate a cryptographically secure numeric OTP.
 */
function generateOtp(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length;

  return randomInt(min, max).toString();
}

function otpKey(mobile: string): string {
  return CacheKey.otp(mobile);
}

function attemptsKey(mobile: string): string {
  return CacheKey.otpAttempts(mobile);
}

function cooldownKey(mobile: string): string {
  return CacheKey.otpResendCooldown(mobile);
}

/**
 * Send OTP to a mobile number.
 *
 * Normal users:
 *   - Generate random OTP
 *   - Store only OTP hash
 *   - Send through configured OTP provider
 *
 * Google Play reviewer:
 *   - Use fixed OTP from environment
 *   - Store only OTP hash
 *   - Do NOT call SMS provider
 *   - Still uses TTL, cooldown and attempt limits
 */
export async function sendOtp(mobile: string): Promise<SendOtpOutcome> {
  /*
   * Dedicated Google Play reviewer account.
   *
   * This only activates when the requested mobile number exactly matches
   * PLAY_REVIEW_MOBILE configured in the environment.
   */
  const isPlayReviewAccount =
    Boolean(env.PLAY_REVIEW_MOBILE) && mobile === env.PLAY_REVIEW_MOBILE;

  /*
   * Resend cooldown applies to every account, including
   * the Google Play reviewer account.
   */
  const existingCooldown = await cache.get(cooldownKey(mobile));

  if (existingCooldown) {
    throw new AppError("OTP_RESEND_TOO_SOON" as never, {
      message: "Please wait before requesting another OTP.",
      internalMessage: `OTP resend too soon for ${maskMobile(mobile)}`,
    });
  }

  /*
   * Normal users receive a cryptographically random OTP.
   *
   * The dedicated Play reviewer receives the configured reusable OTP.
   */
  const code = isPlayReviewAccount
    ? env.PLAY_REVIEW_OTP!
    : generateOtp(env.OTP_LENGTH);

  const expiresInSeconds = env.OTP_TTL_SECONDS;
  const expiresInMinutes = Math.ceil(expiresInSeconds / 60);

  /*
   * IMPORTANT:
   * Never store the plaintext OTP.
   */
  await cache.set(otpKey(mobile), hashCode(code), expiresInSeconds);

  /*
   * A new OTP starts with a fresh attempt counter.
   */
  await cache.delete(attemptsKey(mobile));

  try {
    /*
     * Google Play reviewer:
     *
     * Do not send an SMS.
     * The reusable OTP is supplied to Google Play in the
     * App Access / reviewer instructions.
     */
    if (isPlayReviewAccount) {
      await cache.set(
        cooldownKey(mobile),
        "1",
        env.OTP_RESEND_COOLDOWN_SECONDS,
      );

      log.info(
        {
          mobile: maskMobile(mobile),
        },
        "Play review OTP prepared",
      );

      return {
        resendAfterSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
        expiresInSeconds,
      };
    }

    /*
     * Normal customer:
     * Send OTP through the configured provider.
     */
    const result = await otpProvider.send({
      mobile,
      code,
      expiresInMinutes,
    });

    log.info(
      {
        mobile: maskMobile(mobile),
        provider: otpProvider.name,
        messageId: result.messageId,
      },
      "OTP sent",
    );

    /*
     * Development console provider may return the OTP.
     *
     * NEVER expose it in production.
     */
    const devOtp = !isProduction && result.devCode ? result.devCode : undefined;

    /*
     * Start resend cooldown only after the provider succeeds.
     */
    await cache.set(cooldownKey(mobile), "1", env.OTP_RESEND_COOLDOWN_SECONDS);

    return {
      resendAfterSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      expiresInSeconds,

      ...(devOtp ? { devOtp } : {}),
    };
  } catch (error) {
    /*
     * If SMS delivery/provider fails, do not leave an OTP
     * that the customer never received.
     */
    await cache.delete(otpKey(mobile));
    await cache.delete(attemptsKey(mobile));
    await cache.delete(cooldownKey(mobile));

    throw error;
  }
}

/**
 * Verify OTP.
 *
 * Both normal users and the Google Play reviewer use exactly
 * the same verification mechanism:
 *
 * plaintext submitted OTP
 *        ↓
 * HMAC hash
 *        ↓
 * constant-time comparison
 *        ↓
 * single-use OTP
 */
export async function verifyOtp(
  mobile: string,
  submittedCode: string,
): Promise<void> {
  const storedHash = await cache.get(otpKey(mobile));

  /*
   * No OTP exists or it has expired.
   */
  if (!storedHash) {
    throw new AppError("OTP_EXPIRED" as never, {
      message: "This OTP has expired. Please request a new one.",
      internalMessage: `OTP expired for ${maskMobile(mobile)}`,
    });
  }

  /*
   * Read current incorrect-attempt count.
   */
  const attemptsRaw = await cache.get(attemptsKey(mobile));

  const attempts = attemptsRaw ? Number.parseInt(attemptsRaw, 10) : 0;

  /*
   * Hard attempt limit.
   */
  if (attempts >= env.OTP_MAX_ATTEMPTS) {
    await cache.delete(otpKey(mobile));
    await cache.delete(attemptsKey(mobile));

    throw new AppError("OTP_MAX_ATTEMPTS" as never, {
      message: "Too many incorrect attempts. Please request a new OTP.",
      internalMessage: `OTP max attempts reached for ${maskMobile(mobile)}`,
    });
  }

  /*
   * Hash the submitted OTP and compare it with the stored hash.
   *
   * This also handles the Play reviewer OTP because sendOtp()
   * stored its hash in exactly the same way.
   */
  const submittedHash = hashCode(submittedCode);

  const valid = safeEqual(submittedHash, storedHash);

  /*
   * Invalid OTP.
   */
  if (!valid) {
    const nextAttempts = attempts + 1;

    await cache.set(
      attemptsKey(mobile),
      String(nextAttempts),
      env.OTP_TTL_SECONDS,
    );

    /*
     * Delete OTP after maximum failed attempts.
     */
    if (nextAttempts >= env.OTP_MAX_ATTEMPTS) {
      await cache.delete(otpKey(mobile));
      await cache.delete(attemptsKey(mobile));

      throw new AppError("OTP_MAX_ATTEMPTS" as never, {
        message: "Too many incorrect attempts. Please request a new OTP.",
        internalMessage: `OTP max attempts reached for ${maskMobile(mobile)}`,
      });
    }

    throw new AppError("OTP_INVALID" as never, {
      message: "The OTP you entered is incorrect.",
      internalMessage: `invalid OTP for ${maskMobile(mobile)}`,
    });
  }

  /*
   * OTP verified successfully.
   *
   * Delete it immediately so it cannot be reused.
   */
  await cache.delete(otpKey(mobile));
  await cache.delete(attemptsKey(mobile));
  await cache.delete(cooldownKey(mobile));

  log.info(
    {
      mobile: maskMobile(mobile),
    },
    "OTP verified",
  );
}

/**
 * Clear all OTP-related state for a mobile number.
 */
export async function clearOtpState(mobile: string): Promise<void> {
  await Promise.all([
    cache.delete(otpKey(mobile)),
    cache.delete(attemptsKey(mobile)),
    cache.delete(cooldownKey(mobile)),
  ]);
}
