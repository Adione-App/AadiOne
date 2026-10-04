/**
 * "Options / Variants" — the optional, generic option editor shared by the
 * marketplace product form and the restaurant / cafe food item form.
 *
 *   [ ] This item has options / variants
 *       Option group  [ Size ]   values: Small · Medium · Large  (+ Add value)
 *       + Add another option group
 *       Variants (every combination):  Small  ₹ [149]   Medium ₹ [249] …
 *
 * Nothing is product-specific: Size, Portion, Color, Storage, Pack Size… are
 * whatever the seller types. Each combination is one sellable variant with its
 * own price (marketplace: also MRP, opening stock and SKU; food: price only).
 * A combination can be left out with ×. Value order = variant order.
 *
 * The backend owns every rule (product-variant.service); this only shapes
 * the request: { optionGroups, variants[] } for POST /seller/products and
 * PUT /seller/products/:id/variants.
 */

import { useState } from 'react';
import type { ProductOptionGroupDto, SellerProductVariantDto } from '@shared';
import { Field, Pill, Toggle, inputClass } from '@/components/ui';
import { toPaise, toStock } from './productUi';

export interface VariantRowState {
  /** Existing variant id (edit), absent for a new combination. */
  id?: string;
  approvalStatus?: string;
  price: string;
  mrp: string;
  stock: string;
  sku: string;
  available: boolean;
}

export interface VariantEditorState {
  enabled: boolean;
  groups: ProductOptionGroupDto[];
  /** Keyed by comboKey (the combination's values in group order). */
  rows: Record<string, VariantRowState>;
  /** Combinations the seller left out. */
  excluded: string[];
}

export interface VariantSetRequest {
  optionGroups: ProductOptionGroupDto[];
  variants: {
    id?: string;
    optionValues?: Record<string, string>;
    variantName?: string;
    sku?: string;
    pricePaise: number;
    mrpPaise?: number;
    stockQty?: number;
    isAvailable?: boolean;
  }[];
}

const MAX_GROUPS = 3;
const rupees = (paise: number | undefined | null): string => (paise === undefined || paise === null ? '' : String(paise / 100));
const emptyRow = (): VariantRowState => ({ price: '', mrp: '', stock: '', sku: '', available: true });

/** Every combination of the groups' values, in group / value order. */
export function combinations(groups: ProductOptionGroupDto[]): Record<string, string>[] {
  const usable = groups.filter((g) => g.name.trim() && g.values.length > 0);
  if (usable.length === 0) return [];
  return usable.reduce<Record<string, string>[]>(
    (acc, group) => acc.flatMap((combo) => group.values.map((value) => ({ ...combo, [group.name.trim()]: value }))),
    [{}],
  );
}

export const comboKey = (groups: ProductOptionGroupDto[], values: Record<string, string>): string =>
  groups
    .filter((g) => g.name.trim() && g.values.length > 0)
    .map((g) => values[g.name.trim()] ?? '')
    .join(' / ');

/** Editor state for a new item, or from a product's current options / variants. */
export function editorFromVariants(optionGroups: ProductOptionGroupDto[], variants: SellerProductVariantDto[]): VariantEditorState {
  if (optionGroups.length === 0) return { enabled: false, groups: [{ name: '', values: [] }], rows: {}, excluded: [] };
  const rows: Record<string, VariantRowState> = {};
  for (const v of variants) {
    rows[comboKey(optionGroups, v.optionValues)] = {
      id: v.id,
      approvalStatus: v.approvalStatus,
      price: rupees(v.listing?.pricePaise),
      mrp: rupees(v.listing?.mrpPaise),
      stock: v.listing ? String(v.listing.stockQty) : '',
      sku: v.sku,
      available: v.listing?.isAvailable ?? true,
    };
  }
  const present = new Set(Object.keys(rows));
  const excluded = combinations(optionGroups)
    .map((combo) => comboKey(optionGroups, combo))
    .filter((key) => !present.has(key));
  return { enabled: true, groups: optionGroups.map((g) => ({ name: g.name, values: [...g.values] })), rows, excluded };
}

