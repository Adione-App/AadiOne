/**
 * Seller product dialogs: add / edit a COMPLETE product — details, category,
 * SKU, images AND the seller's own MRP, selling price and stock
 * (POST|PATCH /seller/products) — saved as a draft; inline subcategory and
 * menu-section creation; and "Add price & stock" (POST /seller/listings) for
 * an older product saved without them. Drafts are sent for review together
 * from the Products page ("Submit for Approval" — one batch); a rejected
 * product is resubmitted from here (POST /seller/approval-batches with its
 * id). The backend stays authoritative for every rule (category ownership,
 * editable window, price ≤ MRP, stock limits, approval, ownership).
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SellerProductDto, UnitType } from '@shared';
import { ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { validateImage } from '@/lib/upload';
import { Button, ErrorBanner, Field, Modal, Spinner, Toggle, inputClass } from '@/components/ui';
import {
  LISTING_MAX_STOCK,
  MAX_PRODUCT_IMAGES,
  PRODUCT_LIMITS,
  UNIT_OPTIONS,
  sellerApi,
  sellerErrorMessage,
  uploadSellerImage,
  type CreateSellerListingRequest,
  type CreateSellerProductRequest,
  type CreatedSellerProduct,
  type SellerCatalogCategories,
  type SellerSubcategory,
  type UpdateSellerProductRequest,
} from './sellerApi';
import { sellerKeys, useSellerAvailability } from './sellerQueries';
import {
  ImageGallery,
  ProductImage,
  STOCK_RULE,
  UNIT_SHORT,
  moved,
  rejectionOf,
  toPaise,
  toStock,
  type GalleryItem,
  type Notice,
} from './productUi';
import { VariantEditor, editorFromVariants, variantSetFromEditor, type VariantEditorState } from './variantEditor';

/**
 * Edit is offered only where the server allows it — never submitted, or
 * rejected (backend `loadEditableOwnProduct`, which stays authoritative:
 * anything else is refused there with a 409).
 */
export type ProductFormMode =
  /** `categoryId`: preselect a category, subcategory or (food) menu section. */
  | { kind: 'create'; categoryId?: string }
  | { kind: 'edit'; product: SellerProductDto };

/** Only what differs from the server's current version (PATCH /seller/products/:id). */
function productChanges(request: CreateSellerProductRequest, base: SellerProductDto): UpdateSellerProductRequest {
  const variant = base.defaultVariant;
  const listing = base.listing;
  return {
    ...(request.mrpPaise !== undefined && (!listing || request.mrpPaise !== listing.mrpPaise) ? { mrpPaise: request.mrpPaise } : {}),
    ...(request.pricePaise !== undefined && (!listing || request.pricePaise !== listing.pricePaise) ? { pricePaise: request.pricePaise } : {}),
    ...(request.stockQty !== undefined && (!listing || request.stockQty !== listing.stockQty) ? { stockQty: request.stockQty } : {}),
    ...(request.categoryId !== base.categoryId ? { categoryId: request.categoryId } : {}),
    ...(request.name !== base.name ? { name: request.name } : {}),
    ...((request.nameHi ?? null) !== (base.nameHi ?? null) ? { nameHi: request.nameHi ?? null } : {}),
    ...((request.description ?? null) !== (base.description ?? null) ? { description: request.description ?? null } : {}),
    ...(variant && request.sku !== undefined && request.sku.toUpperCase() !== variant.sku ? { sku: request.sku } : {}),
    ...(variant && request.variantName !== undefined && request.variantName !== variant.variantName ? { variantName: request.variantName } : {}),
    ...(variant && request.unit !== undefined && request.unit !== variant.unit ? { unit: request.unit } : {}),
    ...(variant && request.unitValue !== undefined && request.unitValue !== variant.unitValue ? { unitValue: request.unitValue } : {}),
  };
}

