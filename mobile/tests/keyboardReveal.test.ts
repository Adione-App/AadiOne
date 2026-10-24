/**
 * Keyboard-aware scrolling for the login and OTP screens
 * (src/lib/keyboardReveal.ts) — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { revealScrollTarget, type RevealInput } from "../src/lib/keyboardReveal.ts";

const base: RevealInput = { blockTop: 420, blockBottom: 560, viewportHeight: 800, scrollY: 0, topReserve: 80, bottomGap: 16 };

describe("revealScrollTarget", () => {
  it("does not move when the block is already visible (keyboard closed or a tall phone)", () => {
    assert.equal(revealScrollTarget(base), null);
  });

  it("scrolls just enough for the button to clear the keyboard, using the measured viewport", () => {
    // A 640 dp phone with a ~300 dp numeric keyboard: 340 dp left above it.
    assert.equal(revealScrollTarget({ ...base, viewportHeight: 340 }), 560 + 16 - 340);
    // A bigger keyboard leaves less room, so it scrolls further — no fixed offset.
    assert.equal(revealScrollTarget({ ...base, viewportHeight: 280 }), 560 + 16 - 280);
  });

  it("keeps the input visible when the block is taller than the room left", () => {
    const target = revealScrollTarget({ ...base, blockBottom: 900, viewportHeight: 300 });
    assert.equal(target, 420 - 80);
  });

  it("scrolls back up when the block's top is hidden under the top reserve", () => {
    assert.equal(revealScrollTarget({ ...base, scrollY: 400, viewportHeight: 400 }), 420 - 80);
  });

  it("never returns a negative offset or a no-op move", () => {
    assert.equal(revealScrollTarget({ ...base, blockTop: 20, blockBottom: 100, scrollY: 50, viewportHeight: 300 }), 0);
    assert.equal(revealScrollTarget({ ...base, viewportHeight: 340, scrollY: 236 }), null);
    assert.equal(revealScrollTarget({ ...base, viewportHeight: 0 }), null);
  });
});
