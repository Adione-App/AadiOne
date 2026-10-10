/**
 * Bulk import — validating rows against the seller's own catalogue.
 *
 * Runs over the whole file at once (≤ 5000 rows) with a handful of batched
 * queries — never one query per row:
 *
 *   categories   the seller's OWN live tree, matched by name or slug; a file
 *                never creates a category
 *   brands       existing brands only (unknown = warning, left empty)
 *   SKUs         unique across the marketplace: an own product = CONFLICT in
 *                CREATE mode / the match in UPDATE mode; anyone else's = error
 *                (and in UPDATE mode "not found" — never "it is someone else's")
 *   barcodes     duplicates among the seller's own products
 *   in the file  the same SKU / barcode twice: the later row is a DUPLICATE
 *   images       every name must be one usable file of the uploaded ZIP
 *
 * Pure in its output: the caller stores the statuses. Re-running it (mode
 * switch, a seller decision on the preview) gives the same answer for the
 * same data.
 */

import { createHash } from 'node:crypto';
import { ApprovalStatus, ProductImportImageStatus, ProductImportRowAction, ProductImportRowStatus, ProductStatus } from '@prisma/client';
import { PRODUCT_IMPORT_LIMITS, type ProductImportIssue, type ProductImportMode } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { SheetError } from './csv';
import { cellsByKey, headerProblems, imageNameKey, mapHeader, parseRow, type ParsedRow } from './row-rules';

/** The seller's choices on the preview, kept on the row across re-validation. */
export interface RowDecisions {
  excluded?: boolean;
  /** Products: which of the row's images is the main one. */
  primaryImage?: string;
  /** Images-only: the product (by SKU) this image belongs to. */
  sku?: string;
  /** Images-only: make this image the product's main photo. */
  makePrimary?: boolean;
}

export interface ImageRef {
  fileName: string;
  status: ProductImportImageStatus;
  error: string | null;
}

/** What processing needs, beyond ParsedRow. */
export interface ResolvedRow extends ParsedRow {
  categoryId?: string;
  brandId?: string;
  /** UPDATE / images-only: the matched product and its variant. */
  productId?: string;
  variantId?: string;
  productName?: string;
  makePrimary?: boolean;
}

export interface ValidatedRow {
  rowNumber: number;
  status: ProductImportRowStatus;
  action: ProductImportRowAction;
  sku: string | null;
  parsed: ResolvedRow;
  errors: ProductImportIssue[];
  warnings: ProductImportIssue[];
  imageNames: string[];
  productId: string | null;
}