/** The request body, or the first problem to show. Only called when `enabled`. */
export function variantSetFromEditor(state: VariantEditorState, food: boolean): VariantSetRequest | string {
  const groups = state.groups.map((g) => ({ name: g.name.trim(), values: g.values })).filter((g) => g.name || g.values.length);
  if (groups.length === 0) return 'Add an option group (e.g. Size) with at least one value, or switch options off.';
  for (const group of groups) {
    if (!group.name) return 'Give every option group a name (e.g. Size, Color, Portion).';
    if (group.values.length === 0) return `Add at least one value to "${group.name}".`;
  }
  const variants: VariantSetRequest['variants'] = [];
  for (const combo of combinations(groups)) {
    const key = comboKey(groups, combo);
    if (state.excluded.includes(key)) continue;
    const row = state.rows[key] ?? emptyRow();
    const pricePaise = toPaise(row.price);
    if (pricePaise === null) return `Enter a selling price for "${key}".`;
    if (food) {
      variants.push({ ...(row.id ? { id: row.id } : {}), optionValues: combo, pricePaise, isAvailable: row.available });
      continue;
    }
    const mrpPaise = toPaise(row.mrp);
    if (mrpPaise === null) return `Enter the MRP for "${key}".`;
    if (pricePaise > mrpPaise) return `"${key}": selling price cannot be higher than MRP.`;
    const stockQty = row.stock.trim() ? toStock(row.stock) : null;
    if (row.stock.trim() && stockQty === null) return `"${key}": enter a whole-number stock.`;
    if (!row.id && stockQty === null) return `Enter the opening stock for "${key}".`;
    if (!row.id && row.sku.trim().length < 2) return `Enter a SKU for "${key}".`;
    variants.push({
      ...(row.id ? { id: row.id } : {}),
      optionValues: combo,
      ...(row.sku.trim() ? { sku: row.sku.trim() } : {}),
      pricePaise,
      mrpPaise,
      ...(stockQty !== null ? { stockQty } : {}),
      isAvailable: row.available,
    });
  }
  if (variants.length === 0) return 'Keep at least one variant.';
  return { optionGroups: groups, variants };
}

