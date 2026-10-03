/**
 * Marketplace Catalogue — a READ-ONLY explorer of every seller's catalogue
 * (GET /admin/marketplace/catalogue).
 *
 * Sellers — Aadione included — own their categories, subcategories and
 * products and manage them in the Seller Panel. Rows with the same name at the
 * same level are shown as one branch, and every product names the seller that
 * owns it, so two sellers' "Grocery › Rice" appear together with each
 * seller's products. Nothing here creates, edits or deletes a category;
 * product moderation lives on the Products page.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatPaise } from '@shared/money';
import { Icon, Surface, Thumb } from '@/components/ui';
import { ApprovalBadge, ProductStatusBadge, SellerLink } from '@/components/MarketplaceUi';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';
import { useSellerPermissions } from '@/lib/sellers';
import {
  adminErrorMessage,
  useMarketplaceCatalogue,
  useSellerOptions,
  type CatalogueProduct,
  type CatalogueSellerRef,
  type CatalogueTopCategory,
} from '@/lib/marketplace';

export default function CategoriesPage() {
  const perms = useSellerPermissions();
  const [params, setParams] = useSearchParams();
  const sellerId = params.get('seller') ?? 'ALL';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sellers = useSellerOptions(perms.canRead);
  const catalogue = useMarketplaceCatalogue({ q: q || undefined, sellerId: sellerId === 'ALL' ? undefined : sellerId });

  // Keep the search in the URL (shareable), without writing during render.
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const categories = catalogue.data?.categories ?? [];
  const searching = q !== '' || sellerId !== 'ALL';
  // While searching, show every matching branch open.
  const isOpen = (key: string) => searching || open.has(key);
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allKeys = useMemo(
    () => categories.flatMap((top) => [top.key, ...top.subcategories.map((sub) => sub.key), `${top.key}#direct`]),
    [categories],
  );

  const summary = catalogue.data?.summary;
  const tiles = [
    { label: 'Top categories', value: summary?.topCategories },
    { label: 'Subcategories', value: summary?.subcategories },
    { label: 'Products', value: summary?.products },
    { label: 'Sellers', value: summary?.sellers },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Every seller — Aadione included — creates its own categories, subcategories and products in the{' '}
          <span className="font-semibold">Seller Panel</span>. This view is read-only: it shows the whole marketplace grouped by
          category, with the seller of every product. To disable a product, use{' '}
          <Link to="/products" className="font-semibold text-brand-600 hover:underline">
            Products
          </Link>
          .
        </p>
      </div>

      <section aria-label="Catalogue summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl border border-gray-200/80 bg-white p-3.5 shadow-sm">
            <span className="block text-xs font-medium text-gray-500">{tile.label}</span>
            <span className="mt-1 block text-xl font-bold text-gray-900">{tile.value ?? '—'}</span>
          </div>
        ))}
      </section>

      <Surface className="grid gap-3 p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Search</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Category, product or seller…" label="Search the catalogue" />
        </div>
        {perms.canRead ? (
          <FilterSelect
            label="Seller"
            value={sellerId}
            options={[{ value: 'ALL', label: 'All sellers' }, ...(sellers.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            onChange={(next) => {
              const updated = new URLSearchParams(params);
              if (next === 'ALL') updated.delete('seller');
              else updated.set('seller', next);
              setParams(updated, { replace: true });
            }}
          />
        ) : (
          <span />
        )}
        {!searching && categories.length > 0 && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(new Set(allKeys))}
              className="h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={() => setOpen(new Set())}
              className="h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Collapse all
            </button>
          </div>
        )}
      </Surface>

      {catalogue.isPending ? (
        <SkeletonList rows={5} label="Loading the marketplace catalogue…" />
      ) : catalogue.isError ? (
        <LoadError message={adminErrorMessage(catalogue.error)} onRetry={() => void catalogue.refetch()} />
      ) : categories.length === 0 ? (
        <EmptyPanel
          icon="categories"
          title={searching ? 'Nothing matches these filters' : 'No categories yet'}
          hint={
            searching
              ? 'Try another search or seller.'
              : 'Sellers create their top categories, subcategories and products in the Seller Panel. They appear here as soon as they are created.'
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Top categories">
          {categories.map((top) => (
            <TopCategoryCard key={top.key} top={top} isOpen={isOpen} onToggle={toggle} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SellerChips({ sellers }: { sellers: CatalogueSellerRef[] }) {
  const unique = [...new Map(sellers.map((s) => [s.id, s])).values()];
  return (
    <span className="flex flex-wrap gap-1.5">
      {unique.map((s) => (
        <span
          key={s.id}
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${s.isActive ? 'border-gray-200 bg-white text-gray-700' : 'border-gray-200 bg-gray-50 text-gray-400 line-through'}`}
          title={s.isActive ? `Created by ${s.name}` : `${s.name} has switched this category off`}
        >
          {s.name}
        </span>
      ))}
    </span>
  );
}

function ExpandButton({
  label,
  open,
  onClick,
  children,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={label}
      className="flex w-full items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <Icon name={open ? 'chevronDown' : 'chevronRight'} className="mt-1 h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function TopCategoryCard({
  top,
  isOpen,
  onToggle,
}: {
  top: CatalogueTopCategory;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const open = isOpen(top.key);
  const directKey = `${top.key}#direct`;
  return (
    <li>
      <Surface className="p-3.5">
        <ExpandButton label={`${open ? 'Collapse' : 'Expand'} ${top.name}`} open={open} onClick={() => onToggle(top.key)}>
          <span className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-gray-900">{top.name}</span>
            <span className="text-xs text-gray-500">
              {top.subcategories.length} subcategor{top.subcategories.length === 1 ? 'y' : 'ies'} · {top.productCount} product
              {top.productCount === 1 ? '' : 's'}
            </span>
          </span>
          <span className="mt-1.5 block">
            <SellerChips sellers={top.sellers} />
          </span>
        </ExpandButton>

        {open && (
          <div className="mt-3 space-y-2 border-l-2 border-gray-100 pl-3 sm:ml-2">
            {top.subcategories.length === 0 && top.products.length === 0 && (
              <p className="text-sm text-gray-500">No subcategories or products yet.</p>
            )}
            {top.subcategories.map((sub) => {
              const subOpen = isOpen(sub.key);
              return (
                <div key={sub.key} className="rounded-xl border border-gray-100 bg-gray-50/60 p-2.5">
                  <ExpandButton label={`${subOpen ? 'Collapse' : 'Expand'} ${top.name} › ${sub.name}`} open={subOpen} onClick={() => onToggle(sub.key)}>
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-gray-900">{sub.name}</span>
                      <span className="text-xs text-gray-500">
                        {sub.products.length} product{sub.products.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="mt-1 block">
                      <SellerChips sellers={sub.sellers} />
                    </span>
                  </ExpandButton>
                  {subOpen && <ProductList products={sub.products} empty="No products in this subcategory yet." />}
                </div>
              );
            })}
            {top.products.length > 0 && (
              <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-2.5">
                <ExpandButton
                  label={`${isOpen(directKey) ? 'Collapse' : 'Expand'} products directly in ${top.name}`}
                  open={isOpen(directKey)}
                  onClick={() => onToggle(directKey)}
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-700">Directly in {top.name}</span>
                    <span className="text-xs text-gray-500">
                      {top.products.length} product{top.products.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </ExpandButton>
                {isOpen(directKey) && <ProductList products={top.products} empty="" />}
              </div>
            )}
          </div>
        )}
      </Surface>
    </li>
  );
}

function ProductList({ products, empty }: { products: CatalogueProduct[]; empty: string }) {
  if (products.length === 0) return empty ? <p className="mt-2 pl-7 text-sm text-gray-500">{empty}</p> : null;
  return (
    <ul className="mt-2 divide-y divide-gray-100 rounded-lg bg-white" aria-label="Products">
      {products.map((p) => (
        <li key={p.productId} className="flex flex-wrap items-center gap-3 px-2.5 py-2">
          <Thumb src={p.imageUrl} alt={p.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">{p.name}</p>
            <p className="text-xs text-gray-500">
              Seller: <SellerLink seller={p.seller} tab="products" />
            </p>
          </div>
          <div className="text-right text-xs text-gray-600">
            <p className="font-semibold text-gray-900">{p.minPricePaise === null ? 'Not listed' : formatPaise(p.minPricePaise)}</p>
            <p>{p.listingCount === 0 ? '—' : `${p.availableQty} available`}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ApprovalBadge status={p.approvalStatus} />
            <ProductStatusBadge status={p.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}
