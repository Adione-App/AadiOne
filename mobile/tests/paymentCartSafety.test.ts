/**
 * An unpaid online checkout never empties the cart, and is never shown as an
 * order — checked on the source, since the screens need a device. Run with
 * `npm run test:unit`. (The flow itself: tests/paymentFlow.test.ts; the
 * server side: backend tests/integration/payment-cart-retention.test.ts.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const cart = read("src/screens/cart/CartScreen.tsx");

/** The body of `placeOrder`'s success path, from the POST to the online branch. */
function successPath(): { cod: string; online: string } {
  const start = cart.indexOf("await checkoutIntents.completed();");
  const codStart = cart.indexOf("if (!result.requiresPayment) {", start);
  const onlineStart = cart.indexOf("markPaymentStage(\"orderResponse\")", codStart);
  assert.ok(start > 0 && codStart > start && onlineStart > codStart, "placeOrder's success path moved");
  return { cod: cart.slice(codStart, onlineStart), online: cart.slice(start, codStart) + cart.slice(onlineStart, onlineStart + 4000) };
}

describe("the cart is cleared only for a placed order", () => {
  it("cash on delivery clears the local cart (the order is placed)", () => {
    const { cod } = successPath();
    assert.match(cod, /clearCartAfterOrder\(queryClient\)/);
    assert.match(cod, /resetPendingCartAfterOrder\(\)/);
  });

  it("an online checkout never clears it — not at order creation, not on the SDK's callback", () => {
    const { online } = successPath();
    assert.doesNotMatch(online, /clearCartAfterOrder|resetPendingCartAfterOrder/);
    assert.equal(cart.match(/clearCartAfterOrder\(queryClient\)/g)?.length, 1);
    for (const rel of ["src/lib/paymentFlow.ts", "src/lib/pendingPayment.ts", "src/lib/cashfree.ts"]) {
      assert.doesNotMatch(read(rel), /clearCartAfterOrder|resetPendingCartAfterOrder|clearCart\(/, rel);
    }
  });

  it("a confirmed payment reloads the cart from the server (which took the paid lines out)", () => {
    assert.match(cart, /if \(onlinePayment\.phase !== "paid"\) return;\n\s*\/\/[^\n]*\n\s*void refetch\(\);/);
  });
});

describe("an unpaid checkout is not shown as an order", () => {
  it("the 'Order awaiting payment' panel with Continue payment / Cancel order is gone", () => {
    assert.equal(existsSync(path.join(ROOT, "src/components/payment/PendingPaymentPanel.tsx")), false);
    for (const rel of [
      "src/screens/cart/CartScreen.tsx",
      "src/components/payment/PaymentStatusStrip.tsx",
      "src/components/payment/PaymentFailedSheet.tsx",
      "src/components/payment/PaymentVerificationScreen.tsx",
    ]) {
      const text = read(rel);
      assert.doesNotMatch(text, /awaiting payment ·|Order awaiting payment/, rel);
      assert.doesNotMatch(text, /label="Cancel order"|Continue payment ·/, rel);
      assert.doesNotMatch(text, /\/orders\/\$\{[^}]+\}\/cancel/, rel);
    }
  });

  it("the verification screen and the failed sheet say what was asked for", () => {
    const sheet = read("src/components/payment/PaymentFailedSheet.tsx");
    assert.match(sheet, /Payment failed/);
    assert.match(sheet, /label="Retry payment"/);
    assert.match(sheet, /label="Try another payment method"/);
    assert.match(sheet, /accessibilityLabel="Close and return to cart"/);
    assert.doesNotMatch(sheet, /24 hours|refund within/i);
    assert.match(read("src/lib/paymentFlow.ts"), /Please wait while your payment is being verified\./);
  });

  it("Close and 'Try another payment method' go back to the cart; Retry pays the same order", () => {
    assert.match(cart, /onClose=\{dismissPaymentFailure\}/);
    assert.match(cart, /onAnotherMethod=\{\(\) => \{\n\s*dismissPaymentFailure\(\);/);
    assert.match(cart, /void resumePayment\(\)/);
  });
});