export function VariantEditor({
  state,
  onChange,
  food,
  disabled = false,
}: {
  state: VariantEditorState;
  onChange: (next: VariantEditorState) => void;
  food: boolean;
  disabled?: boolean;
}) {
  const [draftValues, setDraftValues] = useState<string[]>(state.groups.map(() => ''));
  const setGroups = (groups: ProductOptionGroupDto[]) => onChange({ ...state, groups });
  const setRow = (key: string, patch: Partial<VariantRowState>) =>
    onChange({ ...state, rows: { ...state.rows, [key]: { ...(state.rows[key] ?? emptyRow()), ...patch } } });

  function addValue(index: number): void {
    const value = (draftValues[index] ?? '').trim();
    const group = state.groups[index]!;
    if (!value || group.values.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    setGroups(state.groups.map((g, i) => (i === index ? { ...g, values: [...g.values, value] } : g)));
    setDraftValues((list) => list.map((v, i) => (i === index ? '' : v)));
  }
  function moveValue(index: number, from: number, to: number): void {
    const group = state.groups[index]!;
    if (to < 0 || to >= group.values.length) return;
    const values = [...group.values];
    const [moving] = values.splice(from, 1);
    values.splice(to, 0, moving!);
    setGroups(state.groups.map((g, i) => (i === index ? { ...g, values } : g)));
  }

  const usable = state.groups.filter((g) => g.name.trim() && g.values.length > 0);
  const combos = combinations(state.groups);

  return (
    <section aria-label="Options / Variants" className="space-y-3 rounded-xl border border-gray-200 p-3.5">
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-800">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...state, enabled: event.target.checked })}
          className="h-4 w-4 rounded border-gray-300 text-brand-600"
        />
        This item has options / variants
      </label>
      {!state.enabled ? (
        <p className="text-xs text-gray-500">
          A single item with one price. Switch this on for sizes, portions, colours, pack sizes and so on — you can also add options later.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm font-semibold text-gray-900">Options / Variants</p>
          {state.groups.map((group, index) => (
            <div key={index} className="space-y-2 rounded-lg bg-gray-50 p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="Option group">
                    <input
                      value={group.name}
                      disabled={disabled}
                      onChange={(event) => setGroups(state.groups.map((g, i) => (i === index ? { ...g, name: event.target.value } : g)))}
                      maxLength={40}
                      className={inputClass}
                      placeholder={index === 0 ? (food ? 'e.g. Portion or Size' : 'e.g. Size, Pack Size or Storage') : 'e.g. Color'}
                    />
                  </Field>
                </div>
                {state.groups.length > 1 && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setGroups(state.groups.filter((_, i) => i !== index));
                      setDraftValues((list) => list.filter((_, i) => i !== index));
                    }}
                    className="mb-2 text-xs font-semibold text-red-600"
                  >
                    Remove group
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5" aria-label={`${group.name || 'Option'} values`}>
                {group.values.map((value, vi) => (
                  <span key={value} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-800">
                    <button type="button" disabled={disabled || vi === 0} onClick={() => moveValue(index, vi, vi - 1)} aria-label={`Move ${value} left`} className="text-gray-400 disabled:opacity-30">
                      ‹
                    </button>
                    {value}
                    <button type="button" disabled={disabled || vi === group.values.length - 1} onClick={() => moveValue(index, vi, vi + 1)} aria-label={`Move ${value} right`} className="text-gray-400 disabled:opacity-30">
                      ›
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setGroups(state.groups.map((g, i) => (i === index ? { ...g, values: g.values.filter((v) => v !== value) } : g)))}
                      aria-label={`Remove ${value}`}
                      className="text-red-500"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  value={draftValues[index] ?? ''}
                  disabled={disabled}
                  onChange={(event) => setDraftValues((list) => Object.assign([...list], { [index]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addValue(index);
                    }
                  }}
                  maxLength={40}
                  aria-label={`New value for ${group.name || 'option group'}`}
                  placeholder={index === 0 ? (food ? 'e.g. Half' : 'e.g. Small') : 'e.g. Black'}
                  className="h-8 w-32 rounded-lg border border-gray-300 px-2 text-xs"
                />
                <button type="button" disabled={disabled} onClick={() => addValue(index)} className="text-xs font-semibold text-brand-600">
                  + Add value
                </button>
              </div>
            </div>
          ))}
          {state.groups.length < MAX_GROUPS && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setGroups([...state.groups, { name: '', values: [] }]);
                setDraftValues((list) => [...list, '']);
              }}
              className="text-sm font-semibold text-brand-600"
            >
              + Add another option group
            </button>
          )}

          {usable.length > 0 && combos.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-800">
                Variants <span className="font-normal text-gray-500">— each has its own {food ? 'price and availability' : 'price, MRP, stock and SKU'}</span>
              </p>
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200" aria-label="Variants">
                {combos.map((combo) => {
                  const key = comboKey(state.groups, combo);
                  const row = state.rows[key] ?? emptyRow();
                  const left = state.excluded.includes(key);
                  return (
                    <li key={key} className={`flex flex-wrap items-end gap-2 p-2.5 ${left ? 'opacity-50' : ''}`}>
                      <div className="min-w-[7rem] flex-1">
                        <p className="text-sm font-semibold text-gray-900">{key}</p>
                        {row.approvalStatus === 'PENDING' && <Pill tone="amber">New · awaiting approval</Pill>}
                        {row.approvalStatus === 'REJECTED' && <Pill tone="red">Rejected — edit to resubmit</Pill>}
                        {!row.id && !left && <span className="text-xs text-gray-500">New</span>}
                      </div>
                      {!left && (
                        <>
                          <label className="w-24 text-xs text-gray-600">
                            Price (₹)
                            <input value={row.price} disabled={disabled} onChange={(e) => setRow(key, { price: e.target.value })} inputMode="decimal" aria-label={`Price of ${key}`} className={`${inputClass} mt-0.5 h-9`} />
                          </label>
                          {!food && (
                            <>
                              <label className="w-24 text-xs text-gray-600">
                                MRP (₹)
                                <input value={row.mrp} disabled={disabled} onChange={(e) => setRow(key, { mrp: e.target.value })} inputMode="decimal" aria-label={`MRP of ${key}`} className={`${inputClass} mt-0.5 h-9`} />
                              </label>
                              <label className="w-20 text-xs text-gray-600">
                                {row.id ? 'Stock' : 'Opening stock'}
                                <input value={row.stock} disabled={disabled} onChange={(e) => setRow(key, { stock: e.target.value })} inputMode="numeric" aria-label={`Stock of ${key}`} className={`${inputClass} mt-0.5 h-9`} />
                              </label>
                              <label className="w-28 text-xs text-gray-600">
                                SKU
                                <input value={row.sku} disabled={disabled} onChange={(e) => setRow(key, { sku: e.target.value })} aria-label={`SKU of ${key}`} className={`${inputClass} mt-0.5 h-9`} />
                              </label>
                            </>
                          )}
                          <span className="inline-flex items-center gap-1 pb-2 text-xs text-gray-600">
                            <Toggle checked={row.available} disabled={disabled} onChange={(next) => setRow(key, { available: next })} label={`${key} available`} />
                          </span>
                        </>
                      )}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          onChange({ ...state, excluded: left ? state.excluded.filter((k) => k !== key) : [...state.excluded, key] })
                        }
                        className={`pb-2 text-xs font-semibold ${left ? 'text-brand-600' : 'text-red-600'}`}
                        aria-label={left ? `Add ${key} back` : `Leave out ${key}`}
                      >
                        {left ? 'Add back' : 'Remove'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
