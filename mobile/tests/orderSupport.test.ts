/**
 * Order details: customer refunds switched off, and the support card with the
 * configured contacts. The contact rules are pure (src/lib/supportContact.ts);
 * the screen is checked on its source (it needs a device). Run with
 * `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { supportContact } from "../src/lib/supportContact.ts";
import { CUSTOMER_REFUNDS_ENABLED } from "../src/lib/refunds.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const screen = read("src/screens/orders/OrderTrackingScreen.tsx");
const card = read("src/components/orders/OrderSupportCard.tsx");

describe("support contacts from the configuration", () => {
  it("configured email and phone: shown, with mailto / tel links (the dial string without spaces)", () => {
    const c = supportContact({ SUPPORT_EMAIL: " support@adione.in ", SUPPORT_PHONE: "+91 98290 12345" });
    assert.deepEqual(c, { email: "support@adione.in", phone: "+91 98290 12345", mailto: "mailto:support@adione.in", tel: "tel:+919829012345" });
  });

  it("blank, missing or malformed values are never shown or linked", () => {
    for (const config of [null, undefined, {}, { SUPPORT_EMAIL: "", SUPPORT_PHONE: "" }, { SUPPORT_EMAIL: "support", SUPPORT_PHONE: "123" }]) {
      const c = supportContact(config);
      assert.equal(c.email, null);
      assert.equal(c.phone, null);
      assert.equal(c.mailto, null);
      assert.equal(c.tel, null);
    }
  });

  it("placeholder-looking values are never shown", () => {
    const c = supportContact({ SUPPORT_EMAIL: "test@example.com", SUPPORT_PHONE: "1234567890" });
    assert.equal(c.email, null);
    assert.equal(c.phone, null);
  });

  it("one configured, the other not: only that one", () => {
    const c = supportContact({ SUPPORT_EMAIL: "help@adione.in", SUPPORT_PHONE: "" });
    assert.equal(c.email, "help@adione.in");
    assert.equal(c.phone, null);
  });
});

describe("order details screen", () => {
  it("customer refunds are switched off: not fetched, no card, no request form", () => {
    assert.equal(CUSTOMER_REFUNDS_ENABLED, false);
    assert.match(screen, /useOrderRefunds\(\n\s*orderId,\n\s*CUSTOMER_REFUNDS_ENABLED && /);
    assert.match(screen, /\{CUSTOMER_REFUNDS_ENABLED && refunds && showRefundsCard\(refunds\) && \(/);
    assert.match(screen, /\{CUSTOMER_REFUNDS_ENABLED && refunds\?\.request\.eligible && \(/);
  });

  it("the support card sits at the bottom, below the order summary and actions", () => {
    const summary = screen.indexOf("<View style={styles.summaryCard}>");
    const support = screen.indexOf("<OrderSupportCard />");
    const end = screen.indexOf("</ScrollView>");
    assert.ok(summary > 0 && support > summary && support < end);
    assert.ok(support > screen.indexOf("CANCEL ERROR"));
  });

  it("the card: heading, both rows with icons and links, and nothing at all without contacts", () => {
    assert.match(card, /Need help with your order\?/);
    assert.match(card, /Email Support/);
    assert.match(card, /Call Support/);
    assert.match(card, /import \{ Mail, Phone \} from 'lucide-react-native';/);
    assert.match(card, /if \(!contact\.email && !contact\.phone\) return null;/);
    assert.match(card, /Linking\.openURL\(url\)/);
  });
});
