/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Bulk product import / export — the file format both sides agree on.
 *
 * The backend parses and validates against these columns; the Seller Panel
 * shows the same list on the Bulk Import page and builds the template from
 * it. Prices are in RUPEES in the file (up to 2 decimals) and stored in
 * paise, like everywhere else.
 *
 * One row = one sellable variant:
 *
 *   - a row WITHOUT parent_sku is one product with one variant (the same
 *     shape as the single "Add Product" form);
 *   - rows that share a parent_sku are ONE product with several variants
 *     (sizes, colours, …): each row has its own seller_sku, size / color /
 *     option_value, price and stock; product details (name, category, brand,
 *     …) may be repeated on every row (they must then agree) or given once,
 *     and an empty price or unit cell takes the value of the product's other
 *     rows. A product is imported only when ALL of its rows are valid.
 *
 * The export (one row per variant, same columns) can be uploaded again in
 * Update mode: rows are matched by seller_sku, products by parent_sku, so a
 * re-import changes the existing products instead of creating copies.
 */

export type ProductImportColumnKey =
  | 'seller_sku'
  | 'parent_sku'
  | 'barcode'
  | 'product_name'
  | 'description'
  | 'category'
  | 'subcategory'
  | 'brand'
  | 'mrp'
  | 'selling_price'
  | 'stock_quantity'
  | 'unit'
  | 'unit_value'
  | 'variant_name'
  | 'size'
  | 'color'
  | 'option_name'
  | 'option_value'
  | 'image_filename'
  | 'additional_image_filenames'
  | 'hindi_name'
  | 'is_active';

export interface ProductImportColumn {
  key: ProductImportColumnKey;
  /** Required when creating new products. */
  requiredForCreate: boolean;
  /** Short help shown next to the column on the Bulk Import page. */
  help: string;
  /** Other header spellings accepted for this column (compared case/space-insensitively). */
  aliases: readonly string[];
}