const chunk = <T>(items: T[], size = 1000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const nameKey = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Short, stable, per-seller tag for SKUs made from barcodes (BC-<barcode>-<tag>). */
export function sellerSkuTag(sellerId: string): string {
  // A plain (unkeyed) hash of the seller id: stable forever (secret rotation
  // cannot change it), carries no secret, and keeps two sellers' SKUs for the
  // same barcode apart. A collision only causes a "SKU already used" row error.
  return createHash('sha256').update(`import-sku:${sellerId}`).digest('hex').slice(0, 6).toUpperCase();
}

interface VariantHit {
  variantId: string;
  sku: string;
  barcode: string | null;
  variantDeleted: boolean;
  productId: string;
  productName: string;
  ownerSellerId: string | null;
  productDeleted: boolean;
  productStatus: ProductStatus;
  approvalStatus: ApprovalStatus;
}

const VARIANT_SELECT = {
  id: true,
  sku: true,
  barcode: true,
  deletedAt: true,
  product: { select: { id: true, name: true, submittedBySellerId: true, deletedAt: true, status: true, approvalStatus: true } },
} as const;

function toHit(v: {
  id: string;
  sku: string;
  barcode: string | null;
  deletedAt: Date | null;
  product: { id: string; name: string; submittedBySellerId: string | null; deletedAt: Date | null; status: ProductStatus; approvalStatus: ApprovalStatus };
}): VariantHit {
  return {
    variantId: v.id,
    sku: v.sku,
    barcode: v.barcode,
    variantDeleted: v.deletedAt !== null,
    productId: v.product.id,
    productName: v.product.name,
    ownerSellerId: v.product.submittedBySellerId,
    productDeleted: v.product.deletedAt !== null,
    productStatus: v.product.status,
    approvalStatus: v.product.approvalStatus,
  };
}

async function variantsBySku(skus: string[]): Promise<Map<string, VariantHit>> {
  const out = new Map<string, VariantHit>();
  for (const part of chunk([...new Set(skus)])) {
    const rows = await prisma.productVariant.findMany({ where: { sku: { in: part } }, select: VARIANT_SELECT });
    for (const v of rows) out.set(v.sku, toHit(v));
  }
  return out;
}

/** The seller's own live variants with these barcodes. */
async function ownVariantsByBarcode(sellerId: string, barcodes: string[]): Promise<Map<string, VariantHit[]>> {
  const out = new Map<string, VariantHit[]>();
  for (const part of chunk([...new Set(barcodes)])) {
    const rows = await prisma.productVariant.findMany({
      where: { barcode: { in: part }, deletedAt: null, product: { submittedBySellerId: sellerId, deletedAt: null } },
      select: VARIANT_SELECT,
    });
    for (const v of rows) out.set(v.barcode!, [...(out.get(v.barcode!) ?? []), toHit(v)]);
  }
  return out;
}

const isOwnLive = (hit: VariantHit | undefined, sellerId: string): hit is VariantHit =>
  Boolean(hit && hit.ownerSellerId === sellerId && !hit.variantDeleted && !hit.productDeleted);

/** Products of these ids: live variant count, open review, image count. */
async function productFacts(productIds: string[]) {
  const facts = new Map<string, { liveVariants: number; underReview: boolean; images: number }>();
  for (const part of chunk([...new Set(productIds)])) {
    const [variants, reviews, images] = await Promise.all([
      prisma.productVariant.groupBy({ by: ['productId'], where: { productId: { in: part }, deletedAt: null }, _count: { _all: true } }),
      prisma.productApprovalBatchItem.groupBy({ by: ['productId'], where: { productId: { in: part }, status: ApprovalStatus.PENDING }, _count: { _all: true } }),
      prisma.productImage.groupBy({ by: ['productId'], where: { productId: { in: part } }, _count: { _all: true } }),
    ]);
    for (const id of part) facts.set(id, { liveVariants: 0, underReview: false, images: 0 });
    for (const v of variants) facts.get(v.productId)!.liveVariants = v._count._all;
    for (const r of reviews) facts.get(r.productId)!.underReview = r._count._all > 0;
    for (const i of images) facts.get(i.productId)!.images = i._count._all;
  }
  return facts;
}

const UNDER_REVIEW = 'This product is under review; it can be changed again once Aadione has reviewed it.';

/* -------------------------------------------------------------------------- */
/* Product rows                                                               */
/* -------------------------------------------------------------------------- */

export interface ProductRowInput {
  rowNumber: number;
  cells: string[];
  decisions: RowDecisions;
}

export async function validateProductRows(input: {
  sellerId: string;
  mode: ProductImportMode;
  columns: string[];
  rows: ProductRowInput[];
  /** Archive images by lower-cased name; null when no ZIP was uploaded. */
  images: Map<string, ImageRef> | null;
}): Promise<{ rows: ValidatedRow[]; ignoredColumns: string[] }> {
  const { sellerId, mode } = input;
  const header = mapHeader(input.columns);
  const problems = headerProblems(header, mode);
  if (problems.length > 0) throw new SheetError(problems.join(' '));

  const skuTag = sellerSkuTag(sellerId);
  const rows = input.rows.map((row) => ({ row, ...parseRow(cellsByKey(header, row.cells), mode, skuTag) }));

  /* Categories (the seller's own tree) and brands ------------------------- */
  const categories = await prisma.category.findMany({
    where: { sellerId, deletedAt: null },
    select: { id: true, name: true, slug: true, parentId: true, isActive: true },
  });
  const tops = new Map<string, (typeof categories)[number]>();
  const children = new Map<string, Map<string, (typeof categories)[number]>>();
  for (const c of categories.filter((c) => c.parentId === null)) {
    tops.set(nameKey(c.name), c);
    tops.set(nameKey(c.slug), c);
  }
  for (const c of categories.filter((c) => c.parentId !== null)) {
    const list = children.get(c.parentId!) ?? new Map();
    list.set(nameKey(c.name), c);
    list.set(nameKey(c.slug), c);
    children.set(c.parentId!, list);
  }
  const topNames = categories.filter((c) => c.parentId === null).map((c) => c.name);

  const brandNames = [...new Set(rows.map((r) => r.parsed.brandName).filter((b): b is string => Boolean(b)).map(nameKey))];
  const brands = new Map<string, string>();
  for (const part of chunk(brandNames)) {
    const found = await prisma.$queryRaw<{ id: string; key: string }[]>`
      SELECT id::text AS id, lower(name) AS key FROM brands WHERE lower(name) = ANY(${part}) AND is_active`;
    for (const b of found) brands.set(b.key, b.id);
  }

  /* SKU / barcode lookups ------------------------------------------------- */
  const bySku = await variantsBySku(rows.map((r) => r.parsed.sku).filter((s): s is string => Boolean(s)));
  const byBarcode = await ownVariantsByBarcode(
    sellerId,
    rows.map((r) => r.parsed.barcode).filter((b): b is string => Boolean(b)),
  );

  // UPDATE mode: rows identified by barcode alone get their SKU here.
  if (mode === 'UPDATE') {
    for (const r of rows) {
      if (r.parsed.sku || !r.parsed.barcode) continue;
      const hits = byBarcode.get(r.parsed.barcode) ?? [];
      if (hits.length === 1) {
        r.parsed.sku = hits[0]!.sku;
        bySku.set(hits[0]!.sku, hits[0]!);
      } else if (hits.length > 1) {
        r.errors.push({ field: 'barcode', message: `Barcode ${r.parsed.barcode} matches ${hits.length} of your products. Add the seller_sku to say which one.` });
      } else {
        r.errors.push({ field: 'barcode', message: `None of your products has barcode ${r.parsed.barcode}.` });
      }
    }
  }

  const matched = mode === 'UPDATE' ? rows.map((r) => (r.parsed.sku ? bySku.get(r.parsed.sku) : undefined)).filter((h) => isOwnLive(h, sellerId)) : [];
  const facts = await productFacts(matched.map((h) => h!.productId));
  const listings = new Map<string, { mrpPaise: number; pricePaise: number }>();
  for (const part of chunk(matched.map((h) => h!.variantId))) {
    const found = await prisma.sellerListing.findMany({ where: { sellerId, variantId: { in: part } }, select: { variantId: true, mrpPaise: true, pricePaise: true } });
    for (const l of found) listings.set(l.variantId, l);
  }

  /* Images used by more than one row (allowed, but worth a warning) ------- */
  const imageUsers = new Map<string, number>();

  const firstSku = new Map<string, number>();
  const firstBarcode = new Map<string, number>();
  const out: ValidatedRow[] = [];

  for (const r of rows) {
    const { row, parsed, errors, warnings } = r;
    const resolved: ResolvedRow = { ...parsed };
    let status: ProductImportRowStatus | null = null;
    let productId: string | null = null;

    if (row.decisions.excluded) {
      out.push({ rowNumber: row.rowNumber, status: ProductImportRowStatus.EXCLUDED, action: ProductImportRowAction.NONE, sku: parsed.sku, parsed: resolved, errors, warnings, imageNames: parsed.imageNames, productId: null });
      continue;
    }

    // Same SKU / barcode as an earlier row of this file.
    if (parsed.sku) {
      const earlier = firstSku.get(parsed.sku);
      if (earlier !== undefined) {
        errors.push({ field: 'seller_sku', message: `Same SKU as row ${earlier}. Each product must appear once.` });
        status = ProductImportRowStatus.DUPLICATE;
      } else firstSku.set(parsed.sku, row.rowNumber);
    }
    if (parsed.barcode && status === null) {
      const earlier = firstBarcode.get(parsed.barcode);
      if (earlier !== undefined) {
        errors.push({ field: 'barcode', message: `Same barcode as row ${earlier}.` });
        status = ProductImportRowStatus.DUPLICATE;
      } else firstBarcode.set(parsed.barcode, row.rowNumber);
    }

    // Category (seller's own, live).
    if (parsed.categoryName) {
      const top = tops.get(nameKey(parsed.categoryName));
      if (!top) {
        const some = topNames.slice(0, 6).join(', ');
        errors.push({
          field: 'category',
          message: `Category "${parsed.categoryName}" does not exist or is not available to this seller.${some ? ` Your categories: ${some}${topNames.length > 6 ? ', …' : ''}.` : ' Create your categories first on the Categories page.'}`,
        });
      } else if (parsed.subcategoryName) {
        const sub = children.get(top.id)?.get(nameKey(parsed.subcategoryName));
        if (!sub) errors.push({ field: 'subcategory', message: `Subcategory "${parsed.subcategoryName}" does not exist under ${top.name}.` });
        else if (!sub.isActive || !top.isActive) errors.push({ field: 'subcategory', message: `${top.name} › ${sub.name} is switched off. Switch it on first.` });
        else resolved.categoryId = sub.id;
      } else if (!top.isActive) {
        errors.push({ field: 'category', message: `Category ${top.name} is switched off. Switch it on first.` });
      } else resolved.categoryId = top.id;
    }

    if (parsed.brandName && mode === 'UPDATE') {
      // Sellers cannot change a product's brand anywhere else (no review step covers it).
      errors.push({ field: 'brand', message: 'Brand cannot be changed by an import. Leave the brand column empty, or ask Aadione to change it.' });
    } else if (parsed.brandName) {
      const brandId = brands.get(nameKey(parsed.brandName));
      if (brandId) resolved.brandId = brandId;
      else warnings.push({ field: 'brand', message: `Brand "${parsed.brandName}" is not in Aadione's brand list; the product is saved without a brand.` });
    }

    // Existing products.
    const hit = parsed.sku ? bySku.get(parsed.sku) : undefined;
    if (mode === 'CREATE') {
      if (isOwnLive(hit, sellerId)) {
        errors.push({ field: 'seller_sku', message: `You already have a product with SKU ${hit.sku} (${hit.productName}). Choose Update mode to change it.` });
        status ??= ProductImportRowStatus.CONFLICT;
        productId = hit.productId;
      } else if (hit) {
        // Another seller's (or a removed product's): SKUs are unique across the marketplace.
        errors.push({ field: 'seller_sku', message: `SKU ${parsed.sku} is already used by another product. Use a different SKU.` });
      }
      if (parsed.barcode) {
        const own = (byBarcode.get(parsed.barcode) ?? []).find((h) => h.sku !== parsed.sku);
        if (own) {
          errors.push({ field: 'barcode', message: `You already have a product with barcode ${parsed.barcode} (SKU ${own.sku}, ${own.productName}).` });
          status ??= ProductImportRowStatus.CONFLICT;
        }
      }
    } else if (parsed.sku) {
      if (!isOwnLive(hit, sellerId)) {
        // Another seller's SKU is reported exactly like a missing one.
        if (!errors.some((e) => e.field === 'barcode')) errors.push({ field: 'seller_sku', message: `None of your products has SKU ${parsed.sku}.` });
      } else {
        const fact = facts.get(hit.productId)!;
        resolved.productId = hit.productId;
        resolved.variantId = hit.variantId;
        resolved.productName = hit.productName;
        productId = hit.productId;
        if (fact.underReview) errors.push({ field: null, message: UNDER_REVIEW });
        if (fact.liveVariants > 1) {
          errors.push({ field: 'seller_sku', message: 'This product has several variants (options). Edit it on its product page instead.' });
        }
        if (parsed.isActive !== undefined && hit.productStatus === ProductStatus.ARCHIVED) {
          errors.push({ field: 'is_active', message: 'Aadione has disabled this product, so it cannot be shown or hidden.' });
        }
        if (parsed.barcode && hit.barcode !== parsed.barcode) {
          // Barcode identifies a product here; changing it is not something sellers can do elsewhere either.
          errors.push({
            field: 'barcode',
            message: hit.barcode
              ? `Barcode cannot be changed by an import (this product has ${hit.barcode}). Leave the barcode column empty or use the current one.`
              : 'Barcode cannot be added by an import. Leave the barcode column empty, or ask Aadione to add it.',
          });
        }
        const listing = listings.get(hit.variantId);
        const mrp = parsed.mrpPaise ?? listing?.mrpPaise;
        const price = parsed.pricePaise ?? listing?.pricePaise;
        if ((parsed.mrpPaise !== undefined || parsed.pricePaise !== undefined) && mrp !== undefined && price !== undefined && price > mrp) {
          errors.push({ field: 'selling_price', message: 'Selling price cannot exceed MRP.' });
        }
        if (!listing && (parsed.mrpPaise !== undefined || parsed.pricePaise !== undefined || parsed.stockQty !== undefined)) {
          if (parsed.mrpPaise === undefined || parsed.pricePaise === undefined || parsed.stockQty === undefined) {
            errors.push({ field: null, message: 'This product has no price yet: give mrp, selling_price and stock_quantity together.' });
          }
        }
        if (fact.images + parsed.imageNames.length > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
          errors.push({ field: 'additional_image_filenames', message: `The product already has ${fact.images} photos; at most ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} are allowed.` });
        }
      }
    }

    // Images: every name must be one usable file of the ZIP.
    if (parsed.imageNames.length > 0) {
      if (!input.images) {
        errors.push({ field: 'image_filename', message: 'This row names image files, but no ZIP of images was uploaded. Upload the ZIP with the file, or clear the image columns.' });
      } else {
        for (const name of parsed.imageNames) {
          const image = input.images.get(imageNameKey(name));
          if (!image) errors.push({ field: 'image_filename', message: `Image file ${name} was not found in the uploaded archive.` });
          else if (image.status === ProductImportImageStatus.DUPLICATE_NAME) errors.push({ field: 'image_filename', message: `The ZIP has more than one file named ${name}. Rename one of them.` });
          else if (image.status === ProductImportImageStatus.INVALID) errors.push({ field: 'image_filename', message: `Image ${name} cannot be used: ${image.error ?? 'not a valid image'}.` });
          else if (image.status !== ProductImportImageStatus.READY) errors.push({ field: 'image_filename', message: `Image ${name} could not be processed. Upload the file again.` });
          else {
            const user = imageUsers.get(imageNameKey(name));
            if (user !== undefined) warnings.push({ field: 'image_filename', message: `Image ${name} is also used by row ${user}.` });
            else imageUsers.set(imageNameKey(name), row.rowNumber);
          }
        }
      }
    }
    // The seller's choice of main image.
    const primary = row.decisions.primaryImage;
    if (primary) {
      const at = parsed.imageNames.findIndex((n) => imageNameKey(n) === imageNameKey(primary));
      if (at > 0) parsed.imageNames.unshift(...parsed.imageNames.splice(at, 1));
      if (at >= 0) resolved.primaryImageGiven = true;
      resolved.imageNames = parsed.imageNames;
    }

    if (status === null) status = errors.length > 0 ? ProductImportRowStatus.INVALID : ProductImportRowStatus.READY;
    out.push({
      rowNumber: row.rowNumber,
      status,
      action: status === ProductImportRowStatus.READY ? (mode === 'CREATE' ? ProductImportRowAction.CREATE : ProductImportRowAction.UPDATE) : ProductImportRowAction.NONE,
      sku: parsed.sku,
      parsed: resolved,
      errors,
      warnings,
      imageNames: parsed.imageNames,
      productId,
    });
  }
  return { rows: out, ignoredColumns: header.ignored };
}

/* -------------------------------------------------------------------------- */
/* Images-only rows                                                           */
/* -------------------------------------------------------------------------- */

export interface ImageRowInput {
  rowNumber: number;
  fileName: string;
  decisions: RowDecisions;
}

/** "OIL-1L-front.webp" -> ["OIL-1L-front", "OIL-1L"]: the exact stem first, then without a photo suffix. */
export function identifierCandidates(fileName: string): string[] {
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, '').trim();
  const out = [stem];
  const suffix = /^(.+?)[-_ ](\d{1,2}|front|back|side|top|bottom|left|right|alt\d{0,2}|label|pack|main)$/i.exec(stem);
  if (suffix) out.push(suffix[1]!);
  return out;
}

