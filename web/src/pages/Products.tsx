/**
 * Catalogue management (Task 13.4).
 *
 * Two jobs that pull in opposite directions: creating a product, which happens
 * during setup and then rarely, and correcting price or stock, which happens
 * many times a day. Creation lives behind a modal; the corrections stay inline
 * in the table where they can be made without navigating anywhere.
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CategoryDto,
  CursorPage,
  ProductDetailDto,
  ProductSummaryDto,
} from '@shared';
import { UnitType } from '@shared';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { uploadProductImage, validateImage } from '@/lib/upload';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  Modal,
  Pill,
  SearchInput,
  Spinner,
  StatCard,
  TableWrap,
  Td,
  Th,
  Thumb,
  Field,
  inputClass,
} from '@/components/ui';

/** Flattens the category tree into an indented list for <select>. */
function flatten(categories: CategoryDto[]): CategoryDto[] {
  return categories.flatMap((category) => [category, ...flatten(category.children ?? [])]);
}

const UNIT_LABELS: Record<string, string> = {
  [UnitType.G]: 'g',
  [UnitType.KG]: 'kg',
  [UnitType.ML]: 'ml',
  [UnitType.L]: 'L',
  [UnitType.PIECE]: 'piece',
  [UnitType.PACK]: 'pack',
  [UnitType.DOZEN]: 'dozen',
  [UnitType.BUNDLE]: 'bundle',
};

