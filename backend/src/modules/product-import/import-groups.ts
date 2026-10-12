/**
 * Bulk import — rows that belong to ONE product (a shared parent_sku, or, in
 * Update mode, the sizes of a product that already has several).
 *
 * A product with sizes is several rows: each its own seller_sku, option values
 * (size / color / option_value), price and stock; the product details are
 * shared. This module checks a product's rows TOGETHER, on top of the
 * per-row checks in import-validation.ts:
 *
 *   before parsing   product details must agree across the rows (an empty cell
 *                    takes the product's value); in Create mode an empty price
 *                    or unit cell takes the value of the product's other rows
 *   Create           every row names the same options, no combination twice,
 *                    the parent_sku is not one of the seller's live products yet
 *   Update           the rows are sizes of exactly ONE of the seller's products
 *                    (found by parent_sku or by their SKUs); new seller_skus are
 *                    new sizes (an empty price / unit takes the product's first
 *                    size's), and the product's whole size set must stay valid
 *   all-or-nothing   one invalid row stops every row of its product, so a
 *                    product is never imported with only some of its sizes
 *
 * Variant rules are the product page's own (product-variant.service.ts): at
 * most MAX_OPTION_GROUPS options, MAX_OPTION_VALUES values each, MAX_VARIANTS
 * variants, and a variant is named from its values ("M / Blue").
 */

import { ApprovalStatus, ProductImportRowAction, ProductImportRowStatus, ProductStatus } from '@prisma/client';
import { optionGroupsOf, optionValuesOf, type ProductImportColumnKey, type ProductImportIssue, type ProductImportMode, type ProductOptionGroupDto } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { MAX_OPTION_GROUPS, MAX_OPTION_VALUES, MAX_VARIANTS, variantNameOf } from '../catalog/product-variant.service';
import { PRODUCT_IMPORT_LIMITS } from '../../shared';
import { imageNameKey, normaliseSku, sameOptionName } from './row-rules';
import type { ResolvedRow, ValidatedRow } from './import-validation';

/* -------------------------------------------------------------------------- */
/* Before parsing: shared product details                                      */
/* -------------------------------------------------------------------------- */

/** Product-level columns: one value per product. */
const PRODUCT_COLUMNS: { key: ProductImportColumnKey; label: string }[] = [
  { key: 'product_name', label: 'product name' },
  { key: 'hindi_name', label: 'Hindi name' },
  { key: 'description', label: 'description' },
  { key: 'category', label: 'category' },
  { key: 'subcategory', label: 'subcategory' },
  { key: 'brand', label: 'brand' },
  { key: 'is_active', label: 'is_active' },
];

/** Create mode: an empty cell of these takes the value of the product's first row that has one. */
const INHERITED_IN_CREATE: ProductImportColumnKey[] = ['mrp', 'selling_price', 'unit', 'unit_value'];

