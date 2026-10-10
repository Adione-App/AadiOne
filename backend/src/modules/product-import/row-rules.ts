/**
 * Bulk import — what one spreadsheet row means. Pure functions only (no
 * database): header mapping, cell parsing and field-level validation, with
 * the same limits as the single "Add Product" form (seller-catalog.routes.ts
 * createProductSchema). Everything that needs the database — categories,
 * SKU / barcode conflicts, images — is checked in import-validation.ts.
 *
 * Empty cells are "not given", never zero: in CREATE mode a missing required
 * value is an error; in UPDATE mode it leaves the product's value unchanged.
 */

import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_LIMITS,
  PRODUCT_IMPORT_UNIT_ALIASES,
  type ProductImportColumnKey,
  type ProductImportIssue,
  type ProductImportMode,
} from '../../shared';

export type ImportUnit = (typeof PRODUCT_IMPORT_UNIT_ALIASES)[string];

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

const norm = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]+/g, '');

const HEADER_LOOKUP = new Map<string, ProductImportColumnKey>();
for (const column of PRODUCT_IMPORT_COLUMNS) {
  HEADER_LOOKUP.set(norm(column.key), column.key);
  for (const alias of column.aliases) HEADER_LOOKUP.set(norm(alias), column.key);
}

export interface HeaderMap {
  /** Column key -> index in the row. */
  index: Map<ProductImportColumnKey, number>;
  /** Header cells that matched no column (kept in the report, otherwise ignored). */
  ignored: string[];
  /** Two header cells mapping to the same column. */
  duplicated: string[];
}

export function mapHeader(headers: readonly string[]): HeaderMap {
  const index = new Map<ProductImportColumnKey, number>();
  const ignored: string[] = [];
  const duplicated: string[] = [];
  headers.forEach((header, i) => {
    const key = HEADER_LOOKUP.get(norm(header));
    if (!key) {
      if (header.trim()) ignored.push(header.trim());
      return;
    }
    if (index.has(key)) duplicated.push(header.trim());
    else index.set(key, i);
  });
  return { index, ignored, duplicated };
}

/** File-level problems: a file with these can produce no valid row at all. */
export function headerProblems(map: HeaderMap, mode: ProductImportMode): string[] {
  const problems: string[] = [];
  if (map.duplicated.length > 0) problems.push(`These columns appear twice: ${map.duplicated.join(', ')}.`);
  if (!map.index.has('seller_sku') && !map.index.has('barcode')) problems.push('Add a seller_sku column (or a barcode column) so every product can be identified.');
  if (mode === 'CREATE') {
    const missing = PRODUCT_IMPORT_COLUMNS.filter((c) => c.requiredForCreate && c.key !== 'seller_sku' && !map.index.has(c.key)).map((c) => c.key);
    if (missing.length > 0) problems.push(`Required columns are missing: ${missing.join(', ')}. Download the template to see the expected columns.`);
  }
  return problems;
}

/** The row's cells by column key (trimmed; absent column = ''). */
export function cellsByKey(map: HeaderMap, cells: readonly string[]): Partial<Record<ProductImportColumnKey, string>> {
  const out: Partial<Record<ProductImportColumnKey, string>> = {};
  for (const [key, i] of map.index) out[key] = (cells[i] ?? '').trim();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

type Parse<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Rupees with up to 2 decimals -> paise. Never guesses: "1,200", "₹120", "12.345" are errors. */
export function parseRupees(raw: string, label: string): Parse<number> {
  const text = raw.trim();
  if (/^[₹]|^rs\.?\s*/i.test(text)) return fail(`${label}: write the amount without ₹ or Rs (e.g. 120 or 119.50).`);
  if (text.includes(',')) return fail(`${label}: write the amount without commas (e.g. 1200).`);
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    if (/^\d+\.\d{3,}$/.test(text)) return fail(`${label}: use at most 2 decimal places (paise).`);
    if (/^-/.test(text)) return fail(`${label} cannot be negative.`);
    return fail(`${label} must be a number in rupees, e.g. 120 or 119.50.`);
  }
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (paise <= 0) return fail(`${label} must be more than 0.`);
  return { ok: true, value: paise };
}

