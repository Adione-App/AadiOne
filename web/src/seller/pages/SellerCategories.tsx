/**
 * Seller Categories — mobile-first. The seller's OWN catalogue structure:
 * top categories (GET/POST/PATCH /seller/categories, image via
 * POST /seller/categories/:id/image) and the subcategories inside them
 * (POST/PATCH /seller/subcategories, image via
 * POST /seller/subcategories/:id/image). Every seller — Aadione included —
 * builds its own; nobody else can see or change them here. The backend
 * enforces ownership on every write.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Pill, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import {
  sellerApi,
  sellerErrorMessage,
  uploadSellerImage,
  type SellerCatalogCategories,
  type SellerCatalogCategory,
  type SellerCatalogSubcategoryRef,
  type SellerSubcategory,
} from '../sellerApi';
import { sellerKeys, useSellerAvailability } from '../sellerQueries';

type Notice = { ok: boolean; text: string };

/** What a rename/create modal is working on. */
type Editing =
  | { kind: 'new-top' }
  | { kind: 'rename-top'; category: SellerCatalogCategory }
  | { kind: 'new-sub'; parent: SellerCatalogCategory }
  | { kind: 'rename-sub'; parent: SellerCatalogCategory; sub: SellerCatalogSubcategoryRef };

function CategoryImage({ src, alt, size = 'h-12 w-12' }: { src: string | null; alt: string; size?: string }) {
  const resolved = imageSrc(src);
  return resolved ? (
    <img src={resolved} alt={alt} loading="lazy" className={`${size} shrink-0 rounded-xl border border-gray-200 bg-white object-cover`} />
  ) : (
    <span className={`${size} flex shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-500`}>
      <Icon name="categories" className="h-5 w-5" />
    </span>
  );
}

function ImagePicker({
  label,
  src,
  busy,
  disabled,
  onFile,
  size,
}: {
  label: string;
  src: string | null;
  busy: boolean;
  disabled: boolean;
  onFile: (file: File | undefined) => void;
  size: string;
}) {
  return (
    <label className="relative shrink-0 cursor-pointer" aria-label={label}>
      <CategoryImage src={src} alt={label} size={size} />
      <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-white text-gray-600 shadow">
        <Icon name={busy ? 'clock' : 'upload'} className="h-3.5 w-3.5" />
      </span>
      <input
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </label>
  );
}

