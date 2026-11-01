/**
 * Pay Online → Cashfree's own checkout, with no Aadione payment screen in
 * between — checked on the source, since the screens themselves need a
 * device. Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "shared" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const all = sources(SRC).map((file) => ({ file: path.relative(ROOT, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("Cashfree's checkout is the payment screen", () => {
  it("the old Aadione payment / retry screen for Cashfree is gone, and its messages with it", () => {
    assert.equal(existsSync(path.join(SRC, "screens/checkout/CashfreeCheckout.tsx")), false);
    for (const { file, text } of all) {
      assert.doesNotMatch(text, /The payment was not completed\. You can try again/, file);
      assert.doesNotMatch(text, /Opening secure checkout…/, file);
    }
  });

  it("Cashfree's own checkout (doWebPayment) is opened by the SDK wrapper only — no WebView, no imitation", () => {
    // A call (`service.doWebPayment(`), not a mention in a comment.
    const opening = all.filter(({ text }) => /\.doWebPayment\(/.test(text)).map(({ file }) => file);
    assert.deepEqual(opening, ["src/lib/cashfree.ts"]);
    for (const { file, text } of all) assert.doesNotMatch(text, /react-native-webview/, file);
  });

  it("the Cart opens it straight away after the order: startPayment, not a navigation to a payment screen", () => {
    const cart = read("src/screens/cart/CartScreen.tsx");
    assert.match(cart, /void startPayment\(\{ \.\.\.pending, amountPaise: session\.amountPaise \}, session\.cashfree\)/);
    // The only navigation for an online order is the manual-UPI branch (development servers).
    const placedOnline = [...cart.matchAll(/onPlaced\(result\.order, true\)/g)];
    assert.equal(placedOnline.length, 1);
    const index = cart.indexOf("onPlaced(result.order, true)");
    assert.match(cart.slice(Math.max(0, index - 400), index), /upiIntentUrl/);
  });

  it("the SDK callback resolves once, and one checkout is open at a time", () => {
    const wrapper = read("src/lib/cashfree.ts");
    assert.match(wrapper, /if \(settled\) return;/);
    assert.match(wrapper, /if \(open\) return open;/);
  });

  it("the environment comes from the server's session (sandbox / production), never hardcoded", () => {
    const wrapper = read("src/lib/cashfree.ts");
    assert.match(wrapper, /checkout\.environment === "PRODUCTION"/);
  });
});