export function parseStock(raw: string): Parse<number> {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    if (/^-/.test(text)) return fail('Stock quantity cannot be negative.');
    return fail('Stock quantity must be a whole number (e.g. 25).');
  }
  const value = Number(text);
  if (value > 100_000) return fail('Stock quantity cannot be more than 100000.');
  return { ok: true, value };
}

export function parseUnit(raw: string): Parse<ImportUnit> {
  const unit = PRODUCT_IMPORT_UNIT_ALIASES[raw.trim().toLowerCase()];
  return unit ? { ok: true, value: unit } : fail(`Unit "${raw.trim()}" is not supported. Use g, kg, ml, l, piece, pack, dozen or bundle.`);
}

export function parseUnitValue(raw: string): Parse<number> {
  const text = raw.trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(text)) return fail('Unit value must be a number like 250 or 1.5.');
  const value = Number(text);
  if (value <= 0) return fail('Unit value must be more than 0.');
  return { ok: true, value };
}

export function parseBoolean(raw: string): Parse<boolean> {
  const text = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'active', 'on'].includes(text)) return { ok: true, value: true };
  if (['no', 'n', 'false', '0', 'inactive', 'off', 'hidden'].includes(text)) return { ok: true, value: false };
  return fail(`is_active must be yes or no (got "${raw.trim()}").`);
}

const SCIENTIFIC = /^\d+(\.\d+)?e\+?\d+$/i;