export default function SellerCategoriesPage() {
  const queryClient = useQueryClient();
  const isRestaurant = useSellerAvailability().data?.sellerType === 'RESTAURANT';
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [imageBusy, setImageBusy] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: sellerKeys.catalogCategories,
    queryFn: () => sellerApi.get<SellerCatalogCategories>('/seller/categories'),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.catalogCategories }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.subcategories }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
    ]);

  const toggle = useMutation({
    mutationFn: (input: { id: string; isActive: boolean; top: boolean }) =>
      input.top
        ? sellerApi.patch(`/seller/categories/${input.id}`, { isActive: input.isActive })
        : sellerApi.patch(`/seller/subcategories/${input.id}`, { isActive: input.isActive }),
    onError: (error) => setNotice({ ok: false, text: sellerErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  async function changeImage(target: { id: string; name: string; top: boolean }, file: File | undefined): Promise<void> {
    if (!file) return;
    setNotice(null);
    const invalid = validateImage(file);
    if (invalid) return setNotice({ ok: false, text: invalid });
    setImageBusy(target.id);
    try {
      const key = await uploadSellerImage(file);
      await sellerApi.post(`/seller/${target.top ? 'categories' : 'subcategories'}/${target.id}/image`, { key });
      setNotice({ ok: true, text: `Image updated for "${target.name}".` });
    } catch (error) {
      setNotice({ ok: false, text: sellerErrorMessage(error) });
    } finally {
      setImageBusy(null);
      await refresh();
    }
  }

  if (isRestaurant) {
    return (
      <div className="space-y-3">
        <EmptyState
          title="Restaurants use menu sections"
          hint="Your menu sections are your categories — manage them from Products → Menu sections."
        />
        <Link to="/seller/products" className="inline-flex text-sm font-semibold text-brand-600">
          Go to Products
        </Link>
      </div>
    );
  }

  const categories = catalog.data?.categories ?? [];

  return (
    <div className="space-y-5 pb-20 lg:pb-0">
      <section aria-label="Your categories" className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Your categories</h2>
          <p className="text-sm text-gray-500">
            Build your catalogue: top categories (e.g. Grocery), subcategories inside them (e.g. Atta, Rice &amp; Dal), then add products
            under them. Only you can see and change these.
          </p>
        </div>
        <Button onClick={() => setEditing({ kind: 'new-top' })} className="hidden shrink-0 sm:inline-flex">
          <Icon name="plus" className="h-4 w-4" /> New category
        </Button>
      </section>

      {notice &&
        (notice.ok ? (
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
            {notice.text}
          </div>
        ) : (
          <ErrorBanner message={notice.text} />
        ))}

      {catalog.isPending ? (
        <Spinner label="Loading categories…" />
      ) : catalog.isError ? (
        <ErrorBanner message={sellerErrorMessage(catalog.error)} />
      ) : categories.length === 0 ? (
        <div className="space-y-3">
          <EmptyState title="No categories yet" hint="Create your first top category — for example “Grocery” — then add subcategories and products under it." />
          <Button onClick={() => setEditing({ kind: 'new-top' })}>
            <Icon name="plus" className="h-4 w-4" /> Create a category
          </Button>
        </div>
      ) : (
        <ul className="space-y-4">
          {categories.map((top) => {
            const subProducts = top.subcategories.reduce((sum, sub) => sum + sub.productCount, 0);
            return (
              <li key={top.id}>
                <Surface className="space-y-3 p-3.5">
                  <div className="flex items-center gap-3">
                    <ImagePicker
                      label={`Change image of ${top.name}`}
                      src={top.imageUrl}
                      busy={imageBusy === top.id}
                      disabled={imageBusy !== null}
                      onFile={(file) => void changeImage({ id: top.id, name: top.name, top: true }, file)}
                      size="h-14 w-14"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold text-gray-900">{top.name}</span>
                        {!top.isActive && <Pill tone="gray">Hidden</Pill>}
                      </p>
                      <p className="text-xs text-gray-500">
                        {top.subcategories.length} subcategor{top.subcategories.length === 1 ? 'y' : 'ies'} · {top.productCount + subProducts} product
                        {top.productCount + subProducts === 1 ? '' : 's'}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3">
                        <button type="button" onClick={() => setEditing({ kind: 'rename-top', category: top })} className="text-xs font-semibold text-brand-600">
                          Rename
                        </button>
                        <button type="button" onClick={() => setEditing({ kind: 'new-sub', parent: top })} className="text-xs font-semibold text-brand-600">
                          + Subcategory
                        </button>
                      </div>
                    </div>
                    <Toggle
                      checked={top.isActive}
                      disabled={toggle.isPending && toggle.variables?.id === top.id}
                      label={`${top.name} visible to customers`}
                      onChange={(next) => {
                        setNotice(null);
                        toggle.mutate({ id: top.id, isActive: next, top: true });
                      }}
                    />
                  </div>

                  {top.subcategories.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-gray-300 px-3.5 py-3 text-sm text-gray-500">
                      No subcategories yet — add one, or list products under {top.name} itself.
                    </p>
                  ) : (
                    <ul className="grid gap-2 md:grid-cols-2">
                      {top.subcategories.map((sub) => (
                        <li key={sub.id}>
                          <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/60 p-2.5">
                            <ImagePicker
                              label={`Change image of ${sub.name}`}
                              src={sub.imageUrl}
                              busy={imageBusy === sub.id}
                              disabled={imageBusy !== null}
                              onFile={(file) => void changeImage({ id: sub.id, name: sub.name, top: false }, file)}
                              size="h-11 w-11"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-semibold text-gray-900">{sub.name}</p>
                              <p className="text-xs text-gray-500">
                                {sub.productCount} product{sub.productCount === 1 ? '' : 's'}
                                {sub.isActive ? '' : ' · hidden'}
                              </p>
                              <button type="button" onClick={() => setEditing({ kind: 'rename-sub', parent: top, sub })} className="mt-0.5 text-xs font-semibold text-brand-600">
                                Rename
                              </button>
                            </div>
                            <Toggle
                              checked={sub.isActive}
                              disabled={toggle.isPending && toggle.variables?.id === sub.id}
                              label={`${sub.name} visible to customers`}
                              onChange={(next) => {
                                setNotice(null);
                                toggle.mutate({ id: sub.id, isActive: next, top: false });
                              }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Surface>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setEditing({ kind: 'new-top' })}
        aria-label="New category"
        className="fixed bottom-20 right-4 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-brand-500 px-5 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition active:scale-95 sm:hidden"
      >
        <Icon name="plus" className="h-5 w-5" /> New
      </button>

      {editing && (
        <NameModal
          editing={editing}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            setNotice({ ok: true, text });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function NameModal({ editing, onClose, onDone }: { editing: Editing; onClose: () => void; onDone: (text: string) => void }) {
  const initial =
    editing.kind === 'rename-top' ? editing.category.name : editing.kind === 'rename-sub' ? editing.sub.name : '';
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (trimmed: string): Promise<unknown> => {
      switch (editing.kind) {
        case 'new-top':
          return sellerApi.post<SellerCatalogCategories>('/seller/categories', { name: trimmed });
        case 'rename-top':
          return sellerApi.patch<SellerCatalogCategories>(`/seller/categories/${editing.category.id}`, { name: trimmed });
        case 'new-sub':
          return sellerApi.post<SellerSubcategory>('/seller/subcategories', { parentId: editing.parent.id, name: trimmed });
        case 'rename-sub':
          return sellerApi.patch<SellerSubcategory>(`/seller/subcategories/${editing.sub.id}`, { name: trimmed });
      }
    },
  });

  const title =
    editing.kind === 'new-top'
      ? 'New category'
      : editing.kind === 'rename-top'
        ? 'Rename category'
        : editing.kind === 'new-sub'
          ? `New subcategory in ${editing.parent.name}`
          : 'Rename subcategory';

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return setError('Enter a name (at least 2 characters).');
    if (trimmed === initial) return onClose();
    setError(null);
    try {
      await save.mutateAsync(trimmed);
      onDone(
        editing.kind === 'new-top'
          ? `"${trimmed}" was created.`
          : editing.kind === 'new-sub'
            ? `"${trimmed}" was added to ${editing.parent.name}.`
            : `Renamed to "${trimmed}".`,
      );
    } catch (err) {
      setError(sellerErrorMessage(err));
    }
  }

  return (
    <Modal
      title={title}
      subtitle={editing.kind === 'new-top' || editing.kind === 'rename-top' ? 'A top category groups related products, e.g. Grocery.' : 'Group your products inside one of your categories.'}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending} className="w-full sm:w-auto">
            {save.isPending ? 'Saving…' : editing.kind.startsWith('new') ? 'Create' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={error} />
        <Field label={editing.kind.endsWith('top') ? 'Category name' : 'Subcategory name'} required>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder={editing.kind.endsWith('top') ? 'e.g. Grocery' : 'e.g. Atta, Rice & Dal'}
            className={inputClass}
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  );
}