export function ProductFormModal({
  mode,
  onClose,
  onDone,
}: {
  mode: ProductFormMode;
  onClose: () => void;
  onDone: (result: Notice) => void;
}) {
  const queryClient = useQueryClient();
  const availability = useSellerAvailability();
  const sellerType = availability.data?.sellerType;
  // While editing: the server's latest version of the product.
  const [saved, setSaved] = useState<SellerProductDto | null>(mode.kind === 'edit' ? mode.product : null);

  // A marketplace product goes under the seller's own top category /
  // subcategory (the backend enforces it). Restaurant / cafe food items have
  // their own form (foodItemForm.tsx) — never this one.
  const catalog = useQuery({
    queryKey: sellerKeys.catalogCategories,
    queryFn: () => sellerApi.get<SellerCatalogCategories>('/seller/categories'),
    enabled: sellerType !== undefined,
  });

  const initial = saved;
  const preset = mode.kind === 'create' ? (mode.categoryId ?? '') : '';
  const [parentId, setParentId] = useState(initial ? (initial.subcategory ? initial.category.id : initial.categoryId) : '');
  const [childId, setChildId] = useState(initial?.subcategory?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [nameHi, setNameHi] = useState(initial?.nameHi ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sku, setSku] = useState(initial?.defaultVariant?.sku ?? '');
  const [variantName, setVariantName] = useState(initial?.defaultVariant?.variantName ?? '');
  const [unit, setUnit] = useState<UnitType>(initial?.defaultVariant?.unit ?? 'PIECE');
  const [unitValue, setUnitValue] = useState(initial?.defaultVariant ? String(initial.defaultVariant.unitValue) : '1');
  const rupees = (paise: number | undefined): string => (paise === undefined ? '' : String(paise / 100));
  const [mrp, setMrp] = useState(rupees(initial?.listing?.mrpPaise));
  const [price, setPrice] = useState(rupees(initial?.listing?.pricePaise));
  const [stock, setStock] = useState(initial?.listing ? String(initial.listing.stockQty) : '');
  // Optional options / variants (Size, Pack Size, Color, Storage…).
  const [options, setOptions] = useState<VariantEditorState>(() => editorFromVariants(saved?.optionGroups ?? [], saved?.variants ?? []));
  const [initialOptions] = useState(() => JSON.stringify(options));
  const hadOptions = (saved?.optionGroups.length ?? 0) > 0;
  const optionsLocked = saved?.latestApproval?.status === 'PENDING';
  // Products saved this session with "Save & add another".
  const [addedCount, setAddedCount] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [step, setStep] = useState<'creating' | 'submitting' | 'saving' | null>(null);
  const [addingSub, setAddingSub] = useState(false);
  const [addingTop, setAddingTop] = useState(false);
  // Images: while creating, files wait here (previews only) until the product
  // exists; while editing, every change goes straight to the server.
  const [pendingFiles, setPendingFiles] = useState<{ id: string; file: File; preview: string }[]>([]);
  const [imageBusy, setImageBusy] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const refreshProducts = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
      saved ? queryClient.invalidateQueries({ queryKey: [...sellerKeys.products, saved.id] }) : Promise.resolve(),
    ]);

  const imageCount = saved ? saved.images.length : pendingFiles.length;

  function preview(file: File): string {
    const url = URL.createObjectURL(file);
    previews.current.push(url);
    return url;
  }

  function pickFiles(files: FileList | null): void {
    setImageError(null);
    const chosen = Array.from(files ?? []);
    const room = MAX_PRODUCT_IMAGES - imageCount;
    if (chosen.length > room) setImageError(`A product can have at most ${MAX_PRODUCT_IMAGES} images — only the first ${Math.max(0, room)} were added.`);
    const accepted: File[] = [];
    for (const file of chosen.slice(0, Math.max(0, room))) {
      const invalid = validateImage(file);
      if (invalid) {
        setImageError(`${file.name}: ${invalid}`);
        continue;
      }
      accepted.push(file);
    }
    if (saved) {
      void addImages(accepted);
    } else {
      setPendingFiles((list) => [...list, ...accepted.map((file, index) => ({ id: `${Date.now()}-${list.length + index}`, file, preview: preview(file) }))]);
    }
  }

  async function run(label: string, action: () => Promise<SellerProductDto | void>): Promise<void> {
    if (!saved) return;
    setImageError(null);
    setImageBusy(label);
    try {
      const next = await action();
      if (next) setSaved(next);
    } catch (error) {
      setImageError(error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message);
    } finally {
      setImageBusy(null);
      await refreshProducts();
    }
  }

  const addImages = (files: File[]) =>
    run('Uploading…', async () => {
      let latest: SellerProductDto | undefined;
      for (const file of files) {
        const key = await uploadSellerImage(file);
        latest = await sellerApi.post<SellerProductDto>(`/seller/products/${saved!.id}/images`, { key });
        setSaved(latest);
      }
      return latest;
    });

  function replace(index: number, file: File): void {
    const invalid = validateImage(file);
    if (invalid) return setImageError(`${file.name}: ${invalid}`);
    if (!saved) {
      setPendingFiles((list) => list.map((item, i) => (i === index ? { ...item, file, preview: preview(file) } : item)));
      return;
    }
    const imageId = saved.images[index]!.id;
    void run('Replacing…', async () => {
      const key = await uploadSellerImage(file);
      return sellerApi.patch<SellerProductDto>(`/seller/products/${saved.id}/images/${imageId}`, { key });
    });
  }

  const reorder = (order: string[]) =>
    run('Saving…', () => sellerApi.put<SellerProductDto>(`/seller/products/${saved!.id}/images/order`, { imageIds: order }));

  const galleryItems: GalleryItem[] = saved
    ? saved.images.map((image) => ({ id: image.id, src: imageSrc(image.thumbUrl ?? image.url) ?? '' }))
    : pendingFiles.map((pending) => ({ id: pending.id, src: pending.preview }));

  // "Add product" from a category or subcategory on the Categories page.
  useEffect(() => {
    if (!preset || parentId || !catalog.data) return;
    for (const top of catalog.data.categories) {
      if (top.id === preset) return setParentId(top.id);
      if (top.subcategories.some((sub) => sub.id === preset)) {
        setParentId(top.id);
        return setChildId(preset);
      }
    }
  }, [preset, parentId, catalog.data]);

  const parent = (catalog.data?.categories ?? []).find((c) => c.id === parentId);
  // Offer active subcategories, plus the one already chosen even if it was switched off since.
  const children = (parent?.subcategories ?? []).filter((c) => c.isActive || c.id === childId);

  function validate(): CreateSellerProductRequest | string {
    const categoryId = childId || parentId;
    if (!categoryId) return 'Choose a category.';
    const trimmedName = name.trim();
    if (trimmedName.length < PRODUCT_LIMITS.name.min) return 'Enter the product name (at least 2 characters).';
    if (options.enabled) {
      // Every variant carries its own SKU, MRP, price and stock (variantEditor).
      const set = variantSetFromEditor(options, false);
      if (typeof set === 'string') return set;
      return {
        categoryId,
        name: trimmedName,
        ...(nameHi.trim() ? { nameHi: nameHi.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        optionGroups: set.optionGroups,
        variants: set.variants,
      };
    }
    const trimmedSku = sku.trim();
    if (trimmedSku.length < PRODUCT_LIMITS.sku.min) return 'Enter a SKU (at least 2 characters).';
    const trimmedVariant = variantName.trim();
    if (trimmedVariant.length < PRODUCT_LIMITS.variantName.min) return 'Enter the variant, e.g. "1 kg" or "500 ml".';
    const value = Number(unitValue);
    if (!unitValue.trim() || !Number.isFinite(value) || value <= 0) return 'Unit value must be a number greater than 0.';
    const mrpPaise = toPaise(mrp);
    if (mrpPaise === null) return 'Enter the MRP (greater than 0).';
    const pricePaise = toPaise(price);
    if (pricePaise === null) return 'Enter the selling price (greater than 0).';
    if (pricePaise > mrpPaise) return 'Selling price cannot be higher than MRP.';
    const stockQty = toStock(stock);
    if (stockQty === null) return STOCK_RULE;
    return {
      categoryId,
      name: trimmedName,
      ...(nameHi.trim() ? { nameHi: nameHi.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      sku: trimmedSku,
      variantName: trimmedVariant,
      unit,
      unitValue: value,
      mrpPaise,
      pricePaise,
      stockQty,
    };
  }

  /** After "Save & add another": a fresh form that keeps the category and pack unit. */
  function resetForNext(): void {
    setName('');
    setNameHi('');
    setDescription('');
    setSku('');
    setVariantName('');
    setUnitValue('1');
    setMrp('');
    setPrice('');
    setStock('');
    setOptions(editorFromVariants([], []));
    setPendingFiles([]);
  }

  async function create(addAnother: boolean): Promise<void> {
    const request = validate();
    if (typeof request === 'string') return setProblem(request);
    setProblem(null);
    setSavedNote(null);

    setStep('creating');
    let created: CreatedSellerProduct;
    try {
      created = await sellerApi.post<CreatedSellerProduct>('/seller/products', request);
    } catch (error) {
      setStep(null);
      // SKU is the only unique field a new product can collide on.
      setProblem(
        error instanceof ApiRequestError && error.status === 409
          ? 'This SKU is already used by another product. Choose a different SKU.'
          : sellerErrorMessage(error),
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: sellerKeys.products });

    // Images in gallery order, so the ★ Main one is uploaded first.
    for (const pending of pendingFiles) {
      try {
        const key = await uploadSellerImage(pending.file);
        await sellerApi.post(`/seller/products/${created.id}/images`, { key });
      } catch (error) {
        setStep(null);
        await queryClient.invalidateQueries({ queryKey: sellerKeys.products });
        const reason = error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message;
        onDone({
          ok: false,
          text: `"${request.name}" was saved as a draft, but an image could not be uploaded (${reason}). Open the product to add images before you submit it for approval.`,
        });
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: sellerKeys.products });
    setStep(null);

    if (addAnother) {
      setAddedCount((count) => count + 1);
      setSavedNote(`"${request.name}" saved as a draft. Add the next product.`);
      resetForNext();
      return;
    }
    onDone({
      ok: true,
      text: `"${request.name}" saved as Ready for Submission. Select your products and use “Submit Selected for Approval” to send them for review together.`,
    });
  }

  async function save(): Promise<void> {
    if (!saved) return;
    const request = validate();
    if (typeof request === 'string') return setProblem(request);
    const { optionGroups, variants, ...content } = request;
    const changes = productChanges(content, saved);
    const optionsChanged = JSON.stringify(options) !== initialOptions;
    setProblem(null);
    if (Object.keys(changes).length === 0 && !optionsChanged) return setSavedNote('Nothing to save — no changes.');
    setSavedNote(null);
    setStep('saving');
    try {
      let updated = saved;
      if (Object.keys(changes).length > 0) updated = await sellerApi.patch<SellerProductDto>(`/seller/products/${saved.id}`, changes);
      if (optionsChanged && optionGroups && variants) {
        updated = await sellerApi.put<SellerProductDto>(`/seller/products/${saved.id}/variants`, { optionGroups, variants });
      } else if (optionsChanged && hadOptions) {
        // Options switched off: back to one (the default) variant with the simple fields.
        updated = await sellerApi.put<SellerProductDto>(`/seller/products/${saved.id}/variants`, {
          optionGroups: [],
          variants: [
            {
              id: saved.variants[0]!.id,
              variantName: content.variantName,
              sku: content.sku,
              unit: content.unit,
              unitValue: content.unitValue,
              pricePaise: content.pricePaise!,
              mrpPaise: content.mrpPaise,
              stockQty: content.stockQty,
            },
          ],
        });
      }
      setSaved(updated);
      setSku(updated.defaultVariant?.sku ?? sku);
      setSavedNote(
        updated.approvalStatus === 'APPROVED'
          ? updated.variants.some((v) => v.approvalStatus === 'PENDING')
            ? 'Changes saved and live. New options wait for Aadione’s approval — submit them from Products.'
            : 'Changes saved and live.'
          : updated.approvalStatus === 'REJECTED'
            ? 'Changes saved. It stays rejected until you resubmit it for approval.'
            : 'Changes saved. It goes for review with your next “Submit for Approval”.',
      );
    } catch (error) {
      setProblem(sellerErrorMessage(error));
    } finally {
      setStep(null);
      await refreshProducts();
    }
  }

  async function submitForReview(): Promise<void> {
    if (!saved) return;
    setProblem(null);
    setSavedNote(null);
    setStep('submitting');
    try {
      await sellerApi.post('/seller/approval-batches', { productIds: [saved.id] });
    } catch (error) {
      setStep(null);
      setProblem(sellerErrorMessage(error));
      await refreshProducts();
      return;
    }
    await refreshProducts();
    onDone({ ok: true, text: `"${saved.name}" was submitted for approval.` });
  }

  const busy = step !== null;
  const loadingSource = availability.isPending || catalog.isPending;
  const sourceError = availability.error ?? catalog.error;
  const current = validate();
  const dirty =
    saved !== null && (typeof current === 'string' || Object.keys(productChanges(current, saved)).length > 0 || JSON.stringify(options) !== initialOptions);
  const rejection = saved ? rejectionOf(saved) : null;
  const noCategories = catalog.data !== undefined && catalog.data.categories.length === 0;
  const galleryDisabled = busy || imageBusy !== null;
  const chosenSub = children.find((c) => c.id === childId);

  return (
    <Modal
      wide
      title={!saved ? 'Add Product' : saved.approvalStatus === 'REJECTED' ? 'Edit & Resubmit' : 'Edit Product'}
      subtitle={
        !saved
          ? `Add complete product information including price and stock. Aadione will review your product before it goes live.${addedCount > 0 ? ` (${addedCount} added so far)` : ''}`
          : saved.name
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        !saved ? (
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="secondary" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => void create(true)} disabled={busy || loadingSource || noCategories} className="w-full sm:w-auto">
              Save &amp; Add Another
            </Button>
            <Button onClick={() => void create(false)} disabled={busy || loadingSource || noCategories} className="w-full sm:w-auto">
              {step === 'creating' ? 'Saving…' : 'Save Product'}
            </Button>
          </div>
        ) : (
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="secondary" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
              Close
            </Button>
            <Button variant="secondary" onClick={() => void save()} disabled={busy || loadingSource} className="w-full sm:w-auto">
              {step === 'saving' ? 'Saving…' : 'Save changes'}
            </Button>
            {saved.approvalStatus === 'REJECTED' && (
              <Button onClick={() => void submitForReview()} disabled={busy || dirty || loadingSource} className="w-full sm:w-auto">
                {step === 'submitting' ? 'Resubmitting…' : 'Resubmit for approval'}
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="space-y-5">
        {rejection !== null && saved?.approvalStatus === 'REJECTED' && (
          <div className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-sm text-danger-600">
            <span className="font-semibold">Rejection reason:</span> {rejection}
          </div>
        )}
        <ErrorBanner message={problem} />
        {savedNote && (
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
            {savedNote}
          </div>
        )}
        {saved && dirty && saved.approvalStatus === 'REJECTED' && (
          <p className="text-xs text-gray-500">Save your changes before resubmitting for approval.</p>
        )}

        {/* 1. images */}
        <ImageGallery
          items={galleryItems}
          disabled={galleryDisabled}
          busyLabel={imageBusy}
          onPick={pickFiles}
          onMakeMain={(index) =>
            saved ? void reorder(moved(saved.images.map((image) => image.id), index, 0)) : setPendingFiles((list) => moved(list, index, 0))
          }
          onMove={(index, direction) =>
            saved
              ? void reorder(moved(saved.images.map((image) => image.id), index, index + direction))
              : setPendingFiles((list) => moved(list, index, index + direction))
          }
          onRemove={(index) =>
            saved
              ? void run('Removing…', () => sellerApi.delete<SellerProductDto>(`/seller/products/${saved.id}/images/${saved.images[index]!.id}`))
              : setPendingFiles((list) => list.filter((_, i) => i !== index))
          }
          onReplace={replace}
        />
        {imageError && <ErrorBanner message={imageError} />}

        {/* 2–3. name, description */}
        <Field label="Product name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={PRODUCT_LIMITS.name.max} className={inputClass} placeholder="e.g. Boat Airdopes 141" />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={PRODUCT_LIMITS.description.max} rows={3} className={inputClass} />
        </Field>

        {/* 4–5. category, subcategory */}
        {loadingSource ? (
          <Spinner label="Loading categories…" />
        ) : sourceError ? (
          <ErrorBanner message={sellerErrorMessage(sourceError)} />
        ) : noCategories ? (
          <div className="space-y-2">
            <p className="rounded-xl bg-warn-50 px-3.5 py-3 text-sm text-gray-700">
              You have no categories yet. Create a top category (for example “Grocery”) to put this product in — you can add
              subcategories later.
            </p>
            <NewTopCategoryForm
              onCreated={(id) => {
                setParentId(id);
                setChildId('');
              }}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" required>
                <select
                  value={parentId}
                  onChange={(event) => {
                    setParentId(event.target.value);
                    setChildId('');
                    setAddingSub(false);
                  }}
                  className={inputClass}
                >
                  <option value="">Choose a category…</option>
                  {(catalog.data?.categories ?? []).map((category) => (
                    <option key={category.id} value={category.id} disabled={!category.isActive}>
                      {category.name}
                      {category.isActive ? '' : ' (inactive)'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Subcategory" hint={parent && children.length === 0 ? 'No subcategories yet — add one below, or list under the category itself.' : undefined}>
                <select value={childId} onChange={(event) => setChildId(event.target.value)} disabled={!parent || children.length === 0} className={inputClass}>
                  <option value="">{parent ? 'None (the category itself)' : 'Choose a category first'}</option>
                  {children.map((child) => (
                    <option key={child.id} value={child.id} disabled={!child.isActive}>
                      {child.name}
                      {child.isActive ? '' : ' (inactive)'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {addingTop ? (
              <NewTopCategoryForm
                onCreated={(id) => {
                  setParentId(id);
                  setChildId('');
                  setAddingTop(false);
                }}
                onCancel={() => setAddingTop(false)}
              />
            ) : (
              <button type="button" onClick={() => setAddingTop(true)} className="mr-4 text-sm font-semibold text-brand-600 transition hover:text-brand-700">
                + New top category
              </button>
            )}
            {parent &&
              (addingSub ? (
                <NewSubcategoryForm
                  parentId={parent.id}
                  parentName={parent.name}
                  onCreated={(sub) => {
                    setChildId(sub.id);
                    setAddingSub(false);
                  }}
                  onCancel={() => setAddingSub(false)}
                />
              ) : (
                <button type="button" onClick={() => setAddingSub(true)} className="text-sm font-semibold text-brand-600 transition hover:text-brand-700">
                  + New subcategory in {parent.name}
                </button>
              ))}
          </div>
        )}

            {!options.enabled && (
              <>
            {/* 6–7. identifiers + pack size */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SKU" required hint="Your unique product code. Saved in capital letters.">
                <input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={PRODUCT_LIMITS.sku.max} className={inputClass} autoCapitalize="characters" />
              </Field>
              <Field label="Variant name" required hint='For example "1 kg", "500 ml" or "Black, 128 GB".'>
                <input value={variantName} onChange={(e) => setVariantName(e.target.value)} maxLength={PRODUCT_LIMITS.variantName.max} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Unit" required>
                <select value={unit} onChange={(e) => setUnit(e.target.value as UnitType)} className={inputClass}>
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Unit value" required>
                <input value={unitValue} onChange={(e) => setUnitValue(e.target.value)} inputMode="decimal" className={inputClass} />
              </Field>
            </div>

            {/* 8–9. price & stock — part of the product, reviewed with it */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="MRP (₹)" required>
                <input value={mrp} onChange={(e) => setMrp(e.target.value)} inputMode="decimal" className={inputClass} />
              </Field>
              <Field label="Selling price (₹)" required hint="Not above MRP.">
                <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={inputClass} />
              </Field>
              <div className="col-span-2 sm:col-span-1">
                <Field label={saved?.listing ? 'Stock' : 'Opening stock'} required hint={`0 to ${LISTING_MAX_STOCK.toLocaleString('en-IN')}.`}>
                  <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" className={inputClass} />
                </Field>
              </div>
            </div>
            <p className="-mt-2 text-xs text-gray-500">Customers see this product only after Aadione approves it. Your price and stock stay exactly as you set them.</p>

              </>
            )}

            <VariantEditor state={options} onChange={setOptions} food={false} disabled={busy || optionsLocked} />
            {optionsLocked && <p className="-mt-3 text-xs text-gray-500">Options can be changed again once Aadione’s review is done.</p>}

            {/* 10. other fields */}
            <Field label="Hindi name">
              <input value={nameHi} onChange={(e) => setNameHi(e.target.value)} maxLength={PRODUCT_LIMITS.nameHi.max} className={inputClass} />
            </Field>


        {/* 11. preview */}
        <section aria-label="Preview" className="space-y-2">
          <p className="text-sm font-medium text-gray-800">Preview</p>
          <div className="flex items-center gap-3 rounded-xl border border-gray-200 p-3">
            <ProductImage src={galleryItems[0]?.src ?? null} alt="Main image preview" />
            <div className="min-w-0">
              <p className="line-clamp-2 font-semibold text-gray-900">{name.trim() || 'Product name'}</p>
              <p className="truncate text-xs text-gray-500">
                {[parent?.name ?? 'Category', chosenSub?.name].filter(Boolean).join(' › ')}
              </p>
              <p className="truncate text-xs text-gray-500">
                {[variantName.trim(), `${unitValue || '1'} ${UNIT_SHORT[unit] ?? unit}`].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}

/** POST /seller/categories — a new top category owned by this seller. */
function NewTopCategoryForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { name: string }) => sellerApi.post<SellerCatalogCategories>('/seller/categories', body),
  });

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return setError('Enter a category name (at least 2 characters).');
    setError(null);
    try {
      const tree = await create.mutateAsync({ name: trimmed });
      queryClient.setQueryData(sellerKeys.catalogCategories, tree);
      const createdId = tree.categories.find((c) => c.name === trimmed)?.id;
      if (createdId) onCreated(createdId);
    } catch (err) {
      setError(sellerErrorMessage(err));
    }
  }

  return (
    <div className="space-y-2 rounded-xl bg-gray-50 p-3">
      <label htmlFor="new-top-category" className="block text-sm font-medium text-gray-700">
        New top category
      </label>
      <input id="new-top-category" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Grocery" className={inputClass} />
      <div className="flex gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={create.isPending} className="flex-1 sm:flex-none">
            Cancel
          </Button>
        )}
        <Button variant="soft" onClick={() => void submit()} disabled={create.isPending} className="flex-1 sm:flex-none">
          {create.isPending ? 'Creating…' : 'Create category'}
        </Button>
      </div>
      <ErrorBanner message={error} />
    </div>
  );
}

/** POST /seller/subcategories under one of the seller's own top categories. */
function NewSubcategoryForm({
  parentId,
  parentName,
  onCreated,
  onCancel,
}: {
  parentId: string;
  parentName: string;
  onCreated: (subcategory: SellerSubcategory) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { parentId: string; name: string }) => sellerApi.post<SellerSubcategory>('/seller/subcategories', body),
  });

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return setError('Enter a subcategory name (at least 2 characters).');
    setError(null);
    try {
      const created = await create.mutateAsync({ parentId, name: trimmed });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sellerKeys.catalogCategories }),
        queryClient.invalidateQueries({ queryKey: sellerKeys.subcategories }),
      ]);
      onCreated(created);
    } catch (err) {
      setError(sellerErrorMessage(err));
    }
  }

  return (
    <div className="space-y-2 rounded-xl bg-gray-50 p-3">
      <label htmlFor="new-subcategory" className="block text-sm font-medium text-gray-700">
        New subcategory in {parentName}
      </label>
      <input id="new-subcategory" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Earphones" className={inputClass} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={create.isPending} className="flex-1 sm:flex-none">
          Cancel
        </Button>
        <Button variant="soft" onClick={() => void submit()} disabled={create.isPending} className="flex-1 sm:flex-none">
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
      <ErrorBanner message={error} />
    </div>
  );
}

/** POST /seller/listings — price + stock for an older product saved without them. */
export function StartSellingModal({
  product,
  onClose,
  onDone,
}: {
  product: Pick<SellerProductDto, 'id' | 'name' | 'defaultVariant'>;
  onClose: () => void;
  onDone: (result: Notice) => void;
}) {
  const queryClient = useQueryClient();
  const [mrp, setMrp] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [available, setAvailable] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateSellerListingRequest) => sellerApi.post('/seller/listings', body),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings }),
    ]);

  async function submit(): Promise<void> {
    const variantId = product.defaultVariant?.id;
    if (!variantId) return setProblem('This product has no variant to sell.');
    if (!mrp.trim() || !price.trim() || !stock.trim()) return setProblem('Fill in the MRP, selling price and stock.');
    const mrpPaise = toPaise(mrp);
    if (mrpPaise === null) return setProblem('Enter a valid MRP greater than 0.');
    const pricePaise = toPaise(price);
    if (pricePaise === null) return setProblem('Enter a valid selling price greater than 0.');
    if (pricePaise > mrpPaise) return setProblem('Selling price cannot be higher than MRP.');
    const stockQty = toStock(stock);
    if (stockQty === null) return setProblem(STOCK_RULE);
    setProblem(null);

    try {
      await create.mutateAsync({ variantId, mrpPaise, pricePaise, stockQty, isAvailable: available });
    } catch (error) {
      setProblem(sellerErrorMessage(error));
      // A listing made elsewhere meanwhile: show the real state.
      if (error instanceof ApiRequestError && error.status === 409) await refresh();
      return;
    }
    await refresh();
    onDone({ ok: true, text: `Price and stock saved for "${product.name}".` });
  }

  const variant = product.defaultVariant;

  return (
    <Modal
      title="Add price & stock"
      subtitle={[product.name, variant?.variantName].filter(Boolean).join(' · ')}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending} className="w-full sm:w-auto">
            {create.isPending ? 'Saving…' : 'Save price & stock'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={problem} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="MRP (₹)" required>
            <input value={mrp} onChange={(e) => setMrp(e.target.value)} inputMode="decimal" className={inputClass} />
          </Field>
          <Field label="Selling price (₹)" required hint="Not above MRP.">
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={inputClass} />
          </Field>
        </div>
        <Field label="Stock" required hint={`Units on hand, 0 to ${LISTING_MAX_STOCK.toLocaleString('en-IN')}.`}>
          <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" className={inputClass} />
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-3.5 py-3">
          <div>
            <p className="text-sm font-medium text-gray-800">Available to customers</p>
            <p className="text-xs text-gray-500">Switch off to list it without selling yet.</p>
          </div>
          <Toggle checked={available} onChange={setAvailable} label="Available to customers" />
        </div>
      </div>
    </Modal>
  );
}
