/**
 * Choosing ONE real variant of a product from its option groups — the logic
 * behind the variant sheet (components/VariantSheet.tsx). Pure functions, no
 * React, no network: everything comes from GET /products/:id
 * (ProductDetailDto.optionGroups + each VariantDto.optionValues / inStock).
 *
 *   - Groups come from the product's own option groups (Size, Color, Pack
 *     Size…), showing only values some live variant actually has. When the
 *     variants do not carry a full, unique set of option values (older
 *     products told apart only by their name, e.g. "500 g" / "1 kg"), there
 *     is one group with one choice per variant instead.
 *   - A value no in-stock variant has is shown but disabled ("sold out").
 *   - A value that exists in stock, just not together with the other current
 *     picks, stays tappable: picking it drops the picks it conflicts with, so
 *     the customer can never land on a combination that does not exist.
 *   - Nothing is preselected (the existing rule: a product with several
 *     sizes has no size chosen until the customer picks one), except a
 *     group with a single possible value, which is no real choice.
 */

import type { ProductDetailDto, VariantDto } from "@shared";

export interface OptionChoice {
  /** What the selection stores: the option value, or the variant id in the by-variant fallback. */
  key: string;
  label: string;
}

export interface OptionGroup {
  name: string;
  choices: OptionChoice[];
}

export interface VariantOptions {
  groups: OptionGroup[];
  /** True when choices are whole variants (no usable option groups). */
  byVariant: boolean;
  /** The key a variant has in a group. */
  keyOf: (variant: VariantDto, group: string) => string | undefined;
}

/** Picks so far: group name → choice key. */
export type Selection = Readonly<Record<string, string>>;

export type ChoiceState = "available" | "conflict" | "soldOut";

export function variantOptions(product: Pick<ProductDetailDto, "optionGroups" | "variants">): VariantOptions {
  const variants = product.variants;
  const declared = product.optionGroups ?? [];

  // Usable option groups: every variant has a value in every group, and no
  // two variants share the same combination.
  const usable =
    declared.length > 0 &&
    variants.every((variant) => declared.every((group) => typeof variant.optionValues?.[group.name] === "string")) &&
    new Set(variants.map((variant) => declared.map((group) => variant.optionValues[group.name]).join("\u0000"))).size ===
      variants.length;

  if (usable) {
    return {
      byVariant: false,
      keyOf: (variant, group) => variant.optionValues[group],
      groups: declared
        .map((group) => ({
          name: group.name,
          // The product's own value order, limited to values a variant really has.
          choices: group.values
            .filter((value) => variants.some((variant) => variant.optionValues[group.name] === value))
            .map((value) => ({ key: value, label: value })),
        }))
        .filter((group) => group.choices.length > 0),
    };
  }

  const name = declared.length === 1 ? declared[0]!.name : "Size";
  return {
    byVariant: true,
    keyOf: (variant) => variant.id,
    groups: [{ name, choices: variants.map((variant) => ({ key: variant.id, label: variant.variantName })) }],
  };
}

function matches(options: VariantOptions, variant: VariantDto, selection: Selection, except?: string): boolean {
  return options.groups.every(
    (group) => group.name === except || selection[group.name] === undefined || options.keyOf(variant, group.name) === selection[group.name],
  );
}

/** Whether a choice can be picked, given the other current picks. */
export function choiceState(
  options: VariantOptions,
  variants: VariantDto[],
  selection: Selection,
  group: string,
  key: string,
): ChoiceState {
  const withValue = variants.filter((variant) => variant.inStock && options.keyOf(variant, group) === key);
  if (withValue.length === 0) return "soldOut";
  return withValue.some((variant) => matches(options, variant, selection, group)) ? "available" : "conflict";
}

/** The selection after picking `key` in `group`: picks that cannot go with it are dropped. */
export function pick(options: VariantOptions, variants: VariantDto[], selection: Selection, group: string, key: string): Selection {
  const next: Record<string, string> = { [group]: key };
  for (const other of options.groups) {
    const current = selection[other.name];
    if (other.name === group || current === undefined) continue;
    const trial = { ...next, [other.name]: current };
    if (variants.some((variant) => variant.inStock && matches(options, variant, trial))) next[other.name] = current;
  }
  return next;
}

/** The starting selection: only groups with a single possible value are filled in. */
export function initialSelection(options: VariantOptions, variants: VariantDto[]): Selection {
  const selection: Record<string, string> = {};
  for (const group of options.groups) {
    const inStock = group.choices.filter((choice) => variants.some((variant) => variant.inStock && options.keyOf(variant, group.name) === choice.key));
    if (group.choices.length === 1 && inStock.length === 1) selection[group.name] = inStock[0]!.key;
  }
  return selection;
}

/** The one variant the selection names, once every group is picked; undefined until then. */
export function selectedVariant(options: VariantOptions, variants: VariantDto[], selection: Selection): VariantDto | undefined {
  if (!options.groups.every((group) => selection[group.name] !== undefined)) return undefined;
  return variants.find((variant) => options.groups.every((group) => options.keyOf(variant, group.name) === selection[group.name]));
}

/** The first group still to pick, for the "Select size" prompt. */
export function missingGroup(options: VariantOptions, selection: Selection): string | undefined {
  return options.groups.find((group) => selection[group.name] === undefined)?.name;
}