/** "Aashirvaad Atta 5kg" -> "AASHIRVAAD-ATTA-5KG-7F3A" */
function suggestSku(name: string, variantName: string): string {
  const base = `${name} ${variantName}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `${base || 'SKU'}-${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* add product                                                                 */
/* -------------------------------------------------------------------------- */

function AddProductModal({
  categories,
  onClose,
  onCreated,
}: {
  categories: CategoryDto[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [variantName, setVariantName] = useState('');
  const [unit, setUnit] = useState<string>(UnitType.PIECE);
  const [unitValue, setUnitValue] = useState('1');
  const [mrp, setMrp] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('0');
  const [publish, setPublish] = useState(true);
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null): void {
    if (!list || list.length === 0) return;

    const accepted: { file: File; preview: string }[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(list)) {
      const invalid = validateImage(file);
      if (invalid) rejected.push(`${file.name}: ${invalid}`);
      else accepted.push({ file, preview: URL.createObjectURL(file) });
    }

    // Partial acceptance on purpose — one oversized file in a multi-select
    // should not discard the others the user picked.
    setError(rejected.length > 0 ? rejected.join(' ') : null);
    setImages((current) => [...current, ...accepted]);
  }

  function removeImage(index: number): void {
    setImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((_, position) => position !== index);
    });
  }

  const create = useMutation({
    mutationFn: async () => {
      const mrpPaise = Math.round(Number(mrp) * 100);
      const pricePaise = Math.round(Number(price) * 100);

      if (!Number.isFinite(mrpPaise) || mrpPaise <= 0) throw new Error('Enter a valid MRP.');
      if (!Number.isFinite(pricePaise) || pricePaise <= 0) {
        throw new Error('Enter a valid selling price.');
      }
      if (pricePaise > mrpPaise) throw new Error('Selling price cannot be higher than MRP.');

      // 1. The product row. It is created as DRAFT by the server so that a
      //    product with no variant and no price can never be purchasable.
      setStep('Creating product…');
      const product = await api.post<{ id: string }>('/admin/products', {
        name: name.trim(),
        categoryId,
        ...(description.trim() ? { description: description.trim() } : {}),
      });

      // 2. The variant carries the price and the stock.
      setStep('Adding price and stock…');
      await api.post<{ id: string }>('/admin/variants', {
        productId: product.id,
        sku: suggestSku(name, variantName),
        variantName: variantName.trim(),
        unit,
        unitValue: Number(unitValue),
        isDefault: true,
        mrpPaise,
        pricePaise,
        stockQty: Number(stock) || 0,
      });

      // 3. Images, in the order they were chosen — the server assigns
      //    displayOrder from the count so far, so the first one uploaded
      //    becomes the primary image shown on cards and in search.
      //
      //    Uploaded one at a time rather than in parallel: a shop on a phone
      //    hotspot uploading six photos at once gets six stalled sockets, and
      //    sequential means a failure names the file that failed.
      if (images.length > 0) {
        const failed: string[] = [];

        for (const [position, image] of images.entries()) {
          setStep(`Uploading image ${position + 1} of ${images.length}…`);
          try {
            const key = await uploadProductImage(image.file, (body) =>
              api.post('/admin/uploads/presign', body),
            );
            await api.post('/admin/product-images', { productId: product.id, key });
          } catch (err) {
            failed.push(`${image.file.name} (${err instanceof Error ? err.message : 'failed'})`);
          }
        }

        // The product exists either way; losing it because a photo failed
        // would be the worse outcome.
        if (failed.length > 0) {
          throw new Error(
            `Product created, but ${failed.length} of ${images.length} images failed: ` +
              `${failed.join('; ')}. Add them with the image button on the product row.`,
          );
        }
      }

      // 4. Publishing last: the server refuses to activate a product that has
      //    no sellable offer, so it can only happen after the variant exists.
      if (publish) {
        setStep('Publishing…');
        await api.patch(`/admin/products/${product.id}`, { status: 'ACTIVE' });
      }
    },
    onSuccess: () => {
      setStep(null);
      onCreated();
      onClose();
    },
    onError: (err: Error) => {
      setStep(null);
      setError(err.message);
    },
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    setError(null);
    create.mutate();
  }

  const options = flatten(categories);

  return (
    <Modal
      title="Add Product"
      subtitle="Create a product with its first size, price and stock."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? (step ?? 'Saving…') : 'Save Product'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <ErrorBanner message={error} />

        {/* ---- images ---- */}
        <div>
          <div className="flex flex-wrap items-start gap-3">
            {images.map((image, position) => (
              <div key={image.preview} className="relative">
                <img
                  src={image.preview}
                  alt=""
                  className="h-24 w-24 rounded-xl border border-gray-200 object-cover"
                />
                {/* The first image is what appears on cards and in search, so
                    say so rather than leaving the order a mystery. */}
                {position === 0 && (
                  <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-gray-900/70 py-0.5 text-center text-[10px] font-semibold text-white">
                    Main
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${image.file.name}`}
                  onClick={() => removeImage(position)}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-gray-500 shadow ring-1 ring-gray-200 transition hover:bg-danger-50 hover:text-danger-500"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-gray-50 text-gray-400 transition hover:border-brand-500 hover:text-brand-600"
            >
              <Icon name="plus" className="h-6 w-6" />
              <span className="text-xs font-medium">Add</span>
            </button>
          </div>

          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              // Cleared so picking the same file again still fires onChange.
              event.target.value = '';
            }}
          />

          <p className="mt-2 text-xs text-gray-500">
            JPEG, PNG or WebP · up to 5 MB each · pick several at once. The first image is the
            main one customers see.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Product name" required>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
                placeholder="Aashirvaad Atta"
                required
              />
            </Field>
          </div>

          <Field label="Category" required>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={inputClass}
              required
            >
              <option value="">Select a category</option>
              {options.map((category) => (
                <option key={category.id} value={category.id}>
                  {' '.repeat(category.depth * 3)}
                  {category.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Size / pack label" required hint='What the customer sees, e.g. "5 kg"'>
            <input
              value={variantName}
              onChange={(event) => setVariantName(event.target.value)}
              className={inputClass}
              placeholder="5 kg"
              required
            />
          </Field>

          <Field label="Unit" required>
            <select
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              className={inputClass}
            >
              {Object.entries(UNIT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Unit value" required hint="5 for a 5 kg bag, 1 for a single piece">
            <input
              type="number"
              min="0"
              step="any"
              value={unitValue}
              onChange={(event) => setUnitValue(event.target.value)}
              className={inputClass}
              required
            />
          </Field>

          <Field label="MRP (₹)" required>
            <input
              type="number"
              min="0"
              step="0.01"
              value={mrp}
              onChange={(event) => setMrp(event.target.value)}
              className={inputClass}
              placeholder="250.00"
              required
            />
          </Field>

          <Field label="Selling price (₹)" required hint="Cannot be higher than MRP">
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              className={inputClass}
              placeholder="245.00"
              required
            />
          </Field>

          <Field label="Opening stock" required>
            <input
              type="number"
              min="0"
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              className={inputClass}
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Description">
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                className={inputClass}
                placeholder="Optional. Shown on the product page in the app."
              />
            </Field>
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-xl bg-gray-50 p-3.5">
          <input
            type="checkbox"
            checked={publish}
            onChange={(event) => setPublish(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
          />
          <span className="text-sm">
            <span className="font-medium text-gray-900">Publish immediately</span>
            <span className="mt-0.5 block text-gray-500">
              Leave this off to save as a draft. Drafts are not visible in the app and do not
              appear in this list.
            </span>
          </span>
        </label>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* manage images on an existing product                                        */
/* -------------------------------------------------------------------------- */

function ManageImagesModal({
  productId,
  productName,
  onClose,
  onChanged,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['product-detail', productId],
    queryFn: () => api.get<ProductDetailDto>(`/products/${productId}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['product-detail', productId] });
    onChanged();
  };

  async function upload(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setError(null);

    const files = Array.from(list);
    const failed: string[] = [];

    for (const [position, file] of files.entries()) {
      const invalid = validateImage(file);
      if (invalid) {
        failed.push(`${file.name}: ${invalid}`);
        continue;
      }
      setBusy(`Uploading ${position + 1} of ${files.length}…`);
      try {
        const key = await uploadProductImage(file, (body) =>
          api.post('/admin/uploads/presign', body),
        );
        await api.post('/admin/product-images', { productId, key });
      } catch (err) {
        failed.push(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }

    setBusy(null);
    if (failed.length > 0) setError(failed.join(' '));
    refresh();
  }

  async function remove(imageId: string): Promise<void> {
    setError(null);
    setBusy('Removing…');
    try {
      await api.delete(`/admin/product-images/${imageId}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that image.');
    } finally {
      setBusy(null);
    }
  }

  const images = detail.data?.images ?? [];

  return (
    <Modal
      title="Product images"
      subtitle={productName}
      onClose={onClose}
      wide
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <ErrorBanner message={error} />
        {busy && <p className="text-sm text-gray-500">{busy}</p>}

        {detail.isLoading ? (
          <Spinner label="Loading images…" />
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            {images.map((image, position) => (
              <div key={image.id} className="relative">
                <img
                  src={imageSrc(image.thumbUrl ?? image.url)}
                  alt={image.altText ?? productName}
                  className="h-28 w-28 rounded-xl border border-gray-200 object-cover"
                />
                {position === 0 && (
                  <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-gray-900/70 py-0.5 text-center text-[10px] font-semibold text-white">
                    Main
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Remove image"
                  disabled={busy !== null}
                  onClick={() => void remove(image.id)}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-gray-500 shadow ring-1 ring-gray-200 transition hover:bg-danger-50 hover:text-danger-500 disabled:opacity-50"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <button
              type="button"
              disabled={busy !== null}
              onClick={() => fileInput.current?.click()}
              className="flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-gray-50 text-gray-400 transition hover:border-brand-500 hover:text-brand-600 disabled:opacity-50"
            >
              <Icon name="plus" className="h-6 w-6" />
              <span className="text-xs font-medium">Add</span>
            </button>
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="hidden"
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = '';
          }}
        />

        <p className="text-xs text-gray-500">
          The first image is the main one shown on product cards and in search. Order follows the
          order images were added — to change which is main, remove the ones before it and add
          them again.
        </p>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* page                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductsPage() {
  const [categoryId, setCategoryId] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<CategoryDto[]>('/categories?includeChildren=true'),
  });

  const productsQueryKey = ['admin-products', categoryId] as const;

  const products = useQuery({
    queryKey: productsQueryKey,
    queryFn: () =>
      // The ADMIN listing, not the customer-facing `/products` — that one
      // filters to status=ACTIVE, which would make a product disappear from
      // this very table the moment "Display on App" was switched off, with
      // no way to find it again to switch back on.
      api.get<CursorPage<ProductSummaryDto>>(
        `/admin/products?limit=100${categoryId ? `&categoryId=${categoryId}` : ''}`,
      ),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-products'] });
  };

  const [pendingDisplayIds, setPendingDisplayIds] = useState<Set<string>>(new Set());

  const setDisplay = useMutation({
    mutationFn: (input: { id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      api.patch(`/admin/products/${input.id}`, { status: input.status }),
    onMutate: async (input) => {
      setPendingDisplayIds((current) => new Set(current).add(input.id));
      await queryClient.cancelQueries({ queryKey: productsQueryKey });
      const previous = queryClient.getQueryData<CursorPage<ProductSummaryDto>>(productsQueryKey);
      // Flip it on screen immediately — the PATCH runs in the background,
      // rolled back in onError if the server refuses it (e.g. no variant
      // priced yet).
      queryClient.setQueryData<CursorPage<ProductSummaryDto>>(productsQueryKey, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((product) =>
                product.id === input.id ? { ...product, status: input.status } : product,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (err: Error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(productsQueryKey, context.previous);
      setError(err.message);
    },
    onSuccess: () => setError(null),
    onSettled: (_data, _err, input) => {
      setPendingDisplayIds((current) => {
        const next = new Set(current);
        next.delete(input.id);
        return next;
      });
      invalidate();
    },
  });

  const setStock = useMutation({
    mutationFn: (input: { storeVariantId: string; stockQty: number }) =>
      api.patch(`/admin/store-variants/${input.storeVariantId}/stock`, {
        stockQty: input.stockQty,
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const setPrice = useMutation({
    mutationFn: (input: { storeVariantId: string; pricePaise: number }) =>
      api.patch(`/admin/store-variants/${input.storeVariantId}/pricing`, {
        pricePaise: input.pricePaise,
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/products/${id}`),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Managing images on a product that already exists — the recovery path when
  // creation succeeded but an upload did not, and where extra photos are added.
  const [imageTarget, setImageTarget] = useState<ProductSummaryDto | null>(null);

  const categoryNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of flatten(categories.data ?? [])) map.set(category.id, category.name);
    return map;
  }, [categories.data]);

  const all = products.data?.items ?? [];

  const visible = all.filter((product) => {
    const qty = product.defaultVariant?.availableQty ?? 0;
    if (stockFilter === 'out' && qty !== 0) return false;
    if (stockFilter === 'low' && !(qty > 0 && qty <= 10)) return false;
    if (stockFilter === 'in' && qty <= 0) return false;
    const term = search.trim().toLowerCase();
    if (term && !product.name.toLowerCase().includes(term)) return false;
    return true;
  });

  const counts = {
    total: all.length,
    inStock: all.filter((product) => (product.defaultVariant?.availableQty ?? 0) > 0).length,
    out: all.filter((product) => (product.defaultVariant?.availableQty ?? 0) === 0).length,
    low: all.filter((product) => {
      const qty = product.defaultVariant?.availableQty ?? 0;
      return qty > 0 && qty <= 10;
    }).length,
  };

  return (
    <div className="space-y-5">
      {/* ---- toolbar ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search products by name…"
          className="min-w-[220px] flex-1"
        />
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className={`${inputClass} w-auto min-w-[160px]`}
        >
          <option value="">All Categories</option>
          {flatten(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select
          value={stockFilter}
          onChange={(event) => setStockFilter(event.target.value)}
          className={`${inputClass} w-auto min-w-[140px]`}
        >
          <option value="">All Stock Levels</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        <Button onClick={() => setAdding(true)}>
          <Icon name="plus" className="h-4 w-4" />
          Add Product
        </Button>
      </div>

      {/* ---- metrics ---- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="products" label="Total Products" value={counts.total} tone="brand" />
        <StatCard icon="box" label="In Stock" value={counts.inStock} tone="purple" />
        <StatCard icon="alert" label="Out of Stock" value={counts.out} tone="red" />
        <StatCard icon="inventory" label="Low Stock" value={counts.low} tone="amber" />
      </div>

      <ErrorBanner message={error} />

      {/* ---- table ---- */}
      {products.isLoading ? (
        <Spinner label="Loading catalogue…" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? 'No products yet' : 'Nothing matches those filters'}
          hint={
            all.length === 0
              ? 'Use “Add Product” to create your first one.'
              : 'Try clearing the search or the status filter.'
          }
        />
      ) : (
        <TableWrap>
          <table className="w-full min-w-[880px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <Th>Product</Th>
                <Th>Category</Th>
                <Th>Price (₹)</Th>
                <Th>Stock</Th>
                <Th>Stock Status</Th>
                <Th>Display on App</Th>
                <Th>COD</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((product) => {
                const variant = product.defaultVariant;
                const qty = variant?.availableQty ?? 0;

                return (
                  <tr key={product.id} className="transition hover:bg-gray-50/60">
                    <Td>
                      <div className="flex items-center gap-3">
                        <Thumb src={product.thumbUrl ?? product.imageUrl} alt={product.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-gray-900">{product.name}</p>
                          <p className="truncate text-xs text-gray-500">
                            {variant?.variantName ?? product.brandName ?? '—'}
                          </p>
                        </div>
                      </div>
                    </Td>

                    <Td className="text-gray-600">
                      {categoryNames.get(product.categoryId) ?? '—'}
                    </Td>

                    <Td>
                      {variant ? (
                        <>
                          <input
                            type="number"
                            defaultValue={variant.pricePaise / 100}
                            min={0}
                            step="0.01"
                            // Committed on blur, not per keystroke: staff type
                            // fast and a request per digit is wasteful and racy.
                            onBlur={(event) => {
                              const paise = Math.round(Number(event.target.value) * 100);
                              if (paise !== variant.pricePaise && paise > 0) {
                                setPrice.mutate({
                                  storeVariantId: variant.id,
                                  pricePaise: paise,
                                });
                              }
                            }}
                            className="w-24 rounded-lg border border-gray-300 px-2.5 py-1.5"
                          />
                          <span className="ml-2 whitespace-nowrap text-xs text-gray-400">
                            MRP {formatPaise(variant.mrpPaise)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>

                    <Td>
                      {variant ? (
                        <input
                          type="number"
                          defaultValue={qty}
                          min={0}
                          onBlur={(event) => {
                            const next = Number(event.target.value);
                            if (next !== qty && next >= 0) {
                              setStock.mutate({ storeVariantId: variant.id, stockQty: next });
                            }
                          }}
                          className={`w-20 rounded-lg border px-2.5 py-1.5 ${
                            qty === 0 ? 'border-danger-500 text-danger-500' : 'border-gray-300'
                          }`}
                        />
                      ) : (
                        '—'
                      )}
                    </Td>

                    <Td>
                      {qty === 0 ? (
                        <Pill tone="red">Out of Stock</Pill>
                      ) : qty <= 10 ? (
                        <Pill tone="amber">Low Stock</Pill>
                      ) : (
                        <Pill tone="brand">In Stock</Pill>
                      )}
                    </Td>

                    <Td>
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={product.status === 'ACTIVE'}
                          disabled={pendingDisplayIds.has(product.id)}
                          onChange={(event) =>
                            setDisplay.mutate({
                              id: product.id,
                              status: event.target.checked ? 'ACTIVE' : 'INACTIVE',
                            })
                          }
                          className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                        />
                        <span className="text-xs text-gray-500">
                          {product.status === 'ACTIVE'
                            ? 'Visible'
                            : product.status === 'DRAFT'
                              ? 'Draft'
                              : 'Hidden'}
                        </span>
                      </label>
                    </Td>

                    <Td>
                      {variant?.allowCod ? (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-white">
                          <Icon name="check" className="h-3.5 w-3.5" />
                        </span>
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-gray-500">
                          –
                        </span>
                      )}
                    </Td>

                    <Td>
                      <div className="flex justify-end gap-1">
                        <button
                          aria-label={`Manage images for ${product.name}`}
                          title="Manage images"
                          onClick={() => setImageTarget(product)}
                          className="rounded-lg p-2 text-gray-400 transition hover:bg-brand-50 hover:text-brand-600"
                        >
                          <Icon name="image" />
                        </button>
                        <button
                          aria-label={`Delete ${product.name}`}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete “${product.name}”? It will stop appearing in the app.`,
                              )
                            ) {
                              remove.mutate(product.id);
                            }
                          }}
                          className="rounded-lg p-2 text-gray-400 transition hover:bg-danger-50 hover:text-danger-500"
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}

      <p className="text-sm text-gray-500">
        Showing {visible.length} of {all.length} products
      </p>

      {imageTarget && (
        <ManageImagesModal
          productId={imageTarget.id}
          productName={imageTarget.name}
          onClose={() => setImageTarget(null)}
          onChanged={invalidate}
        />
      )}

      {adding && (
        <AddProductModal
          categories={categories.data ?? []}
          onClose={() => setAdding(false)}
          onCreated={invalidate}
        />
      )}
    </div>
  );
}
