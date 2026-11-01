/**
 * Payment-launch diagnostics (src/lib/paymentDiagnostics.ts) never carry a
 * session token or secret, and are off outside the diagnostic build.
 * Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PAYMENT_DIAGNOSTICS, recordDiagnostic, sanitizeDiagnostic, usePaymentDiagnostics } from "../src/lib/paymentDiagnostics.ts";

const SESSION = "session_" + "x".repeat(124); // 132 characters, like production

describe("payment diagnostics", () => {
  it("a raw session id is cut to a prefix + length; an already-masked one is kept", () => {
    const out = sanitizeDiagnostic({ payment_session_id: SESSION, session: "session_ab…(132)", cashfreeOrderId: "order_123" });
    assert.equal(out.payment_session_id, "session_xx…(132)");
    assert.equal(out.session, "session_ab…(132)");
    assert.equal(out.cashfreeOrderId, "order_123");
  });

  it("secret-looking keys are hidden and long values shortened — also inside Cashfree event meta", () => {
    const out = sanitizeDiagnostic({
      code: "NOT_AVAILABLE",
      message: "isn't a trusted source",
      meta: { client_secret: "abc", token: "t", payment_session_id: SESSION, long: "y".repeat(100) },
    }) as { code: string; message: string; meta: Record<string, string> };
    assert.equal(out.code, "NOT_AVAILABLE");
    assert.equal(out.message, "isn't a trusted source");
    assert.equal(out.meta.client_secret, "[hidden]");
    assert.equal(out.meta.token, "[hidden]");
    assert.equal(out.meta.payment_session_id, "session_xx…(132)");
    assert.equal(out.meta.long, "yyyyyyyyyy…(100)");
    assert.doesNotMatch(JSON.stringify(out), /x{20}/);
  });

  it("off outside the diagnostic build: nothing is recorded", () => {
    assert.equal(PAYMENT_DIAGNOSTICS, false);
    recordDiagnostic("sdk_invoke", { at: "now" });
    assert.equal(usePaymentDiagnostics.getState().lines.length, 0);
  });
});
