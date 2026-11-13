/**
 * Multi-variant product management in the panels — run with `npm run test:unit`.
 * The pages need a browser, so their wiring is checked on the source; every
 * rule is enforced (and tested) by the backend:
 * backend tests/integration/product-variant-management.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const rows = read('src/seller/productRows.ts');
const list = read('src/seller/pages/SellerProducts.tsx');
const detail = read('src/seller/pages/SellerProductDetail.tsx');
const manager = read('src/seller/variantManager.tsx');
const adminProducts = read('src/pages/Products.tsx');

describe('seller product list: one row per parent product', () => {
  it('every listing of an own product — each variant, not only the default — belongs to that product row', () => {
    assert.match(rows, /products\.flatMap\(\(p\) => \[p\.listing\?\.id, \.\.\.\(p\.variants \?\? \[\]\)\.map\(\(v\) => v\.listing\?\.id\)\]\)/);
    assert.match(rows, /\.filter\(\(l\) => !l\.ownProduct && !ownListingIds\.has\(l\.id\)\)/);
  });

  it('a multi-variant row shows its price range, each variant\'s stock and "Manage variants"', () => {
    assert.match(rows, /sizes: sizesOf\(p\),/);
    assert.match(rows, /maxPricePaise: maxPriceOf\(p\),/);
    assert.match(list, /function PriceRange\(\{ row \}: \{ row: ProductRow \}\)/);
    assert.match(list, /function SizeLine\(\{ row \}: \{ row: ProductRow \}\)/);
    assert.match(list, /to=\{`\$\{row\.href\}#variants`\}[^>]*>\s*Manage variants/);
    assert.doesNotMatch(list, /Stock per size/);
  });
});

describe('seller product page: the variant manager', () => {
  it('a multi-variant product gets the Variants section; a single-variant one keeps Pricing and Inventory', () => {
    assert.match(detail, /const multi = \(product\.variants\?\.length \?\? 0\) > 1 \|\| \(product\.optionGroups\?\.length \?\? 0\) > 0;/);
    assert.match(detail, /<Section id="variants" title="3\. Variants"/);
    assert.match(detail, /<VariantManager product=\{product\} food=\{isFood\} onChanged=\{refresh\} onNotice=\{setNotice\} \/>/);
    assert.match(detail, /\{!multi && \(\n\s*<Section id="pricing" title="3\. Pricing">/);
  });

  it('each variant is changed on its own: its listing for price / stock / on sale, its own routes for show / hide, edit, delete, add', () => {
    assert.match(manager, /sellerApi\.patch\(`\/seller\/listings\/\$\{v\.listing!\.id\}`, \{ isAvailable: on \}\)/);
    assert.match(manager, /`\/seller\/products\/\$\{product\.id\}\/variants\/\$\{v\.id\}\/visibility`, \{ visible: shown \}/);
    assert.match(manager, /sellerApi\.delete\(`\/seller\/products\/\$\{product\.id\}\/variants\/\$\{target\.id\}`\)/);
    assert.match(manager, /sellerApi\.post\(`\/seller\/products\/\$\{product\.id\}\/variants`, body\)/);
    assert.match(manager, /sellerApi\.patch\(`\/seller\/products\/\$\{product\.id\}\/variants\/\$\{mode\.variant\.id\}`, body\)/);
    // The ledgered price and stock panels, one per variant listing.
    assert.match(manager, /<PricingPanel key=\{`p-\$\{v\.listing\.id\}`\} listing=\{v\.listing\}/);
    assert.match(manager, /<InventoryPanel key=\{`i-\$\{v\.listing\.id\}`\} listing=\{v\.listing\}/);
  });

  it('deleting asks first, the last variant cannot be deleted, and a product in review locks add / edit / delete', () => {
    assert.match(manager, /title=\{`Delete \$\{deleting\.variantName\}\?`\}/);
    assert.match(manager, /disabled=\{busy !== null \|\| underReview \|\| variants\.length <= 1\}/);
    assert.match(manager, /const underReview = product\.latestApproval\?\.status === 'PENDING';/);
  });

  it('desktop gets a table, phones get expandable cards', () => {
    assert.match(manager, /<div className="hidden overflow-x-auto rounded-xl border border-gray-200 md:block">/);
    assert.match(manager, /<ul className="grid gap-2 md:hidden"/);
    for (const column of ['Selling price', 'MRP', 'Stock', 'Reserved', 'Available', 'Status']) {
      assert.match(manager, new RegExp(`>${column}</th>`));
    }
  });
});

describe('admin products: grouped, with every variant underneath', () => {
  it('a grouped row expands into its variants with their own price, stock, review and status', () => {
    // The toggle sits in ProductName (shared by the cards and the table); `open` is that row's state.
    assert.match(adminProducts, /\{open \? 'Hide variants' : `Show \$\{row\.variants!\.length\} variants`\}/);
    assert.match(adminProducts, /<ProductName row=\{row\} open=\{open\.has\(row\.key\)\} onToggle=\{\(\) => toggleOpen\(row\.key\)\} \/>/);
    assert.match(adminProducts, /<VariantBreakdown row=\{row\} \/>/);
    assert.match(adminProducts, /<td className="px-3 py-2"><ApprovalBadge status=\{v\.approvalStatus\} \/><\/td>/);
    assert.match(adminProducts, /function priceRangeOf\(row: MarketplaceProductRow\): string \| null/);
  });
});