const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** The parent_sku cell as a key (upper-cased), or null when absent / malformed (parseRow reports that). */
export function parentKeyOf(cells: Partial<Record<ProductImportColumnKey, string>>): string | null {
  const raw = cells.parent_sku ?? '';
  if (!raw) return null;
  const parsed = normaliseSku(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Fills a product's shared cells across its rows (in place) and reports rows
 * that contradict them. Runs before parseRow, so a detail given once on the
 * product's first row satisfies the "required" checks of every row.
 */
export function shareProductCells(
  rows: { rowNumber: number; excluded: boolean; cells: Partial<Record<ProductImportColumnKey, string>> }[],
  mode: ProductImportMode,
): Map<number, ProductImportIssue[]> {
  const issues = new Map<number, ProductImportIssue[]>();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.excluded ? null : parentKeyOf(row.cells);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    for (const column of PRODUCT_COLUMNS) {
      const first = members.find((m) => m.cells[column.key]);
      if (!first) continue;
      const value = first.cells[column.key]!;
      for (const member of members) {
        const own = member.cells[column.key];
        if (!own) member.cells[column.key] = value;
        else if (!same(own, value)) {
          issues.set(member.rowNumber, [
            ...(issues.get(member.rowNumber) ?? []),
            {
              field: column.key,
              message: `Different ${column.label} from row ${first.rowNumber} of the same product (parent_sku ${key}). The rows of one product must agree — or leave it empty on all but one row.`,
            },
          ]);
        }
      }
    }
    if (mode === 'CREATE') {
      for (const columnKey of INHERITED_IN_CREATE) {
        const first = members.find((m) => m.cells[columnKey]);
        if (!first) continue;
        for (const member of members) if (!member.cells[columnKey]) member.cells[columnKey] = first.cells[columnKey]!;
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** One row taking part in a product group, with what the per-row pass found. */
export interface GroupRow {
  v: ValidatedRow;
  /** The seller's own live variant with this row's SKU (Update mode), if any. */
  ownVariant: { variantId: string; productId: string } | null;
  /** The SKU belongs to someone else's product or a removed one. */
  skuTakenElsewhere: boolean;
}

const OPTION_FIELD: Record<string, ProductImportColumnKey> = { Size: 'size', Color: 'color' };
const optionField = (name: string): ProductImportColumnKey => {
  for (const [group, field] of Object.entries(OPTION_FIELD)) if (sameOptionName(group, name)) return field;
  return 'option_value';
};

/** The option names of a set of value maps, first spelling wins ("Colour" and "Color" are one). */
function optionNames(lists: Record<string, string>[], start: string[] = []): string[] {
  const names = [...start];
  for (const values of lists) {
    for (const name of Object.keys(values)) if (!names.some((n) => sameOptionName(n, name))) names.push(name);
  }
  return names;
}

/** `values` re-keyed to the group spellings in `names`; missing names left out. */
function canonical(values: Record<string, string> | undefined, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const hit = Object.entries(values ?? {}).find(([key]) => sameOptionName(key, name));
    if (hit && hit[1].trim()) out[name] = hit[1].trim();
  }
  return out;
}

/** Option groups (with their values, in first-seen order) of a final variant set. */
export function groupsOf(names: string[], variants: Record<string, string>[], existing: ProductOptionGroupDto[] = []): ProductOptionGroupDto[] {
  return names.map((name) => {
    const values: string[] = [];
    const add = (value: string | undefined) => {
      if (value && !values.some((v) => v.toLowerCase() === value.toLowerCase())) values.push(value);
    };
    for (const group of existing) if (sameOptionName(group.name, name)) group.values.forEach(add);
    for (const variant of variants) add(variant[name]);
    return { name, values };
  });
}

function fail(row: GroupRow, issue: ProductImportIssue, status: ProductImportRowStatus = ProductImportRowStatus.INVALID): void {
  row.v.errors.push(issue);
  if (row.v.status === ProductImportRowStatus.READY) {
    row.v.status = status;
    row.v.action = ProductImportRowAction.NONE;
  }
}

/** The set rule shared by both modes: limits, every option named, no combination twice. */
function checkVariantSet(
  members: { row: GroupRow | null; sku: string; values: Record<string, string> }[],
  names: string[],
  report: (target: GroupRow | null, issue: ProductImportIssue) => void,
): void {
  if (names.length > MAX_OPTION_GROUPS) {
    report(members.find((m) => m.row)?.row ?? null, { field: 'option_name', message: `A product can have at most ${MAX_OPTION_GROUPS} options (e.g. size and color).` });
  }
  if (members.length > MAX_VARIANTS) {
    report(members.find((m) => m.row)?.row ?? null, { field: 'parent_sku', message: `A product can have at most ${MAX_VARIANTS} sizes / variants.` });
  }
  const seen = new Map<string, string>();
  for (const member of members) {
    const missing = names.filter((name) => !member.values[name]);
    if (missing.length > 0) {
      report(member.row, {
        field: optionField(missing[0]!),
        message: member.row
          ? `This item has no ${missing.join(' / ').toLowerCase()}; every item of this product needs one.`
          : `Your item ${member.sku} has no ${missing.join(' / ').toLowerCase()} yet. Add a row for it with its ${missing.join(' / ').toLowerCase()}.`,
      });
      continue;
    }
    if (names.length === 0) continue;
    const label = variantNameOf(names.map((name) => ({ name, values: [] })), member.values);
    const key = label.toLowerCase();
    const earlier = seen.get(key);
    if (earlier) report(member.row, { field: optionField(names[0]!), message: `"${label}" is listed twice for this product (also ${earlier}).` });
    else seen.set(key, member.row ? `row ${member.row.v.rowNumber}` : `your item ${member.sku}`);
  }
  for (const group of groupsOf(names, members.map((m) => m.values))) {
    if (group.values.length > MAX_OPTION_VALUES) {
      report(members.find((m) => m.row)?.row ?? null, { field: optionField(group.name), message: `${group.name} can have at most ${MAX_OPTION_VALUES} different values.` });
    }
  }
}

/** One invalid row stops its whole product. */
function allOrNothing(members: GroupRow[], label: string): void {
  const broken = members.filter((m) => m.v.status !== ProductImportRowStatus.READY);
  if (broken.length === 0) return;
  const numbers = broken.map((m) => m.v.rowNumber).join(', ');
  for (const member of members) {
    if (member.v.status !== ProductImportRowStatus.READY) continue;
    member.v.status = ProductImportRowStatus.INVALID;
    member.v.action = ProductImportRowAction.NONE;
    member.v.errors.push({
      field: null,
      message: `Not imported: row${broken.length > 1 ? 's' : ''} ${numbers} of the same product (${label}) need${broken.length > 1 ? '' : 's'} fixing first. A product is imported only with all of its sizes.`,
    });
  }
}

function imageUnion(members: GroupRow[]): string[] {
  const names: string[] = [];
  for (const member of members) {
    for (const name of member.v.parsed.imageNames) if (!names.some((n) => imageNameKey(n) === imageNameKey(name))) names.push(name);
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* Create mode                                                                 */
/* -------------------------------------------------------------------------- */

export async function applyCreateGroups(sellerId: string, rows: GroupRow[]): Promise<void> {
  const groups = new Map<string, GroupRow[]>();
  for (const row of rows) {
    const parsed = row.v.parsed;
    if (row.v.status === ProductImportRowStatus.EXCLUDED) continue;
    if (!parsed.parentSku) {
      if (parsed.options) {
        fail(row, { field: 'parent_sku', message: 'An item with a size, color or option needs a parent_sku: the code of the product it is a size of (the same on all of its rows).' });
      }
      continue;
    }
    groups.set(parsed.parentSku, [...(groups.get(parsed.parentSku) ?? []), row]);
  }
  if (groups.size === 0) return;

  const taken = new Map(
    (
      await prisma.product.findMany({
        where: { submittedBySellerId: sellerId, deletedAt: null, parentSku: { in: [...groups.keys()] } },
        select: { parentSku: true, name: true },
      })
    ).map((p) => [p.parentSku!, p.name]),
  );

  for (const [parentSku, members] of groups) {
    const names = optionNames(members.map((m) => m.v.parsed.options ?? {}));
    const label = `parent_sku ${parentSku}`;

    const existing = taken.get(parentSku);
    if (existing) {
      for (const member of members) {
        fail(member, { field: 'parent_sku', message: `You already have a product with parent_sku ${parentSku} (${existing}). Choose Update mode to change it or add sizes.` }, ProductImportRowStatus.CONFLICT);
      }
    }
    if (members.length > 1 && names.length === 0) {
      for (const member of members) {
        fail(member, { field: 'size', message: `Rows that share ${label} are sizes of one product: give each a size, color or option_value to tell them apart.` });
      }
    }
    checkVariantSet(
      members.map((m) => ({ row: m, sku: m.v.sku ?? '', values: canonical(m.v.parsed.options, names) })),
      names,
      (target, issue) => target && fail(target, issue),
    );
    const images = imageUnion(members);
    if (images.length > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
      fail(members[0]!, { field: 'additional_image_filenames', message: `This product names ${images.length} photos across its rows; at most ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} are allowed.` });
    }

    allOrNothing(members, label);
    if (members.some((m) => m.v.status !== ProductImportRowStatus.READY)) continue;

    const optionGroups = groupsOf(names, members.map((m) => canonical(m.v.parsed.options, names)));
    const head = members[0]!.v.rowNumber;
    for (const member of members) {
      const parsed = member.v.parsed;
      if (names.length > 0) {
        parsed.optionValues = canonical(parsed.options, names);
        parsed.variantName = variantNameOf(optionGroups, parsed.optionValues);
      }
      parsed.group = { key: `P:${parentSku}`, head, parentSku, optionGroups };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Update mode                                                                 */
/* -------------------------------------------------------------------------- */

interface TargetProduct {
  id: string;
  name: string;
  brandId: string | null;
  status: ProductStatus;
  parentSku: string | null;
  optionGroups: ProductOptionGroupDto[];
  images: number;
  variants: {
    id: string;
    sku: string;
    optionValues: Record<string, string>;
    unit: string;
    unitValue: number;
    listing: { mrpPaise: number; pricePaise: number; stockQty: number } | null;
  }[];
}

async function loadTargets(sellerId: string, productIds: string[]): Promise<Map<string, TargetProduct>> {
  if (productIds.length === 0) return new Map();
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, submittedBySellerId: sellerId, deletedAt: null },
    select: {
      id: true,
      name: true,
      brandId: true,
      status: true,
      parentSku: true,
      optionGroups: true,
      _count: { select: { images: true } },
      variants: {
        where: { deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          sku: true,
          optionValues: true,
          unit: true,
          unitValue: true,
          sellerListings: { where: { sellerId }, select: { mrpPaise: true, pricePaise: true, stockQty: true } },
        },
      },
    },
  });
  return new Map(
    products.map((p) => [
      p.id,
      {
        id: p.id,
        name: p.name,
        brandId: p.brandId,
        status: p.status,
        parentSku: p.parentSku,
        optionGroups: optionGroupsOf(p.optionGroups),
        images: p._count.images,
        variants: p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          optionValues: optionValuesOf(v.optionValues),
          unit: v.unit,
          unitValue: v.unitValue,
          listing: v.sellerListings[0] ?? null,
        })),
      },
    ]),
  );
}

export interface UpdateGroupContext {
  sellerId: string;
  /** Brand of the brand column, when it names a known brand: rows of one product must keep the product's brand. */
  brandIdOf: (row: GroupRow) => string | null | undefined;
}

/**
 * Update mode: `rows` are the rows that take part in a product group — a
 * parent_sku, an option value, or a SKU of a product with several sizes.
 */
export async function applyUpdateGroups(rows: GroupRow[], ctx: UpdateGroupContext): Promise<void> {
  /* 1. Which product each group is. */
  const parentKeys = [...new Set(rows.map((r) => r.v.parsed.parentSku).filter((p): p is string => Boolean(p)))];
  const byParent = new Map(
    (
      await prisma.product.findMany({
        where: { submittedBySellerId: ctx.sellerId, deletedAt: null, parentSku: { in: parentKeys } },
        select: { id: true, parentSku: true },
      })
    ).map((p) => [p.parentSku!, p.id]),
  );

  const groups = new Map<string, { label: string; parentSku: string | null; members: GroupRow[] }>();
  for (const row of rows) {
    if (row.v.status === ProductImportRowStatus.EXCLUDED) continue;
    const parent = row.v.parsed.parentSku ?? null;
    const key = parent ? `P:${parent}` : row.ownVariant ? `ID:${row.ownVariant.productId}` : null;
    if (!key) {
      fail(row, { field: 'parent_sku', message: `None of your products has SKU ${row.v.sku ?? ''}. To add a new size to a product, give that product's parent_sku on this row.` });
      continue;
    }
    const group = groups.get(key) ?? { label: parent ? `parent_sku ${parent}` : `SKU ${row.v.sku}`, parentSku: parent, members: [] };
    group.members.push(row);
    groups.set(key, group);
  }

  const targetIdOf = new Map<string, string | null>();
  for (const [key, group] of groups) {
    const candidates = new Set<string>();
    if (group.parentSku && byParent.has(group.parentSku)) candidates.add(byParent.get(group.parentSku)!);
    for (const member of group.members) if (member.ownVariant) candidates.add(member.ownVariant.productId);
    if (candidates.size > 1) {
      for (const member of group.members) {
        fail(member, { field: 'parent_sku', message: `These rows (${group.label}) match ${candidates.size} different products of yours. The rows of one parent_sku must all be sizes of one product.` });
      }
      targetIdOf.set(key, null);
    } else if (candidates.size === 0) {
      for (const member of group.members) {
        fail(member, { field: 'parent_sku', message: `None of your products has ${group.label} or any of these SKUs. Use Create mode for new products.` });
      }
      targetIdOf.set(key, null);
    } else targetIdOf.set(key, [...candidates][0]!);
  }
  const targetIds = [...new Set([...targetIdOf.values()].filter((id): id is string => Boolean(id)))];
  const targets = await loadTargets(ctx.sellerId, targetIds);
  const underReview = new Set(
    (
      await prisma.productApprovalBatchItem.findMany({
        where: { productId: { in: targetIds }, status: ApprovalStatus.PENDING },
        select: { productId: true },
      })
    ).map((item) => item.productId),
  );

  /* 2. Each product's resulting size set. */
  for (const [key, group] of groups) {
    const targetId = targetIdOf.get(key);
    const target = targetId ? targets.get(targetId) : undefined;
    const { members, label } = group;
    if (target) {
      if (underReview.has(target.id)) {
        for (const member of members) fail(member, { field: null, message: 'This product is under review; it can be changed again once Aadione has reviewed it.' });
      }
      if (group.parentSku && target.parentSku && target.parentSku !== group.parentSku) {
        for (const member of members) {
          fail(member, { field: 'parent_sku', message: `This product's parent_sku is ${target.parentSku}. Use that, or leave parent_sku empty.` });
        }
      }
      const byVariant = new Map(target.variants.map((v) => [v.id, v]));
      const names = optionNames(
        members.map((m) => m.v.parsed.options ?? {}),
        target.optionGroups.map((g) => g.name),
      );
      const fileVariantIds = new Set<string>();
      const firstGiven = <K extends 'mrpPaise' | 'pricePaise' | 'unit' | 'unitValue'>(field: K) => members.map((m) => m.v.parsed[field]).find((v) => v !== undefined);
      const fallback = target.variants[0];

      const set: { row: GroupRow | null; sku: string; values: Record<string, string> }[] = [];
      for (const member of members) {
        const parsed = member.v.parsed;
        const existing = member.ownVariant && member.ownVariant.productId === target.id ? byVariant.get(member.ownVariant.variantId) : undefined;
        if (member.skuTakenElsewhere) {
          fail(member, { field: 'seller_sku', message: `SKU ${member.v.sku} is already used by another product. Use a different SKU for the new size.` });
        }
        if (existing) {
          fileVariantIds.add(existing.id);
          parsed.variantId = existing.id;
          parsed.optionValues = { ...canonical(existing.optionValues, names), ...canonical(parsed.options, names) };
          const mrp = parsed.mrpPaise ?? existing.listing?.mrpPaise;
          const price = parsed.pricePaise ?? existing.listing?.pricePaise;
          if (mrp !== undefined && price !== undefined && price > mrp) fail(member, { field: 'selling_price', message: 'Selling price cannot exceed MRP.' });
          if (!existing.listing && (parsed.mrpPaise !== undefined || parsed.pricePaise !== undefined || parsed.stockQty !== undefined) && (parsed.mrpPaise === undefined || parsed.pricePaise === undefined || parsed.stockQty === undefined)) {
            fail(member, { field: null, message: 'This item has no price yet: give mrp, selling_price and stock_quantity together.' });
          }
        } else {
          // A new size of this product: an empty price / unit cell takes the
          // product's own (its first size's) — a price typed on ANOTHER row of
          // the file is that size's change, not the product's price.
          parsed.optionValues = canonical(parsed.options, names);
          parsed.mrpPaise ??= fallback?.listing?.mrpPaise ?? firstGiven('mrpPaise');
          parsed.pricePaise ??= fallback?.listing?.pricePaise ?? firstGiven('pricePaise');
          parsed.unit ??= (fallback?.unit ?? firstGiven('unit')) as typeof parsed.unit;
          parsed.unitValue ??= fallback?.unitValue ?? firstGiven('unitValue');
          if (!member.v.sku) fail(member, { field: 'seller_sku', message: 'Give the new size its own seller_sku.' });
          if (parsed.stockQty === undefined) fail(member, { field: 'stock_quantity', message: 'Give the stock_quantity of the new size.' });
          if (parsed.mrpPaise === undefined || parsed.pricePaise === undefined) fail(member, { field: 'mrp', message: 'Give the mrp and selling_price of the new size.' });
          else if (parsed.pricePaise > parsed.mrpPaise) fail(member, { field: 'selling_price', message: 'Selling price cannot exceed MRP.' });
          if (parsed.barcode) fail(member, { field: 'barcode', message: 'Barcode cannot be added by an import. Leave the barcode column empty, or ask Aadione to add it.' });
          if (names.length === 0) {
            fail(member, { field: 'size', message: `This product has one item only. Give every row a size (or color / option_value) — including SKU ${target.variants[0]?.sku ?? ''} — to add sizes.` });
          }
        }
        if (parsed.isActive !== undefined && target.status === ProductStatus.ARCHIVED) {
          fail(member, { field: 'is_active', message: 'Aadione has disabled this product, so it cannot be shown or hidden.' });
        }
        const brandId = ctx.brandIdOf(member);
        if (brandId !== undefined && brandId !== target.brandId) {
          fail(member, { field: 'brand', message: 'Brand cannot be changed by an import. Leave the brand column empty, or ask Aadione to change it.' });
        }
        set.push({ row: member, sku: member.v.sku ?? '', values: parsed.optionValues ?? {} });
        parsed.productId = target.id;
        parsed.productName = target.name;
        member.v.productId = target.id;
      }
      for (const variant of target.variants) {
        if (!fileVariantIds.has(variant.id)) set.push({ row: null, sku: variant.sku, values: canonical(variant.optionValues, names) });
      }
      checkVariantSet(set, names, (row, issue) => fail(row ?? members[0]!, issue));

      const images = imageUnion(members);
      if (target.images + images.length > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
        fail(members[0]!, { field: 'additional_image_filenames', message: `The product already has ${target.images} photos; at most ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} are allowed.` });
      }

      const head = members[0]!.v.rowNumber;
      for (const member of members) {
        member.v.parsed.group = { key, head, parentSku: group.parentSku ?? undefined, optionGroups: groupsOf(names, set.map((s) => s.values), target.optionGroups) };
        if (names.length > 0 && member.v.parsed.optionValues) {
          member.v.parsed.variantName = variantNameOf(member.v.parsed.group.optionGroups!, member.v.parsed.optionValues);
        }
      }
    }
    allOrNothing(members, label);
  }
}
