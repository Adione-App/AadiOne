/**
 * The product page's VARIANT MANAGER — one row (desktop) or card (phone) per
 * variant of the seller's own product ("Mogri: 250g / 500g / 1kg"), each
 * managed on its own:
 *
 *   price, MRP           PATCH /seller/listings/:listingId        (PricingPanel)
 *   stock +/−, history   POST  /seller/listings/:listingId/stock-adjust (InventoryPanel)
 *   on sale / off sale   PATCH /seller/listings/:listingId { isAvailable }
 *   show / hide          PATCH /seller/products/:id/variants/:variantId/visibility
 *   edit details         PATCH /seller/products/:id/variants/:variantId
 *   delete               DELETE /seller/products/:id/variants/:variantId (confirmed)
 *   add a variant        POST  /seller/products/:id/variants
 *
 * Every call changes exactly one variant; the server re-checks every rule
 * (ownership, review lock, price ≤ MRP, stock never below reserved,
 * duplicates, the product's last variant) and the screen re-reads the
 * product after each one — nothing is updated optimistically.
 */

import { useState, type ReactNode } from 'react';
import { formatPaise } from '@shared/money';
import type { UnitType } from '@shared';
import { Button, ErrorBanner, Field, Modal, Pill, Toggle, inputClass } from '@/components/ui';
import { UNIT_OPTIONS, sellerApi, sellerErrorMessage, type SellerProductInventory } from './sellerApi';
import { InventoryPanel, PricingPanel } from './productSections';
import { VisibilityPill, toPaise, toStock, STOCK_RULE, type Notice } from './productUi';

type Variant = SellerProductInventory['variants'][number];

/** Can this variant be shown / hidden? Only a live one (approved, not waiting for review). */
const canToggleVisibility = (v: Variant) => v.approvalStatus === 'APPROVED' && v.status !== 'DRAFT';
const isHidden = (v: Variant) => v.status === 'INACTIVE';

function StatusPills({ variant }: { variant: Variant }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {variant.visibility ? <VisibilityPill reason={variant.visibility.reason} /> : null}
      {variant.isDefault && <Pill tone="gray">Default</Pill>}
    </span>
  );
}

function Num({ value }: { value: number | null | undefined }) {
  return <span className="tabular-nums">{value ?? '—'}</span>;
}

