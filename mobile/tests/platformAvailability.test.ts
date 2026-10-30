/**
 * App-wide availability as the app shows it (src/lib/platformAvailability.ts)
 * — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLOSED_MESSAGE, MAX_REFRESH_DELAY_MS, globalClosedNotice, refreshDelayMs } from "../src/lib/platformAvailability.ts";

describe("global closed notice", () => {
  it("shows the server's message while closed, nothing while open", () => {
    assert.equal(globalClosedNotice({ acceptingOrders: true, message: null }, null), null);
    assert.equal(
      globalClosedNotice({ acceptingOrders: false, message: "Aadione is closed right now. Opens tomorrow at 8:00 AM." }, null),
      "Aadione is closed right now. Opens tomorrow at 8:00 AM.",
    );
    assert.equal(globalClosedNotice({ acceptingOrders: false, message: null }, null), DEFAULT_CLOSED_MESSAGE);
  });

  it("the server's computed answer wins over the raw master switch", () => {
    // Switch ON but outside hours: closed. Switch OFF is already folded into the answer.
    assert.equal(
      globalClosedNotice({ acceptingOrders: false, message: "Closed for Diwali." }, { ORDERING_ENABLED: true, ORDERING_PAUSED_MESSAGE: "" }),
      "Closed for Diwali.",
    );
    assert.equal(globalClosedNotice({ acceptingOrders: true, message: null }, { ORDERING_ENABLED: true, ORDERING_PAUSED_MESSAGE: "" }), null);
  });

  it("an older server (no /availability): the master switch, as before", () => {
    assert.equal(globalClosedNotice(undefined, { ORDERING_ENABLED: false, ORDERING_PAUSED_MESSAGE: "Back at 7." }), "Back at 7.");
    assert.equal(globalClosedNotice(undefined, { ORDERING_ENABLED: false, ORDERING_PAUSED_MESSAGE: "" }), DEFAULT_CLOSED_MESSAGE);
    assert.equal(globalClosedNotice(undefined, { ORDERING_ENABLED: true, ORDERING_PAUSED_MESSAGE: "" }), null);
    assert.equal(globalClosedNotice(null, null), null);
  });
});

describe("asking again at the next change", () => {
  const now = Date.parse("2026-11-02T10:00:00+05:30");
  it("just after the server's next change; never immediately, never longer than the cap", () => {
    assert.equal(refreshDelayMs("2026-11-02T10:30:00+05:30", now), 30 * 60_000 + 2_000);
    assert.equal(refreshDelayMs("2026-11-02T09:59:00+05:30", now), 1_000);
    assert.equal(refreshDelayMs("2026-11-20T08:00:00+05:30", now), MAX_REFRESH_DELAY_MS);
  });
  it("nothing scheduled, or an unreadable time: no timer", () => {
    assert.equal(refreshDelayMs(undefined, now), null);
    assert.equal(refreshDelayMs("soon", now), null);
  });
});