export const PRODUCT_IMPORT_COLUMNS: readonly ProductImportColumn[] = [
  {
    key: 'seller_sku',
    requiredForCreate: true,
    help: 'Your own code for this item — for a product with sizes, the code of THIS size (2–60 letters, digits, - _ . /). It identifies the item in later imports and image uploads. If empty, the barcode is used instead.',
    aliases: ['sku', 'seller sku', 'item code', 'product code', 'variant sku', 'variant_sku'],
  },
  {
    key: 'parent_sku',
    requiredForCreate: false,
    help: 'Only for products with sizes / colours: one code for the whole product, the same on each of its rows (e.g. TSHIRT-BLUE on the S, M and L rows). Rows with the same parent_sku become one product. Leave empty for a single item.',
    aliases: ['parent sku', 'parent code', 'parent', 'style code', 'group sku'],
  },
  {
    key: 'barcode',
    requiredForCreate: false,
    help: 'EAN / UPC printed on the pack (optional). Format the column as Text in Excel so long numbers are not shortened.',
    aliases: ['ean', 'upc', 'gtin', 'bar code'],
  },
  { key: 'product_name', requiredForCreate: true, help: 'Name customers see (2–200 characters).', aliases: ['name', 'product', 'title', 'item name'] },
  { key: 'description', requiredForCreate: false, help: 'Optional, up to 4000 characters.', aliases: ['details'] },
  {
    key: 'category',
    requiredForCreate: true,
    help: 'One of YOUR top categories, exactly as named on the Categories page. New categories are never created from a file.',
    aliases: ['top category', 'category name'],
  },
  {
    key: 'subcategory',
    requiredForCreate: false,
    help: 'Optional: one of your subcategories inside that category.',
    aliases: ['sub category', 'sub-category'],
  },
  {
    key: 'brand',
    requiredForCreate: false,
    help: 'Optional: matched to brands Aadione already has (capitals and extra spaces do not matter). A new brand is created when you confirm the import.',
    aliases: ['brand name', 'company'],
  },
  { key: 'mrp', requiredForCreate: true, help: 'MRP in rupees, e.g. 120 or 119.50 (no ₹ sign or commas).', aliases: ['mrp (rs)', 'mrp rs', 'max retail price'] },
  {
    key: 'selling_price',
    requiredForCreate: true,
    help: 'Your selling price in rupees; cannot be more than the MRP.',
    aliases: ['price', 'sale price', 'selling price (rs)', 'sp'],
  },
  {
    key: 'stock_quantity',
    requiredForCreate: true,
    help: 'Whole number, 0–100000. Never left blank on purpose: an empty cell is an error, not zero.',
    aliases: ['stock', 'qty', 'quantity', 'opening stock'],
  },
  {
    key: 'unit',
    requiredForCreate: true,
    help: 'g, kg, ml, l, piece, pack, dozen or bundle.',
    aliases: ['uom', 'unit type'],
  },
  { key: 'unit_value', requiredForCreate: true, help: 'Pack size in that unit, e.g. 250 for 250 ml.', aliases: ['pack size', 'size', 'net quantity'] },
  {
    key: 'variant_name',
    requiredForCreate: false,
    help: 'Label like "250 ml" or "Pack of 6". Empty = built from unit value and unit.',
    aliases: ['variant', 'pack label'],
  },
  {
    key: 'size',
    requiredForCreate: false,
    help: 'The size of this row\'s item, e.g. S, M, L, 32 or 8 UK (with a parent_sku). Every row of the product then needs a size.',
    aliases: ['size name', 'variant size'],
  },
  {
    key: 'color',
    requiredForCreate: false,
    help: 'Optional colour of this row\'s item, e.g. Blue (with a parent_sku). If one row of the product has a colour, every row needs one.',
    aliases: ['colour', 'color name', 'colour name'],
  },
  {
    key: 'option_name',
    requiredForCreate: false,
    help: 'Optional other option, by name — e.g. Material or Pack — with its value in option_value. The same name on every row of the product.',
    aliases: ['option', 'other option'],
  },
  {
    key: 'option_value',
    requiredForCreate: false,
    help: 'The value of option_name for this row, e.g. Cotton.',
    aliases: ['other option value'],
  },
  {
    key: 'image_filename',
    requiredForCreate: false,
    help: 'Main photo: a file name inside the ZIP you upload with this file, e.g. RB-250.jpg.',
    aliases: ['image', 'main image', 'primary image', 'image file'],
  },
  {
    key: 'additional_image_filenames',
    requiredForCreate: false,
    help: 'More photos from the same ZIP, separated by | (up to 8 photos per product in total).',
    aliases: ['additional images', 'more images', 'gallery images', 'other images'],
  },
  { key: 'hindi_name', requiredForCreate: false, help: 'Optional Hindi name (save the file as CSV UTF-8).', aliases: ['name hindi', 'name_hi', 'hindi'] },
  {
    key: 'is_active',
    requiredForCreate: false,
    help: 'yes / no. "no" saves the product hidden. Empty = yes.',
    aliases: ['active', 'visible', 'status'],
  },
];

/**
 * Columns of the product export (GET /seller/imports/export.csv), in order:
 * every import column except the image file names (photos live in the
 * catalogue, not in a ZIP). One row per live variant.
 */
export const PRODUCT_EXPORT_COLUMNS: readonly ProductImportColumnKey[] = PRODUCT_IMPORT_COLUMNS.map((c) => c.key).filter(
  (key) => key !== 'image_filename' && key !== 'additional_image_filenames',
);

/** Option-group names the size / color columns stand for (an existing "Colour" group matches "Color"). */
export const IMPORT_OPTION_GROUPS = { size: 'Size', color: 'Color' } as const;

export const PRODUCT_IMPORT_LIMITS = {
  /** Data rows per file (split larger catalogues into several files). */
  maxRows: 5000,
  /** The CSV / Excel file itself. */
  maxSheetBytes: 10 * 1024 * 1024,
  /** The image ZIP. */
  maxArchiveBytes: 200 * 1024 * 1024,
  /** Files inside the ZIP. */
  maxArchiveEntries: 5000,
  /** One image (same as single uploads). */
  maxImageBytes: 5 * 1024 * 1024,
  /** Loose image files in one images-only upload (larger sets: use a ZIP). */
  maxLooseImages: 50,
  /** Photos per product (same as the product page). */
  maxImagesPerProduct: 8,
} as const;

