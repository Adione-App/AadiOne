/**
 * One out-of-stock label everywhere — components/OutOfStockLabel.tsx with the
 * text from lib/stockLabel.ts. It used to read "Out of Stock" on the image
 * badge (where the wishlist heart covered it: "Out of" / "Out"), "Sold Out"
 * in the card's action slot, "Out of stock" on the product page and "Sold
 * out" in the variant sheet.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_OF_STOCK_LABEL } from "../src/lib/stockLabel.ts";
import { notAddableLabel } from "../src/lib/closureDisplay.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("the out-of-stock label", () => {
  it("is exactly \"Out of Stock\"", () => {
    assert.equal(OUT_OF_STOCK_LABEL, "Out of Stock");
    assert.equal(notAddableLabel(false, false, null).text, "Out of Stock");
    // Store closed / app closed keep their own wording (not stock).
    assert.equal(notAddableLabel(true, false, null).text, "Store closed");
    assert.equal(notAddableLabel(true, true, null).text, "Unavailable");
  });

  it("the shared component draws it on one line, never ellipsised, with font scaling capped", () => {
    const label = read("src/components/OutOfStockLabel.tsx");
    assert.match(label, /\{OUT_OF_STOCK_LABEL\}/);
    assert.match(label, /numberOfLines=\{1\}/);
    assert.match(label, /adjustsFontSizeToFit/);
    assert.match(label, /maxFontSizeMultiplier=\{OUT_OF_STOCK_MAX_FONT_SCALE\}/);
    assert.match(label, /flexShrink: 0/);
  });

  it("product cards show it in the action slot — no badge left under the wishlist heart", () => {
    const card = read("src/components/ProductCard.tsx");
    assert.match(card, /\{notAddable && !storeClosed \? \(\s*\/\/[^\n]*\n\s*<OutOfStockLabel \/>/);
    assert.doesNotMatch(card, /outOfStockBadge/);
    assert.doesNotMatch(card, />\s*Out of Stock\s*</);
  });

  it("no customer product surface spells it any other way", () => {
    const files = [
      "src/components/ProductCard.tsx",
      "src/components/VariantSheet.tsx",
      "src/screens/catalog/ProductDetailScreen.tsx",
      "src/screens/catalog/CategoriesScreen.tsx",
      "src/screens/home/HomeScreen.tsx",
      "src/lib/closureDisplay.ts",
    ];
    // Code only — comments may quote the old, broken labels.
    const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    for (const file of files) {
      const source = code(read(file));
      assert.doesNotMatch(source, /["'>]\s*(Sold [Oo]ut|Out of stock|Out of|Out)\s*["'<]/, file);
    }
    assert.match(read("src/screens/catalog/ProductDetailScreen.tsx"), /<OutOfStockLabel size="large" \/>/);
    assert.match(read("src/components/VariantSheet.tsx"), /closedMessage \? "Unavailable" : OUT_OF_STOCK_LABEL/);
  });
});
