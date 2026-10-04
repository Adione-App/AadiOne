/**
 * The restaurant / cafe FOOD ITEM form — its own form, not the marketplace
 * product form with fields hidden. A food item is:
 *
 *   name · description · menu · menu section · selling price · photos ·
 *   veg / non-veg · available
 *
 * and nothing else: no MRP, no opening stock, no SKU, no pack unit (the
 * backend fills the internal variant in and keeps the listing made to order).
 *
 *   create   POST /seller/products (+ photos)          — a draft, like every new item
 *   edit     PATCH /seller/products/:id                — while not approved / not in review
 *            PATCH /seller/listings/:id                — price and availability, any time
 *
 * Approval is unchanged: new items go to Aadione in a batch ("Submit Selected
 * for Approval" on Products). An approved item keeps its name, description,
 * photos and section; its price and availability stay the seller's to change.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FoodDiet } from '@shared';
import { ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { validateImage } from '@/lib/upload';
import { Button, ErrorBanner, Field, Modal, Spinner, Toggle, inputClass } from '@/components/ui';
import {
  MAX_PRODUCT_IMAGES,
  PRODUCT_LIMITS,
  sellerApi,
  sellerErrorMessage,
  uploadSellerImage,
  type CreatedSellerProduct,
  type SellerCatalogCategories,
  type SellerProductInventory,
} from './sellerApi';
import { sellerKeys } from './sellerQueries';
import { ImageGallery, isEditable, moved, toPaise, type GalleryItem, type Notice } from './productUi';

export type FoodItemFormMode = { kind: 'create'; sectionId?: string } | { kind: 'edit'; item: SellerProductInventory };

const rupees = (paise: number | undefined): string => (paise === undefined ? '' : String(paise / 100));

export function FoodItemModal({ mode, onClose, onDone }: { mode: FoodItemFormMode; onClose: () => void; onDone: (result: Notice) => void }) {
  const queryClient = useQueryClient();
  const item = mode.kind === 'edit' ? mode.item : null;
  // Content (name, description, section, photos, veg) is editable until approval;
  // price and availability always are.
  const contentEditable = item === null || isEditable(item);

  const menu = useQuery({
    queryKey: sellerKeys.catalogCategories,
    queryFn: () => sellerApi.get<SellerCatalogCategories>('/seller/categories'),
  });
  const menus = menu.data?.categories ?? [];

  const initialSection = item?.categoryId ?? (mode.kind === 'create' ? (mode.sectionId ?? '') : '');
  const [menuId, setMenuId] = useState('');
  const [sectionId, setSectionId] = useState(initialSection);
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState(rupees(item?.listing?.pricePaise));
  const [diet, setDiet] = useState<FoodDiet | ''>(item?.diet ?? '');
  const [available, setAvailable] = useState(item?.listing?.isAvailable ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  // Photos: while creating they wait here until the item exists.
  const [pendingFiles, setPendingFiles] = useState<{ id: string; file: File; preview: string }[]>([]);
  const [images, setImages] = useState(item?.images ?? []);
  const [imageBusy, setImageBusy] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  // The menu follows the chosen section (and the other way round).
  useEffect(() => {
    if (menuId || !sectionId) return;
    const owner = menus.find((m) => m.subcategories.some((s) => s.id === sectionId));
    if (owner) setMenuId(owner.id);
  }, [menus, menuId, sectionId]);
  const sections = (menus.find((m) => m.id === menuId)?.subcategories ?? []).filter((s) => s.isActive || s.id === sectionId);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.catalogCategories }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.menuSections }),
    ]);

  function preview(file: File): string {
    const url = URL.createObjectURL(file);
    previews.current.push(url);
    return url;
  }

  async function imageAction(label: string, action: () => Promise<SellerProductInventory>): Promise<void> {
    setImageError(null);
    setImageBusy(label);
    try {
      setImages((await action()).images);
    } catch (error) {
      setImageError(error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message);
    } finally {
      setImageBusy(null);
      await refresh();
    }
  }

  function pickFiles(files: FileList | null): void {
    setImageError(null);
    const room = MAX_PRODUCT_IMAGES - (item ? images.length : pendingFiles.length);
    const accepted: File[] = [];
    for (const file of Array.from(files ?? []).slice(0, Math.max(0, room))) {
      const invalid = validateImage(file);
      if (invalid) setImageError(`${file.name}: ${invalid}`);
      else accepted.push(file);
    }
    if (item) {
      void imageAction('Uploading…', async () => {
        let latest: SellerProductInventory | undefined;
        for (const file of accepted) {
          const key = await uploadSellerImage(file);
          latest = await sellerApi.post<SellerProductInventory>(`/seller/products/${item.id}/images`, { key });
        }
        return latest ?? item;
      });
    } else {
      setPendingFiles((list) => [...list, ...accepted.map((file, index) => ({ id: `${Date.now()}-${list.length + index}`, file, preview: preview(file) }))]);
    }
  }

  const gallery: GalleryItem[] = item
    ? images.map((image) => ({ id: image.id, src: imageSrc(image.thumbUrl ?? image.url) ?? '' }))
    : pendingFiles.map((pending) => ({ id: pending.id, src: pending.preview }));
  const reorder = (order: string[]) =>
    imageAction('Saving…', () => sellerApi.put<SellerProductInventory>(`/seller/products/${item!.id}/images/order`, { imageIds: order }));

  function check(): string | null {
    if (!sectionId) return 'Choose a menu and a menu section.';
    if (name.trim().length < PRODUCT_LIMITS.name.min) return 'Enter the food item name (at least 2 characters).';
    if (toPaise(price) === null) return 'Enter the selling price (greater than 0).';
    return null;
  }

  async function create(addAnother: boolean): Promise<void> {
    const invalid = check();
    if (invalid) return setProblem(invalid);
    setProblem(null);
    setSavedNote(null);
    setBusy(true);
    const trimmed = name.trim();
    try {
      const created = await sellerApi.post<CreatedSellerProduct>('/seller/products', {
        categoryId: sectionId,
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        pricePaise: toPaise(price)!,
        diet: diet || null,
        isAvailable: available,
      });
      for (const pending of pendingFiles) {
        const key = await uploadSellerImage(pending.file);
        await sellerApi.post(`/seller/products/${created.id}/images`, { key });
      }
      await refresh();
      if (addAnother) {
        setAddedCount((count) => count + 1);
        setSavedNote(`"${trimmed}" saved. Add the next food item.`);
        setName('');
        setDescription('');
        setPrice('');
        setDiet('');
        setAvailable(true);
        setPendingFiles([]);
        return;
      }
      onDone({ ok: true, text: `"${trimmed}" added to your menu. Submit it for approval from Products when you are ready.` });
    } catch (error) {
      setProblem(sellerErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!item) return;
    const invalid = check();
    if (invalid) return setProblem(invalid);
    setProblem(null);
    setSavedNote(null);
    setBusy(true);
    const pricePaise = toPaise(price)!;
    try {
      if (contentEditable) {
        const changes = {
          ...(name.trim() !== item.name ? { name: name.trim() } : {}),
          ...((description.trim() || null) !== (item.description ?? null) ? { description: description.trim() || null } : {}),
          ...(sectionId !== item.categoryId ? { categoryId: sectionId } : {}),
          ...((diet || null) !== item.diet ? { diet: diet || null } : {}),
          ...(item.listing && pricePaise !== item.listing.pricePaise ? { pricePaise } : {}),
        };
        if (Object.keys(changes).length > 0) await sellerApi.patch(`/seller/products/${item.id}`, changes);
      } else if (item.listing && pricePaise !== item.listing.pricePaise) {
        await sellerApi.patch(`/seller/listings/${item.listing.id}`, { pricePaise });
      }
      if (item.listing && available !== item.listing.isAvailable) {
        await sellerApi.patch(`/seller/listings/${item.listing.id}`, { isAvailable: available });
      }
      await refresh();
      onDone({ ok: true, text: `"${name.trim()}" saved.` });
    } catch (error) {
      setProblem(sellerErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const noSections = menus.every((m) => m.subcategories.length === 0);

  return (
    <Modal
      wide
      title={item ? 'Edit Food Item' : 'Add Food Item'}
      subtitle={
        item
          ? item.name
          : `Add a dish with its selling price. Aadione reviews new items before they appear on your menu.${addedCount > 0 ? ` (${addedCount} added so far)` : ''}`
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
            Cancel
          </Button>
          {item ? (
            <Button onClick={() => void save()} disabled={busy || menu.isPending} className="w-full sm:w-auto">
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => void create(true)} disabled={busy || menu.isPending || noSections} className="w-full sm:w-auto">
                Save &amp; Add Another
              </Button>
              <Button onClick={() => void create(false)} disabled={busy || menu.isPending || noSections} className="w-full sm:w-auto">
                {busy ? 'Saving…' : 'Save Food Item'}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <ErrorBanner message={problem} />
        {savedNote && (
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
            {savedNote}
          </div>
        )}
        {!contentEditable && (
          <p className="rounded-xl bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">
            {item?.approvalStatus === 'APPROVED'
              ? 'This item is approved: its name, description, photos, section and veg mark are fixed. You can change its price and availability.'
              : 'This item is being reviewed by Aadione. You can change its price and availability now; other details once the review is done.'}
          </p>
        )}

        <ImageGallery
          label="Photos"
          items={gallery}
          disabled={busy || imageBusy !== null}
          readOnly={!contentEditable}
          busyLabel={imageBusy}
          onPick={pickFiles}
          onMakeMain={(index) =>
            item ? void reorder(moved(images.map((image) => image.id), index, 0)) : setPendingFiles((list) => moved(list, index, 0))
          }
          onMove={(index, direction) =>
            item ? void reorder(moved(images.map((image) => image.id), index, index + direction)) : setPendingFiles((list) => moved(list, index, index + direction))
          }
          onRemove={(index) =>
            item
              ? void imageAction('Removing…', () => sellerApi.delete<SellerProductInventory>(`/seller/products/${item.id}/images/${images[index]!.id}`))
              : setPendingFiles((list) => list.filter((_, i) => i !== index))
          }
          onReplace={(index, file) => {
            const invalid = validateImage(file);
            if (invalid) return setImageError(`${file.name}: ${invalid}`);
            if (!item) return setPendingFiles((list) => list.map((p, i) => (i === index ? { ...p, file, preview: preview(file) } : p)));
            void imageAction('Replacing…', async () => {
              const key = await uploadSellerImage(file);
              return sellerApi.patch<SellerProductInventory>(`/seller/products/${item.id}/images/${images[index]!.id}`, { key });
            });
          }}
        />
        {imageError && <ErrorBanner message={imageError} />}

        <Field label="Food item name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={PRODUCT_LIMITS.name.max}
            disabled={!contentEditable}
            className={inputClass}
            placeholder="e.g. Dal Tadka"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={PRODUCT_LIMITS.description.max}
            rows={3}
            disabled={!contentEditable}
            className={inputClass}
            placeholder="e.g. Yellow lentils tempered with ghee and cumin"
          />
        </Field>

        {menu.isPending ? (
          <Spinner label="Loading your menu…" />
        ) : menu.isError ? (
          <ErrorBanner message={sellerErrorMessage(menu.error)} />
        ) : noSections ? (
          <p className="rounded-xl bg-warn-50 px-3.5 py-3 text-sm text-gray-700">
            Add a menu and a menu section first (Menu page → “Add Menu”, then “Add Menu Section”).
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Menu" required>
              <select
                value={menuId}
                disabled={!contentEditable}
                onChange={(event) => {
                  setMenuId(event.target.value);
                  setSectionId('');
                }}
                className={inputClass}
              >
                <option value="">Choose a menu…</option>
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.isActive ? '' : ' (hidden)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Menu section" required>
              <select value={sectionId} disabled={!contentEditable || !menuId} onChange={(event) => setSectionId(event.target.value)} className={inputClass}>
                <option value="">{menuId ? 'Choose a section…' : 'Choose a menu first'}</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isActive ? '' : ' (hidden)'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Selling price (₹)" required>
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={inputClass} placeholder="e.g. 120" />
          </Field>
          <Field label="Veg / Non-veg">
            <select value={diet} disabled={!contentEditable} onChange={(e) => setDiet(e.target.value as FoodDiet | '')} className={inputClass}>
              <option value="">Not specified</option>
              <option value="VEG">Veg</option>
              <option value="NON_VEG">Non-veg</option>
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3.5 py-3">
          <div>
            <p className="text-sm font-medium text-gray-800">Available</p>
            <p className="text-xs text-gray-500">Switch it off when the kitchen can’t make it. Food items are made to order — there is no stock count.</p>
          </div>
          <Toggle checked={available} onChange={setAvailable} label="Available to customers" />
        </div>
      </div>
    </Modal>
  );
}