export async function validateImageRows(input: {
  sellerId: string;
  rows: ImageRowInput[];
  images: Map<string, ImageRef>;
}): Promise<ValidatedRow[]> {
  const { sellerId } = input;
  const candidates = input.rows.flatMap((r) => (r.decisions.sku ? [r.decisions.sku] : identifierCandidates(r.fileName)));
  const bySku = await variantsBySku(candidates.map((c) => c.toUpperCase()));
  const byBarcode = await ownVariantsByBarcode(sellerId, candidates);
  const facts = await productFacts(
    [...bySku.values(), ...[...byBarcode.values()].flat()].filter((h) => isOwnLive(h, sellerId)).map((h) => h.productId),
  );
  const planned = new Map<string, number>();

  return input.rows.map((row) => {
    const errors: ProductImportIssue[] = [];
    const warnings: ProductImportIssue[] = [];
    const parsed: ResolvedRow = { sku: null, skuFromBarcode: false, imageNames: [row.fileName], makePrimary: Boolean(row.decisions.makePrimary) };
    let status: ProductImportRowStatus | null = null;

    const image = input.images.get(imageNameKey(row.fileName));
    if (!image || image.status === ProductImportImageStatus.INVALID) errors.push({ field: 'file', message: `${row.fileName} cannot be used: ${image?.error ?? 'not a valid image'}.` });
    else if (image.status === ProductImportImageStatus.PENDING) errors.push({ field: 'file', message: `${row.fileName} could not be processed. Upload it again.` });
    else if (image.status === ProductImportImageStatus.DUPLICATE_NAME) errors.push({ field: 'file', message: `More than one file is named ${row.fileName}. Rename one of them.` });

    let target: VariantHit | null = null;
    if (row.decisions.excluded) status = ProductImportRowStatus.EXCLUDED;
    // An unusable file is an error, whatever its name matches.
    else if (errors.length > 0) status = ProductImportRowStatus.INVALID;
    else if (row.decisions.sku) {
      const hit = bySku.get(row.decisions.sku.toUpperCase());
      if (isOwnLive(hit, sellerId)) target = hit;
      else errors.push({ field: 'sku', message: `None of your products has SKU ${row.decisions.sku.toUpperCase()}.` });
    } else {
      for (const candidate of identifierCandidates(row.fileName)) {
        const hits = new Map<string, VariantHit>();
        const skuHit = bySku.get(candidate.toUpperCase());
        if (isOwnLive(skuHit, sellerId)) hits.set(skuHit.productId, skuHit);
        for (const h of byBarcode.get(candidate) ?? []) hits.set(h.productId, h);
        if (hits.size === 1) {
          target = [...hits.values()][0]!;
          break;
        }
        if (hits.size > 1) {
          errors.push({ field: 'sku', message: `${row.fileName} matches more than one product (${[...hits.values()].map((h) => h.sku).join(', ')}). Choose the right SKU.` });
          status = ProductImportRowStatus.CONFLICT;
          break;
        }
      }
      if (!target && status === null) {
        errors.push({ field: 'sku', message: `No product of yours has the SKU or barcode "${identifierCandidates(row.fileName)[0]}". Enter the SKU this image belongs to.` });
        status = ProductImportRowStatus.CONFLICT;
      }
    }

    if (target) {
      const fact = facts.get(target.productId) ?? { liveVariants: 1, underReview: false, images: 0 };
      Object.assign(parsed, { sku: target.sku, productId: target.productId, variantId: target.variantId, productName: target.productName });
      if (fact.underReview) errors.push({ field: null, message: UNDER_REVIEW });
      if (status === null && errors.length === 0) {
        const count = (planned.get(target.productId) ?? fact.images) + 1;
        if (count > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
          errors.push({ field: null, message: `${target.sku} would have more than ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} photos. Remove some on the product page first.` });
        } else planned.set(target.productId, count);
      }
    }

    if (status === null) status = errors.length > 0 ? ProductImportRowStatus.INVALID : ProductImportRowStatus.READY;
    return {
      rowNumber: row.rowNumber,
      status,
      action: status === ProductImportRowStatus.READY ? ProductImportRowAction.ATTACH_IMAGES : ProductImportRowAction.NONE,
      sku: parsed.sku,
      parsed,
      errors,
      warnings,
      imageNames: [row.fileName],
      productId: parsed.productId ?? null,
    };
  });
}
