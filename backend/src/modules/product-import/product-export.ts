/**
 * Product export (Seller Panel → Products → Bulk Import → Export) — the
 * seller's own products as a CSV in the IMPORT's own format
 * (PRODUCT_EXPORT_COLUMNS), so the file can be edited and uploaded again in
 * Update mode:
 *
 *   - one row per live variant; a product with sizes is several rows that
 *     share its parent_sku, each with its own seller_sku, size / color /
 *     option_value, price and stock;
 *   - a product without a stored parent_sku but with several variants gets
 *     its default variant's SKU as parent_sku — importing the file back stores
 *     it on the product (import-processing.ts), so the code stays stable;
 *   - a single item without a parent_sku stays a plain one-row product;
 *   - product details repeat on every row of a product (an import requires
 *     them to agree); MRP / price in rupees; stock = units on the shelf;
 *   - photos are not exported (they live in the catalogue, not in a ZIP), and
 *     is_active is left empty for a product Aadione disabled.
 *
 * Options: "Size" and "Color" (or "Colour") get their own columns; one more
 * option goes to option_name / option_value. A product with a fourth kind of
 * option keeps it on update anyway (import-groups.ts reads it from the
 * product), it just is not shown in the file.
 */

import { ErrorCode, PRODUCT_EXPORT_COLUMNS, isFoodSellerType, optionGroupsOf, optionValuesOf, type ProductImportColumnKey, type UnitType } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { CSV_BOM, csvLine } from './csv';
import { sameOptionName } from './row-rules';

const UNIT_TEXT: Record<UnitType, string> = { G: 'g', KG: 'kg', ML: 'ml', L: 'l', PIECE: 'piece', PACK: 'pack', DOZEN: 'dozen', BUNDLE: 'bundle' };

/** Paise -> "120" / "119.50" (what the import reads back). */
export function rupees(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export async function exportSellerProductsCsv(sellerId: string): Promise<string> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { sellerType: true } });
  if (isFoodSellerType(seller?.sellerType)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Menu items are managed on the Menu page; they have no product export.' });
  }
  const products = await prisma.product.findMany({
    where: { submittedBySellerId: sellerId, deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      name: true,
      nameHi: true,
      description: true,
      status: true,
      parentSku: true,
      optionGroups: true,
      category: { select: { name: true, parent: { select: { name: true } } } },
      brand: { select: { name: true } },
      variants: {
        where: { deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          sku: true,
          barcode: true,
          variantName: true,
          optionValues: true,
          unit: true,
          unitValue: true,
          sellerListings: { where: { sellerId }, select: { mrpPaise: true, pricePaise: true, stockQty: true } },
        },
      },
    },
  });

  let csv = CSV_BOM + csvLine(PRODUCT_EXPORT_COLUMNS);
  for (const product of products) {
    if (product.variants.length === 0) continue;
    const groups = optionGroupsOf(product.optionGroups);
    const sizeGroup = groups.find((g) => sameOptionName(g.name, 'Size'));
    const colorGroup = groups.find((g) => sameOptionName(g.name, 'Color'));
    const otherGroup = groups.find((g) => g !== sizeGroup && g !== colorGroup);
    const parentSku = product.parentSku ?? (product.variants.length > 1 || groups.length > 0 ? product.variants[0]!.sku : '');
    const category = product.category.parent ? product.category.parent.name : product.category.name;
    const subcategory = product.category.parent ? product.category.name : '';
    const isActive = product.status === 'ACTIVE' ? 'yes' : product.status === 'INACTIVE' ? 'no' : '';

    for (const variant of product.variants) {
      const values = optionValuesOf(variant.optionValues);
      const listing = variant.sellerListings[0];
      const cells: Record<ProductImportColumnKey, string | number> = {
        seller_sku: variant.sku,
        parent_sku: parentSku,
        barcode: variant.barcode ?? '',
        product_name: product.name,
        description: product.description ?? '',
        category,
        subcategory,
        brand: product.brand?.name ?? '',
        mrp: listing ? rupees(listing.mrpPaise) : '',
        selling_price: listing ? rupees(listing.pricePaise) : '',
        stock_quantity: listing ? listing.stockQty : '',
        unit: UNIT_TEXT[variant.unit],
        unit_value: Number(variant.unitValue.toFixed(3)),
        variant_name: groups.length > 0 ? '' : variant.variantName,
        size: sizeGroup ? (values[sizeGroup.name] ?? '') : '',
        color: colorGroup ? (values[colorGroup.name] ?? '') : '',
        option_name: otherGroup ? otherGroup.name : '',
        option_value: otherGroup ? (values[otherGroup.name] ?? '') : '',
        image_filename: '',
        additional_image_filenames: '',
        hindi_name: product.nameHi ?? '',
        is_active: isActive,
      };
      csv += csvLine(PRODUCT_EXPORT_COLUMNS.map((key) => cells[key]));
    }
  }
  return csv;
}