export function normaliseSku(raw: string): Parse<string> {
  const text = raw.trim().toUpperCase();
  if (SCIENTIFIC.test(text)) return fail('SKU looks like an Excel number in scientific format (e.g. 8.9E+12). Format the column as Text and type it again.');
  if (text.length < 2 || text.length > 60) return fail('SKU must be 2–60 characters.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._/#-]*$/u.test(text)) return fail('SKU may use letters, digits, spaces and - _ . / # only.');
  return { ok: true, value: text };
}

/** GS1 check digit for EAN-8 / UPC-A / EAN-13 / GTIN-14. */
export function hasValidGtinCheckDigit(code: string): boolean {
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function parseBarcode(raw: string): Parse<{ code: string; warning: string | null }> {
  const text = raw.trim();
  if (SCIENTIFIC.test(text)) return fail('Barcode looks like an Excel number in scientific format (e.g. 8.9E+12). Format the column as Text and type it again.');
  if (!/^[0-9A-Za-z-]{4,60}$/.test(text)) return fail('Barcode may use only digits, letters and - (4–60 characters).');
  let warning: string | null = null;
  if (/^\d+$/.test(text) && [8, 12, 13, 14].includes(text.length) && !hasValidGtinCheckDigit(text)) {
    warning = 'Barcode check digit does not match. Please double-check the number.';
  }
  return { ok: true, value: { code: text, warning } };
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;

/** "a.jpg | b.png" -> ["a.jpg", "b.png"]; names only, no folders. */
export function parseImageNames(raw: string): Parse<string[]> {
  const names = raw
    .split(/[|;,\n]/)
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) {
    if (/[\\/]/.test(name)) return fail(`Image "${name}": use the file name only, without folders.`);
    if (!IMAGE_EXTENSIONS.test(name)) return fail(`Image "${name}" is not a JPG, PNG, WebP or AVIF file name.`);
    if (name.length > 200) return fail(`Image "${name.slice(0, 40)}…" has a file name that is too long.`);
  }
  return { ok: true, value: names };
}

export const imageNameKey = (name: string): string => name.trim().toLowerCase();

const UNIT_LABEL: Record<ImportUnit, string> = { G: 'g', KG: 'kg', ML: 'ml', L: 'L', PIECE: 'pc', PACK: 'pack', DOZEN: 'dozen', BUNDLE: 'bundle' };

/** "250 ml", "1 kg", "6 pc" — the variant label when the file gives none. */
export function defaultVariantName(unitValue: number, unit: ImportUnit): string {
  return `${Number(unitValue.toFixed(3))} ${UNIT_LABEL[unit]}`;
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A row's values after parsing. In UPDATE mode an `undefined` field means
 * "leave as it is"; in CREATE mode every required field is set.
 */
export interface ParsedRow {
  sku: string | null;
  /** True when the SKU was taken from the barcode (no seller_sku given). */
  skuFromBarcode: boolean;
  barcode?: string;
  name?: string;
  nameHi?: string;
  description?: string;
  categoryName?: string;
  subcategoryName?: string;
  brandName?: string;
  mrpPaise?: number;
  pricePaise?: number;
  stockQty?: number;
  unit?: ImportUnit;
  unitValue?: number;
  variantName?: string;
  isActive?: boolean;
  /** Primary first. */
  imageNames: string[];
  /** image_filename was given: imageNames[0] is meant to be the main photo. */
  primaryImageGiven?: boolean;
}

export interface RowParseResult {
  parsed: ParsedRow;
  errors: ProductImportIssue[];
  warnings: ProductImportIssue[];
}

/**
 * Field-level parsing and validation of one row. `skuTag` makes a SKU taken
 * from a barcode unique to this seller (SKUs are unique across sellers, and
 * two shops may well stock the same barcode).
 */
export function parseRow(cells: Partial<Record<ProductImportColumnKey, string>>, mode: ProductImportMode, skuTag: string): RowParseResult {
  const errors: ProductImportIssue[] = [];
  const warnings: ProductImportIssue[] = [];
  const parsed: ParsedRow = { sku: null, skuFromBarcode: false, imageNames: [] };
  const create = mode === 'CREATE';
  const value = (key: ProductImportColumnKey) => cells[key] ?? '';
  const required = (key: ProductImportColumnKey, label: string) => {
    if (create && !value(key)) errors.push({ field: key, message: `${label} is required.` });
    return value(key);
  };

  if (value('barcode')) {
    const barcode = parseBarcode(value('barcode'));
    if (barcode.ok) {
      parsed.barcode = barcode.value.code;
      if (barcode.value.warning) warnings.push({ field: 'barcode', message: barcode.value.warning });
    } else errors.push({ field: 'barcode', message: barcode.message });
  }

  if (value('seller_sku')) {
    const sku = normaliseSku(value('seller_sku'));
    if (sku.ok) parsed.sku = sku.value;
    else errors.push({ field: 'seller_sku', message: sku.message });
  } else if (parsed.barcode) {
    if (create) {
      const sku = `BC-${parsed.barcode.toUpperCase()}-${skuTag}`;
      if (sku.length > 60) {
        errors.push({ field: 'seller_sku', message: 'This barcode is too long to make a SKU from. Enter a seller_sku for this product.' });
      } else {
        parsed.sku = sku;
        parsed.skuFromBarcode = true;
        warnings.push({ field: 'seller_sku', message: `No seller_sku given: the SKU ${parsed.sku} was made from the barcode.` });
      }
    }
    // UPDATE: matched by barcode (import-validation.ts).
  } else if (!errors.some((e) => e.field === 'barcode')) {
    errors.push({ field: 'seller_sku', message: 'Enter a seller_sku (or a barcode) so this product can be identified.' });
  }

  const name = required('product_name', 'Product name');
  if (name) {
    if (name.length < 2 || name.length > 200) errors.push({ field: 'product_name', message: 'Product name must be 2–200 characters.' });
    else parsed.name = name;
  }
  if (value('hindi_name')) {
    if (value('hindi_name').length > 200) errors.push({ field: 'hindi_name', message: 'Hindi name can be at most 200 characters.' });
    else parsed.nameHi = value('hindi_name');
  }
  if (value('description')) {
    if (value('description').length > 4000) errors.push({ field: 'description', message: 'Description can be at most 4000 characters.' });
    else parsed.description = value('description');
  }

  const category = required('category', 'Category');
  if (category) parsed.categoryName = category;
  if (value('subcategory')) {
    if (!category) errors.push({ field: 'category', message: 'Give the category the subcategory belongs to.' });
    parsed.subcategoryName = value('subcategory');
  }
  if (value('brand')) parsed.brandName = value('brand');

  const mrp = required('mrp', 'MRP');
  if (mrp) {
    const r = parseRupees(mrp, 'MRP');
    if (r.ok) parsed.mrpPaise = r.value;
    else errors.push({ field: 'mrp', message: r.message });
  }
  const price = required('selling_price', 'Selling price');
  if (price) {
    const r = parseRupees(price, 'Selling price');
    if (r.ok) parsed.pricePaise = r.value;
    else errors.push({ field: 'selling_price', message: r.message });
  }
  if (parsed.mrpPaise !== undefined && parsed.pricePaise !== undefined && parsed.pricePaise > parsed.mrpPaise) {
    errors.push({ field: 'selling_price', message: 'Selling price cannot exceed MRP.' });
  }

  const stock = required('stock_quantity', 'Stock quantity');
  if (stock) {
    const r = parseStock(stock);
    if (r.ok) parsed.stockQty = r.value;
    else errors.push({ field: 'stock_quantity', message: r.message });
  }

  const unit = required('unit', 'Unit');
  if (unit) {
    const r = parseUnit(unit);
    if (r.ok) parsed.unit = r.value;
    else errors.push({ field: 'unit', message: r.message });
  }
  const unitValue = required('unit_value', 'Unit value');
  if (unitValue) {
    const r = parseUnitValue(unitValue);
    if (r.ok) parsed.unitValue = r.value;
    else errors.push({ field: 'unit_value', message: r.message });
  }
  if (value('variant_name')) {
    if (value('variant_name').length > 80) errors.push({ field: 'variant_name', message: 'Variant name can be at most 80 characters.' });
    else parsed.variantName = value('variant_name');
  } else if (create && parsed.unit && parsed.unitValue !== undefined) {
    parsed.variantName = defaultVariantName(parsed.unitValue, parsed.unit);
  }

  if (value('is_active')) {
    const r = parseBoolean(value('is_active'));
    if (r.ok) parsed.isActive = r.value;
    else errors.push({ field: 'is_active', message: r.message });
  }

  const images: string[] = [];
  for (const key of ['image_filename', 'additional_image_filenames'] as const) {
    if (!value(key)) continue;
    const r = parseImageNames(value(key));
    if (!r.ok) {
      errors.push({ field: key, message: r.message });
      continue;
    }
    if (key === 'image_filename' && r.value.length > 1) {
      errors.push({ field: key, message: 'Put one file in image_filename; list the others in additional_image_filenames.' });
      continue;
    }
    if (key === 'image_filename' && r.value.length === 1) parsed.primaryImageGiven = true;
    images.push(...r.value);
  }
  const seen = new Set<string>();
  for (const image of images) {
    if (seen.has(imageNameKey(image))) {
      warnings.push({ field: 'additional_image_filenames', message: `Image ${image} is listed twice; it is used once.` });
      continue;
    }
    seen.add(imageNameKey(image));
    parsed.imageNames.push(image);
  }
  if (parsed.imageNames.length > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
    errors.push({ field: 'additional_image_filenames', message: `A product can have at most ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} images.` });
  }

  if (!create && errors.length === 0) {
    const changes = (Object.keys(parsed) as (keyof ParsedRow)[]).filter(
      (k) => !['sku', 'skuFromBarcode', 'barcode', 'imageNames'].includes(k) && parsed[k] !== undefined,
    );
    if (changes.length === 0 && parsed.imageNames.length === 0 && !(parsed.barcode && parsed.sku)) {
      errors.push({ field: null, message: 'Nothing to change in this row: fill in at least one value to update.' });
    }
  }
  return { parsed, errors, warnings };
}
