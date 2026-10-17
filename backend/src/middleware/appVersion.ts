/**
 * Server-side minimum-version enforcement for the customer app.
 *
 * The app sends on every request (shared/app-version.ts):
 *   X-App-Platform: android | ios
 *   X-App-Version:  1.0.8          (installed marketing version)
 *   X-App-Build:    9              (native build number; informational)
 *
 * Mounted ONLY on the customer commerce routers (routes/index.ts): cart,
 * addresses, checkout, orders, payments, referrals and rewards. A request is
 * refused with 426 APP_UPDATE_REQUIRED when, under the enabled policy:
 *   - it says it is the app and its version must update (evaluateAppUpdate);
 *   - or it sends no usable app version, comes from a CUSTOMER-APP session
 *     (an app build from before version checks), and the admin switched on
 *     "block apps that do not report a version".
 *
 * Everything else passes untouched — the admin panel and seller panel (no app
 * headers, full-scope sessions), gateway webhooks and other integrations (no
 * session at all), health checks — and these payment paths are always open so
 * money already taken can be verified while an update is pending:
 *   POST /payments/webhook, POST /payments/verify,
 *   POST /payments/:orderId/refresh, GET /payments/:orderId/status.
 *
 * Fail-open: if the policy cannot be read, nothing is blocked
 * (app-version.service.ts).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  APP_VERSION_HEADERS,
  AppUpdateStatus,
  ErrorCode,
  buildAppUpdateCheck,
  isAppPlatform,
  isValidVersion,
  type AppPlatform,
  type AppUpdateCheckDto,
} from '../shared';
import { AppError } from '../common/errors';
import { verifyAccessToken } from '../modules/auth/token.service';
import * as appVersionService from '../modules/app-version/app-version.service';

/** The app identity a request declares; nulls when it declares none (or nonsense). */
export interface AppClientInfo {
  platform: AppPlatform | null;
  version: string | null;
  build: string | null;
}

export function readAppClient(req: Request): AppClientInfo {
  const platform = req.header(APP_VERSION_HEADERS.PLATFORM)?.trim().toLowerCase() ?? null;
  const version = req.header(APP_VERSION_HEADERS.VERSION)?.trim() ?? null;
  const build = req.header(APP_VERSION_HEADERS.BUILD)?.trim() ?? null;
  return {
    platform: isAppPlatform(platform) ? platform : null,
    version: isValidVersion(version) ? version : null,
    build: build && /^\d{1,10}$/.test(build) ? build : null,
  };
}

/** Payment paths that must stay open while an update is pending (see top). */
const ALWAYS_OPEN_PAYMENT_PATHS = [/^\/webhook\/?$/, /^\/verify\/?$/, /^\/[^/]+\/refresh\/?$/, /^\/[^/]+\/status\/?$/];

/** A request carrying a valid CUSTOMER-APP access token (never throws). */
function isCustomerAppSession(req: Request): boolean {
  const header = req.header('authorization');
  if (!header) return false;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return false;
  try {
    return verifyAccessToken(token).scp === 'customer';
  } catch {
    // An invalid/expired token is the auth middleware's business, not ours.
    return false;
  }
}

function updateRequired(check: AppUpdateCheckDto | null): AppError {
  return new AppError(ErrorCode.APP_UPDATE_REQUIRED, {
    ...(check
      ? {
          message: check.message,
          // Only what the app needs to show its update screen.
          details: [{ field: 'appUpdate', message: check.title, update: check }],
        }
      : {}),
    internalMessage: check
      ? `${check.platform} ${check.installedVersion ?? '?'} below the supported version`
      : 'customer-app request without an app version while unversioned apps are blocked',
  });
}

function gate(options: { alwaysOpen?: RegExp[] }): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (options.alwaysOpen?.some((pattern) => pattern.test(req.path))) return next();

      const policy = await appVersionService.getPolicy();
      if (!policy.enabled) return next();

      const client = readAppClient(req);
      if (client.platform && client.version) {
        const check = buildAppUpdateCheck(policy, client.platform, client.version);
        if (check.status === AppUpdateStatus.REQUIRED) throw updateRequired(check);
        return next();
      }

      // No usable app version. An app build from before version checks
      // (or a client hiding its version) is refused only when the admin asked
      // for it, and only for customer-app sessions — never the panels or
      // integrations, which send no app headers by design.
      if (policy.blockUnversionedClients && isCustomerAppSession(req)) {
        throw updateRequired(
          client.platform
            ? { ...buildAppUpdateCheck(policy, client.platform, null), status: AppUpdateStatus.REQUIRED }
            : null,
        );
      }
      return next();
    } catch (error) {
      next(error);
    }
  };
}

/** For the customer commerce routers. */
export const requireSupportedAppVersion: RequestHandler = gate({});

/** For the payments router: the same, but money already taken can always be verified. */
export const requireSupportedAppVersionForPayments: RequestHandler = gate({ alwaysOpen: ALWAYS_OPEN_PAYMENT_PATHS });
