import type { UserRole } from '../shared';

/**
 * The authenticated principal, attached by the auth middleware.
 *
 * Deliberately minimal: it carries only what came out of the verified token.
 * Anything else (profile, addresses, cart) is loaded by the service that needs
 * it, so a stale token can never smuggle stale user data into a decision.
 */
export interface AuthUser {
  id: string;
  role: UserRole;
  mobile: string;
  /** Refresh-token family id — lets us revoke this exact session. */
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Set by the idempotency middleware when a stored response was replayed. */
      idempotencyKey?: string;
      /** Set by `attachSellerContext` (middleware/sellerAuth.ts) — the ONE
       * seller this request may act as. Never trust a client-supplied
       * sellerId instead of this. */
      sellerId?: string;
    }
  }
}

export {};