/** Units the file may use, mapped to the catalogue's UnitType. */
export const PRODUCT_IMPORT_UNIT_ALIASES: Readonly<Record<string, 'G' | 'KG' | 'ML' | 'L' | 'PIECE' | 'PACK' | 'DOZEN' | 'BUNDLE'>> = {
  g: 'G',
  gm: 'G',
  gms: 'G',
  gram: 'G',
  grams: 'G',
  kg: 'KG',
  kgs: 'KG',
  kilogram: 'KG',
  ml: 'ML',
  millilitre: 'ML',
  milliliter: 'ML',
  l: 'L',
  ltr: 'L',
  litre: 'L',
  liter: 'L',
  piece: 'PIECE',
  pieces: 'PIECE',
  pc: 'PIECE',
  pcs: 'PIECE',
  nos: 'PIECE',
  pack: 'PACK',
  packs: 'PACK',
  pkt: 'PACK',
  packet: 'PACK',
  dozen: 'DOZEN',
  dz: 'DOZEN',
  bundle: 'BUNDLE',
};

export type ProductImportKind = 'PRODUCTS' | 'IMAGES';
export type ProductImportMode = 'CREATE' | 'UPDATE';
export type ProductImportStatus = 'ANALYZING' | 'READY' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type ProductImportRowStatus = 'READY' | 'INVALID' | 'DUPLICATE' | 'CONFLICT' | 'EXCLUDED' | 'DONE' | 'FAILED';
export type ProductImportRowAction = 'NONE' | 'CREATE' | 'UPDATE' | 'ATTACH_IMAGES';
export type ProductImportImageStatus = 'PENDING' | 'READY' | 'INVALID' | 'DUPLICATE_NAME' | 'UNUSED';

export interface ProductImportIssue {
  /** Column key, or null for a row-level problem. */
  field: string | null;
  message: string;
}

/** One import job (history row, progress and summary). */
export interface ProductImportDto {
  id: string;
  kind: ProductImportKind;
  mode: ProductImportMode;
  status: ProductImportStatus;
  fileName: string | null;
  archiveName: string | null;
  columns: string[];
  ignoredColumns: string[];
  totalRows: number;
  readyRows: number;
  invalidRows: number;
  duplicateRows: number;
  conflictRows: number;
  /** Ready rows that carry warnings (worth a look before importing). */
  warningRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
  skippedCount: number;
  imageCount: number;
  analyzedImages: number;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** Single-import reads only: rows that failed to SAVE and can be retried (validation errors cannot). */
  retryableRows?: number;
}

export interface ProductImportRowImageDto {
  fileName: string;
  status: ProductImportImageStatus | 'MISSING';
  thumbUrl: string | null;
  error: string | null;
}

export interface ProductImportRowDto {
  id: string;
  rowNumber: number;
  status: ProductImportRowStatus;
  action: ProductImportRowAction;
  sku: string | null;
  /** Product name from the file (or the matched product's, for images-only). */
  name: string | null;
  /** The product this row belongs to when it shares a parent_sku with other rows (one product, several variants). */
  parentSku: string | null;
  /** This row's variant label from its options, e.g. "M" or "M / Blue"; null for a single item. */
  variantLabel: string | null;
  values: Record<string, string>;
  errors: ProductImportIssue[];
  warnings: ProductImportIssue[];
  /** How the brand column resolved: an existing brand (its catalogue name) or one created on import. */
  brand: { status: 'MATCHED' | 'NEW'; name: string } | null;
  images: ProductImportRowImageDto[];
  productId: string | null;
  /** Images-only rows: this image becomes the product's main photo. */
  makePrimary: boolean;
}

export interface ProductImportRowPageDto {
  items: ProductImportRowDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductImportImageDto {
  id: string;
  fileName: string;
  status: ProductImportImageStatus;
  error: string | null;
  thumbUrl: string | null;
}

export interface ProductImportPageDto {
  items: ProductImportDto[];
  total: number;
  page: number;
  pageSize: number;
}