export function VariantManager({
  product,
  food,
  onChanged,
  onNotice,
}: {
  product: SellerProductInventory;
  food: boolean;
  onChanged: () => Promise<unknown>;
  onNotice: (notice: Notice) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Variant | null>(null);
  const [deleting, setDeleting] = useState<Variant | null>(null);
  const [adding, setAdding] = useState(false);
  const variants = product.variants ?? [];
  const groups = product.optionGroups ?? [];
  // A product in review cannot change its variants (the server refuses too);
  // price, stock and the switches stay the seller's.
  const underReview = product.latestApproval?.status === 'PENDING';
  const adminLocked = product.status === 'ARCHIVED';

  async function run(key: string, label: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    try {
      await action();
      await onChanged();
      onNotice({ ok: true, text: label });
    } catch (error) {
      onNotice({ ok: false, text: sellerErrorMessage(error) });
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  const setOnSale = (v: Variant, on: boolean) =>
    run(`sale-${v.id}`, `${v.variantName}: ${on ? 'on sale' : 'taken off sale'}.`, () => sellerApi.patch(`/seller/listings/${v.listing!.id}`, { isAvailable: on }));
  const setShown = (v: Variant, shown: boolean) =>
    run(`show-${v.id}`, `${v.variantName}: ${shown ? 'shown to customers' : 'hidden from customers'}.`, () =>
      sellerApi.patch(`/seller/products/${product.id}/variants/${v.id}/visibility`, { visible: shown }),
    );

  const actions = (v: Variant): ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      {v.listing && (
        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          <Toggle
            checked={v.listing.isAvailable}
            disabled={busy !== null || adminLocked}
            onChange={(next) => void setOnSale(v, next)}
            label={`${v.variantName} on sale`}
          />
          On sale
        </label>
      )}
      {canToggleVisibility(v) && (
        <Button variant="ghost" className="min-h-9 px-3" disabled={busy !== null} onClick={() => void setShown(v, isHidden(v))}>
          {isHidden(v) ? 'Show' : 'Hide'}
        </Button>
      )}
      <Button variant="ghost" className="min-h-9 px-3" disabled={busy !== null || underReview || adminLocked} onClick={() => setEditing(v)}>
        Edit
      </Button>
      <Button
        variant="ghost"
        className="min-h-9 px-3 text-danger-600"
        disabled={busy !== null || underReview || variants.length <= 1}
        onClick={() => setDeleting(v)}
        aria-label={`Delete ${v.variantName}`}
      >
        Delete
      </Button>
      <Button variant="soft" className="min-h-9 px-3" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
        {open === v.id ? 'Close' : food ? 'Price' : 'Price & stock'}
      </Button>
    </div>
  );

  const detail = (v: Variant): ReactNode =>
    v.listing ? (
      <div className="grid gap-4 rounded-xl bg-gray-50 p-3 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-gray-800">{v.variantName} — price</p>
          <PricingPanel key={`p-${v.listing.id}`} listing={v.listing} onChanged={onChanged} />
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-gray-800">{v.variantName} — {v.listing.tracksStock ? 'stock' : 'availability'}</p>
          <InventoryPanel key={`i-${v.listing.id}`} listing={v.listing} label={`${product.name} ${v.variantName}`} onChanged={onChanged} />
        </div>
      </div>
    ) : (
      <p className="text-sm text-gray-500">This variant has no price yet.</p>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          {variants.length} variant{variants.length === 1 ? '' : 's'} — each with its own price{food ? '' : ', MRP and stock'}. Changing one never changes another.
        </p>
        {groups.length > 0 && (
          <Button variant="secondary" disabled={underReview || adminLocked} onClick={() => setAdding(true)}>
            Add variant
          </Button>
        )}
      </div>
      {underReview && (
        <p className="rounded-xl bg-warn-50 px-3 py-2 text-sm text-warn-500">
          Aadione is reviewing this product. Variants can be added, edited or deleted once the review is done; prices, stock and the switches still work.
        </p>
      )}
      {product.approvalStatus === 'APPROVED' && groups.length > 0 && (
        <p className="text-xs text-gray-500">A new variant of this approved product is reviewed by Aadione first — the variants already on sale stay on sale.</p>
      )}

      {/* desktop: table */}
      <div className="hidden overflow-x-auto rounded-xl border border-gray-200 md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Variants of {product.name}</caption>
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th scope="col" className="px-3 py-2.5">Variant</th>
              <th scope="col" className="px-3 py-2.5 text-right">Selling price</th>
              {!food && <th scope="col" className="px-3 py-2.5 text-right">MRP</th>}
              {!food && <th scope="col" className="px-3 py-2.5 text-right">Stock</th>}
              {!food && <th scope="col" className="px-3 py-2.5 text-right">Reserved</th>}
              {!food && <th scope="col" className="px-3 py-2.5 text-right">Available</th>}
              <th scope="col" className="px-3 py-2.5">Status</th>
              <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {variants.map((v) => (
              <VariantTableRows key={v.id} open={open === v.id} colSpan={food ? 4 : 8} detail={detail(v)}>
                <td className="px-3 py-2.5">
                  <p className="font-semibold text-gray-900">{v.variantName}</p>
                  {!food && <p className="font-mono text-xs text-gray-500">{v.sku}</p>}
                </td>
                <td className="px-3 py-2.5 text-right font-semibold">{v.listing ? formatPaise(v.listing.pricePaise) : '—'}</td>
                {!food && <td className="px-3 py-2.5 text-right text-gray-600">{v.listing ? formatPaise(v.listing.mrpPaise) : '—'}</td>}
                {!food && <td className="px-3 py-2.5 text-right"><Num value={v.listing?.stockQty} /></td>}
                {!food && <td className="px-3 py-2.5 text-right"><Num value={v.listing?.reservedQty} /></td>}
                {!food && <td className="px-3 py-2.5 text-right font-semibold"><Num value={v.listing?.availableQty} /></td>}
                <td className="px-3 py-2.5"><StatusPills variant={v} /></td>
                <td className="px-3 py-2.5">{actions(v)}</td>
              </VariantTableRows>
            ))}
          </tbody>
        </table>
      </div>

      {/* phone: expandable cards */}
      <ul className="grid gap-2 md:hidden" aria-label={`Variants of ${product.name}`}>
        {variants.map((v) => (
          <li key={v.id} className="rounded-xl border border-gray-200 bg-white p-3">
            <button
              type="button"
              className="flex w-full items-start justify-between gap-3 text-left"
              onClick={() => setOpen(open === v.id ? null : v.id)}
              aria-expanded={open === v.id}
            >
              <span className="min-w-0">
                <span className="block font-semibold text-gray-900">{v.variantName}</span>
                <span className="mt-0.5 block text-sm text-gray-700">
                  {v.listing ? formatPaise(v.listing.pricePaise) : '—'}
                  {!food && v.listing && v.listing.mrpPaise > v.listing.pricePaise && (
                    <span className="ml-1 text-xs text-gray-400 line-through">{formatPaise(v.listing.mrpPaise)}</span>
                  )}
                </span>
                {!food && v.listing && (
                  <span className="mt-0.5 block text-xs text-gray-500">
                    {v.listing.stockQty} in stock · {v.listing.reservedQty} reserved · <b>{v.listing.availableQty}</b> available
                  </span>
                )}
              </span>
              <StatusPills variant={v} />
            </button>
            {open === v.id && <div className="mt-3 space-y-3">{actions(v)}{detail(v)}</div>}
            {open !== v.id && <div className="mt-2">{actions(v)}</div>}
          </li>
        ))}
      </ul>

      {editing && (
        <VariantFormModal
          mode={{ kind: 'edit', variant: editing }}
          product={product}
          food={food}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            await onChanged();
            onNotice({ ok: true, text });
          }}
        />
      )}
      {adding && (
        <VariantFormModal
          mode={{ kind: 'add' }}
          product={product}
          food={food}
          onClose={() => setAdding(false)}
          onSaved={async (text) => {
            setAdding(false);
            await onChanged();
            onNotice({ ok: true, text });
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.variantName}?`}
          subtitle={product.name}
          onClose={() => setDeleting(null)}
          footer={
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              <Button variant="secondary" onClick={() => setDeleting(null)} disabled={busy !== null}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  void run(`delete-${target.id}`, `${target.variantName} was deleted.`, () =>
                    sellerApi.delete(`/seller/products/${product.id}/variants/${target.id}`),
                  );
                }}
              >
                Delete {deleting.variantName}
              </Button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            Customers will no longer see {deleting.variantName}. The other variants of {product.name} stay on sale as they are. Past orders keep their
            record of it — nothing that was already ordered changes.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** A table row plus, when open, its full-width price & stock row underneath. */
function VariantTableRows({ open, colSpan, detail, children }: { open: boolean; colSpan: number; detail: ReactNode; children: ReactNode }) {
  return (
    <>
      <tr className="align-top">{children}</tr>
      {open && (
        <tr>
          <td colSpan={colSpan} className="px-3 pb-3">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* add / edit one variant                                                     */
/* -------------------------------------------------------------------------- */

type FormMode = { kind: 'add' } | { kind: 'edit'; variant: Variant };

function VariantFormModal({
  mode,
  product,
  food,
  onClose,
  onSaved,
}: {
  mode: FormMode;
  product: SellerProductInventory;
  food: boolean;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
}) {
  const groups = product.optionGroups ?? [];
  const current = mode.kind === 'edit' ? mode.variant : null;
  const template = current ?? product.variants?.[0] ?? null;
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(current?.optionValues ?? {}) }));
  const [name, setName] = useState(current?.variantName ?? '');
  const [sku, setSku] = useState(current?.sku ?? '');
  const [unit, setUnit] = useState<UnitType>((template?.unit as UnitType | undefined) ?? 'PIECE');
  const [unitValue, setUnitValue] = useState(template ? String(template.unitValue) : '1');
  const [price, setPrice] = useState('');
  const [mrp, setMrp] = useState('');
  const [stock, setStock] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function check(): string | Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (groups.length > 0) {
      for (const group of groups) {
        if (!values[group.name]?.trim()) return `Enter the ${group.name}.`;
      }
      body['optionValues'] = Object.fromEntries(groups.map((g) => [g.name, values[g.name]!.trim()]));
    } else if (mode.kind === 'edit') {
      if (!name.trim()) return 'Enter the variant name, e.g. "1 kg".';
      body['variantName'] = name.trim();
    }
    if (!food) {
      if (mode.kind === 'add' || sku.trim() !== (current?.sku ?? '')) {
        if (sku.trim().length < 2) return 'Enter a SKU (at least 2 characters).';
        body['sku'] = sku.trim();
      }
      const amount = Number(unitValue);
      if (!Number.isFinite(amount) || amount <= 0) return 'Enter the pack size, e.g. 500.';
      body['unit'] = unit;
      body['unitValue'] = amount;
    }
    if (mode.kind === 'add') {
      const pricePaise = toPaise(price);
      if (pricePaise === null) return 'Enter the selling price (greater than 0).';
      body['pricePaise'] = pricePaise;
      if (!food) {
        const mrpPaise = toPaise(mrp);
        if (mrpPaise === null) return 'Enter the MRP.';
        if (pricePaise > mrpPaise) return 'Selling price cannot be higher than MRP.';
        const qty = toStock(stock);
        if (qty === null) return STOCK_RULE;
        body['mrpPaise'] = mrpPaise;
        body['stockQty'] = qty;
      }
    }
    return body;
  }

  async function save(): Promise<void> {
    const body = check();
    if (typeof body === 'string') return setProblem(body);
    setProblem(null);
    setSaving(true);
    try {
      if (mode.kind === 'add') {
        await sellerApi.post(`/seller/products/${product.id}/variants`, body);
        await onSaved(
          product.approvalStatus === 'APPROVED'
            ? 'Variant added. Aadione reviews it before customers see it — submit it from Products.'
            : 'Variant added. It is reviewed together with the product.',
        );
      } else {
        await sellerApi.patch(`/seller/products/${product.id}/variants/${mode.variant.id}`, body);
        await onSaved('Variant updated.');
      }
    } catch (error) {
      setProblem(sellerErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={mode.kind === 'add' ? 'Add variant' : `Edit ${mode.variant.variantName}`}
      subtitle={product.name}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : mode.kind === 'add' ? 'Add variant' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={problem} />
        {groups.map((group) => (
          <Field key={group.name} label={group.name} required hint={`Existing: ${group.values.join(', ')}. Type a new one to add it.`}>
            <input
              className={inputClass}
              list={`values-${group.name}`}
              value={values[group.name] ?? ''}
              onChange={(event) => setValues((v) => ({ ...v, [group.name]: event.target.value }))}
              maxLength={40}
            />
            <datalist id={`values-${group.name}`}>
              {group.values.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Field>
        ))}
        {groups.length === 0 && mode.kind === 'edit' && (
          <Field label="Variant name" required>
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
        )}
        {!food && (
          <>
            <Field label="SKU" required={mode.kind === 'add'} hint="Your own code for this variant — unique across Aadione.">
              <input className={inputClass} value={sku} onChange={(event) => setSku(event.target.value.toUpperCase())} maxLength={60} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Pack size">
                <input className={inputClass} inputMode="decimal" value={unitValue} onChange={(event) => setUnitValue(event.target.value)} />
              </Field>
              <Field label="Unit">
                <select className={inputClass} value={unit} onChange={(event) => setUnit(event.target.value as UnitType)}>
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}
        {mode.kind === 'add' && (
          <div className={`grid gap-3 ${food ? '' : 'grid-cols-3'}`}>
            <Field label="Selling price (₹)" required>
              <input className={inputClass} inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Field>
            {!food && (
              <Field label="MRP (₹)" required>
                <input className={inputClass} inputMode="decimal" value={mrp} onChange={(event) => setMrp(event.target.value)} />
              </Field>
            )}
            {!food && (
              <Field label="Opening stock" required>
                <input className={inputClass} inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} />
              </Field>
            )}
          </div>
        )}
        {mode.kind === 'edit' && (
          <p className="text-xs text-gray-500">Price, MRP and stock are changed with “Price &amp; stock” on the variant’s row.</p>
        )}
      </div>
    </Modal>
  );
}
