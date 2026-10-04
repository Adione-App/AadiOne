/**
 * The restaurant / cafe MENU, managed entirely on the Seller Categories page:
 *
 *   Menu (e.g. Main Menu, Breakfast Menu)       = the seller's own top category
 *     └ Menu Section (e.g. Roti, Sabji, Rice)   = a subcategory of that menu
 *         └ Food Item (e.g. Dal Tadka ₹120)     = the seller's own product
 *
 * It is the same category tree every seller has (Category → Subcategory →
 * Product), so menus and sections use the same routes and rules: ownership
 * enforced server-side, and nothing with food items in it can be deleted.
 *
 *   Menu      POST/PATCH/DELETE /seller/categories(/:id)
 *   Section   POST /seller/menu-sections · PATCH/DELETE /seller/subcategories/:id
 *             PUT /seller/menu-sections/order (move up / down)
 *   Item      Add / Edit → FoodItemModal (price + availability, no MRP, no stock)
 *             DELETE /seller/products/:id · availability PATCH /seller/listings/:id
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Pill, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import {
  sellerApi,
  sellerErrorMessage,
  type SellerCatalogCategories,
  type SellerCatalogCategory,
  type SellerCatalogSubcategoryRef,
  type SellerProductInventory,
} from './sellerApi';
import { sellerKeys, useSellerProducts } from './sellerQueries';
import { ProductImage, reviewState, type Notice } from './productUi';
import { FoodItemModal, type FoodItemFormMode } from './foodItemForm';

type Menu = SellerCatalogCategory;
type Section = SellerCatalogSubcategoryRef;

type Naming = { kind: 'menu'; menu: Menu | null } | { kind: 'section'; menu: Menu; section: Section | null };
type Deleting =
  | { kind: 'menu'; menu: Menu; itemCount: number }
  | { kind: 'section'; menu: Menu; section: Section }
  | { kind: 'item'; item: SellerProductInventory };

const smallLink = 'text-xs font-semibold text-brand-600 disabled:opacity-30';
const smallDanger = 'text-xs font-semibold text-red-600';

export function MenuManager({ kind }: { kind: 'Restaurant' | 'Cafe' }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [food, setFood] = useState<FoodItemFormMode | null>(null);

  const tree = useQuery({
    queryKey: sellerKeys.catalogCategories,
    queryFn: () => sellerApi.get<SellerCatalogCategories>('/seller/categories'),
  });
  const products = useSellerProducts();
  const menus = tree.data?.categories ?? [];

  const itemsBySection = useMemo(() => {
    const map = new Map<string, SellerProductInventory[]>();
    for (const product of products.data ?? []) map.set(product.categoryId, [...(map.get(product.categoryId) ?? []), product]);
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [products.data]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.catalogCategories }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.menuSections }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.subcategories }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings }),
    ]);
  const fail = (error: unknown) => setNotice({ ok: false, text: sellerErrorMessage(error) });
  const done = (text: string) => {
    setNotice({ ok: true, text });
    void refresh();
  };

  const show = useMutation({
    mutationFn: (input: { id: string; isActive: boolean; menu: boolean }) =>
      sellerApi.patch(`/seller/${input.menu ? 'categories' : 'subcategories'}/${input.id}`, { isActive: input.isActive }),
    onError: fail,
    onSettled: () => refresh(),
  });
  const reorder = useMutation({
    mutationFn: (input: { menuId: string; ids: string[] }) => sellerApi.put('/seller/menu-sections/order', input),
    onError: fail,
    onSettled: () => refresh(),
  });
  const available = useMutation({
    mutationFn: (input: { listingId: string; isAvailable: boolean; name: string }) =>
      sellerApi.patch(`/seller/listings/${input.listingId}`, { isAvailable: input.isAvailable }),
    onSuccess: (_data, input) => setNotice({ ok: true, text: `${input.name} is now ${input.isAvailable ? 'available' : 'unavailable'}.` }),
    onError: fail,
    onSettled: () => refresh(),
  });

  const move = (menu: Menu, index: number, by: -1 | 1) => {
    const ids = menu.subcategories.map((section) => section.id);
    const [moving] = ids.splice(index, 1);
    ids.splice(index + by, 0, moving!);
    setNotice(null);
    reorder.mutate({ menuId: menu.id, ids });
  };

  return (
    <div className="space-y-5 pb-20 lg:pb-0">
      <section aria-label="Your menu" className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Menu</h2>
          <p className="text-sm text-gray-500">
            Manage your {kind.toLowerCase()} menu here: menus (e.g. Main Menu, Breakfast Menu), their sections (e.g.{' '}
            {kind === 'Cafe' ? 'Hot Coffee, Snacks' : 'Roti, Sabji'}) and the food items in each. Food items have a selling price and are
            switched available or unavailable — no MRP, no stock.
          </p>
        </div>
        <Button onClick={() => setNaming({ kind: 'menu', menu: null })} className="hidden shrink-0 sm:inline-flex">
          <Icon name="plus" className="h-4 w-4" /> Add Menu
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

      {tree.isPending || products.isPending ? (
        <Spinner label="Loading your menu…" />
      ) : tree.isError ? (
        <ErrorBanner message={sellerErrorMessage(tree.error)} />
      ) : menus.length === 0 ? (
        <div className="space-y-3">
          <EmptyState title="No menu yet" hint="Create your first menu — for example “Main Menu” — then add sections like Roti or Hot Coffee and your food items." />
          <Button onClick={() => setNaming({ kind: 'menu', menu: null })}>
            <Icon name="plus" className="h-4 w-4" /> Add Menu
          </Button>
        </div>
      ) : (
        <ul className="space-y-5" aria-label="Menus">
          {menus.map((menu) => {
            const itemCount = menu.subcategories.reduce((sum, s) => sum + s.productCount, 0) + menu.productCount;
            return (
              <li key={menu.id}>
                <Surface className="space-y-4 p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-lg font-semibold text-gray-900" data-menu-name>
                          {menu.name}
                        </span>
                        {!menu.isActive && <Pill tone="gray">Hidden</Pill>}
                      </h3>
                      <p className="text-xs text-gray-500">
                        {menu.subcategories.length} section{menu.subcategories.length === 1 ? '' : 's'} · {itemCount} food item{itemCount === 1 ? '' : 's'}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3">
                        <button type="button" onClick={() => setNaming({ kind: 'menu', menu })} aria-label={`Edit menu ${menu.name}`} className={smallLink}>
                          Edit
                        </button>
                        <button type="button" onClick={() => setDeleting({ kind: 'menu', menu, itemCount })} aria-label={`Delete menu ${menu.name}`} className={smallDanger}>
                          Delete
                        </button>
                      </div>
                    </div>
                    <Toggle
                      checked={menu.isActive}
                      disabled={show.isPending && show.variables?.id === menu.id}
                      label={`Menu ${menu.name} shown to customers`}
                      onChange={(next) => {
                        setNotice(null);
                        show.mutate({ id: menu.id, isActive: next, menu: true });
                      }}
                    />
                  </div>

                  {menu.subcategories.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-gray-300 px-3.5 py-3 text-sm text-gray-500">
                      No sections in {menu.name} yet — add one, e.g. “Roti”.
                    </p>
                  ) : (
                    <ul className="space-y-3" aria-label={`${menu.name} sections`}>
                      {menu.subcategories.map((section, index) => {
                        const items = itemsBySection.get(section.id) ?? [];
                        return (
                          <li key={section.id} className="space-y-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                            <div className="flex items-start gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2">
                                  <span className="truncate font-semibold text-gray-900" data-section-name>
                                    {section.name}
                                  </span>
                                  {!section.isActive && <Pill tone="gray">Hidden</Pill>}
                                </p>
                                <div className="mt-0.5 flex flex-wrap gap-x-3">
                                  <button type="button" onClick={() => setNaming({ kind: 'section', menu, section })} aria-label={`Edit section ${section.name}`} className={smallLink}>
                                    Edit
                                  </button>
                                  <button type="button" onClick={() => setDeleting({ kind: 'section', menu, section })} aria-label={`Delete section ${section.name}`} className={smallDanger}>
                                    Delete
                                  </button>
                                  <button type="button" onClick={() => move(menu, index, -1)} disabled={index === 0 || reorder.isPending} aria-label={`Move ${section.name} up`} className={smallLink}>
                                    ↑ Up
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => move(menu, index, 1)}
                                    disabled={index === menu.subcategories.length - 1 || reorder.isPending}
                                    aria-label={`Move ${section.name} down`}
                                    className={smallLink}
                                  >
                                    ↓ Down
                                  </button>
                                </div>
                              </div>
                              <Toggle
                                checked={section.isActive}
                                disabled={show.isPending && show.variables?.id === section.id}
                                label={`Section ${section.name} shown to customers`}
                                onChange={(next) => {
                                  setNotice(null);
                                  show.mutate({ id: section.id, isActive: next, menu: false });
                                }}
                              />
                            </div>
                            {items.length > 0 && (
                              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100 bg-white" aria-label={`${section.name} items`}>
                                {items.map((item) => (
                                  <FoodItemRow
                                    key={item.id}
                                    item={item}
                                    busy={available.isPending && available.variables?.listingId === item.listing?.id}
                                    onEdit={() => setFood({ kind: 'edit', item })}
                                    onDelete={() => setDeleting({ kind: 'item', item })}
                                    onAvailable={(isAvailable) => {
                                      setNotice(null);
                                      available.mutate({ listingId: item.listing!.id, isAvailable, name: item.name });
                                    }}
                                  />
                                ))}
                              </ul>
                            )}
                            <button type="button" onClick={() => setFood({ kind: 'create', sectionId: section.id })} className="text-sm font-semibold text-brand-600">
                              + Add Food Item<span className="sr-only"> to {section.name}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <Button variant="secondary" onClick={() => setNaming({ kind: 'section', menu, section: null })}>
                    <Icon name="plus" className="h-4 w-4" /> Add Menu Section<span className="sr-only"> to {menu.name}</span>
                  </Button>
                </Surface>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setNaming({ kind: 'menu', menu: null })}
        aria-label="Add menu"
        className="fixed bottom-20 right-4 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-brand-500 px-5 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition active:scale-95 sm:hidden"
      >
        <Icon name="plus" className="h-5 w-5" /> Menu
      </button>

      {naming && (
        <NameModal
          naming={naming}
          onClose={() => setNaming(null)}
          onDone={(text) => {
            setNaming(null);
            done(text);
          }}
        />
      )}
      {deleting && (
        <DeleteModal
          deleting={deleting}
          onClose={() => setDeleting(null)}
          onDone={(text) => {
            setDeleting(null);
            done(text);
          }}
        />
      )}
      {food && (
        <FoodItemModal
          mode={food}
          onClose={() => setFood(null)}
          onDone={(result) => {
            setFood(null);
            setNotice(result);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/** One food item: photo, veg mark, name, price, status · Edit · Delete · availability. */
function FoodItemRow({
  item,
  busy,
  onEdit,
  onDelete,
  onAvailable,
}: {
  item: SellerProductInventory;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAvailable: (next: boolean) => void;
}) {
  const review = reviewState(item);
  // Dish with options (e.g. Half / Full): each variant has its own price and
  // availability, managed in Edit; the row shows them at a glance.
  const options = item.variants.filter((v) => v.listing);
  return (
    <li className="flex flex-wrap items-center gap-3 p-2.5">
      <ProductImage src={item.images[0]?.thumbUrl ?? item.images[0]?.url ?? null} alt={item.name} size="h-11 w-11" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          {item.diet && (
            <span
              role="img"
              aria-label={item.diet === 'VEG' ? 'Veg' : 'Non-veg'}
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${item.diet === 'VEG' ? 'bg-brand-500' : 'bg-danger-500'}`}
            />
          )}
          <span className="truncate font-medium text-gray-900">{item.name}</span>
          <span className="ml-auto pl-2 font-semibold text-gray-900">
            {options.length > 1
              ? `from ${formatPaise(Math.min(...options.map((v) => v.listing!.pricePaise)))}`
              : item.listing
                ? formatPaise(item.listing.pricePaise)
                : '—'}
          </span>
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Pill tone={review.tone}>{review.label}</Pill>
          {options.length > 1 && (
            <span className="text-xs text-gray-500">
              {options.map((v) => `${v.variantName} ${formatPaise(v.listing!.pricePaise)}${v.listing!.isAvailable ? '' : ' (off)'}`).join(' · ')}
            </span>
          )}
          <button type="button" onClick={onEdit} aria-label={`Edit ${item.name}`} className={smallLink}>
            Edit
          </button>
          <button type="button" onClick={onDelete} aria-label={`Delete ${item.name}`} className={smallDanger}>
            Delete
          </button>
        </div>
      </div>
      {item.listing && options.length <= 1 && (
        <span className="inline-flex items-center gap-2 text-xs text-gray-600">
          <span aria-hidden="true">{item.listing.isAvailable ? 'Available' : 'Unavailable'}</span>
          <Toggle checked={item.listing.isAvailable} disabled={busy} label={`${item.name} available`} onChange={onAvailable} />
        </span>
      )}
    </li>
  );
}

/** Add or rename a menu or a menu section. */
function NameModal({ naming, onClose, onDone }: { naming: Naming; onClose: () => void; onDone: (text: string) => void }) {
  const existing = naming.kind === 'menu' ? naming.menu : naming.section;
  const noun = naming.kind === 'menu' ? 'menu' : 'menu section';
  const [name, setName] = useState(existing?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (trimmed: string): Promise<unknown> => {
      if (naming.kind === 'menu') {
        return naming.menu ? sellerApi.patch(`/seller/categories/${naming.menu.id}`, { name: trimmed }) : sellerApi.post('/seller/categories', { name: trimmed });
      }
      return naming.section
        ? sellerApi.patch(`/seller/subcategories/${naming.section.id}`, { name: trimmed })
        : sellerApi.post('/seller/menu-sections', { name: trimmed, menuId: naming.menu.id });
    },
  });

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return setError(`Enter a ${noun} name (at least 2 characters).`);
    setError(null);
    try {
      await save.mutateAsync(trimmed);
      onDone(existing ? `Renamed to "${trimmed}".` : naming.kind === 'menu' ? `Menu "${trimmed}" added.` : `Section "${trimmed}" added to ${naming.menu.name}.`);
    } catch (err) {
      setError(sellerErrorMessage(err));
    }
  }

  const title = existing ? `Edit ${noun}` : naming.kind === 'menu' ? 'Add Menu' : 'Add Menu Section';
  return (
    <Modal
      title={title}
      subtitle={
        naming.kind === 'menu'
          ? 'A menu groups sections, e.g. Main Menu or Breakfast Menu.'
          : `A section in ${naming.menu.name} groups food items, e.g. Roti, Sabji or Hot Coffee.`
      }
      onClose={() => {
        if (!save.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending} className="w-full sm:w-auto">
            {save.isPending ? 'Saving…' : existing ? 'Save' : naming.kind === 'menu' ? 'Add menu' : 'Add section'}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <ErrorBanner message={error} />
        <Field label={naming.kind === 'menu' ? 'Menu name' : 'Section name'} required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className={inputClass}
            placeholder={naming.kind === 'menu' ? 'e.g. Main Menu' : 'e.g. Roti'}
            autoFocus
          />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * Delete confirmation for a menu, a section or a food item. A menu or section
 * with food items in it is never deleted (the backend refuses it with 409 as
 * well): the dialog explains why and offers no Delete button.
 */
function DeleteModal({ deleting, onClose, onDone }: { deleting: Deleting; onClose: () => void; onDone: (text: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const name = deleting.kind === 'menu' ? deleting.menu.name : deleting.kind === 'section' ? deleting.section.name : deleting.item.name;
  const linked = deleting.kind === 'menu' ? deleting.itemCount : deleting.kind === 'section' ? deleting.section.productCount : 0;
  const noun = deleting.kind === 'menu' ? 'menu' : deleting.kind === 'section' ? 'menu section' : 'food item';
  const remove = useMutation({
    mutationFn: () =>
      deleting.kind === 'menu'
        ? sellerApi.delete(`/seller/categories/${deleting.menu.id}`)
        : deleting.kind === 'section'
          ? sellerApi.delete(`/seller/subcategories/${deleting.section.id}`)
          : sellerApi.delete(`/seller/products/${deleting.item.id}`),
  });

  async function confirm(): Promise<void> {
    setError(null);
    try {
      await remove.mutateAsync();
      onDone(`"${name}" was deleted.`);
    } catch (err) {
      setError(sellerErrorMessage(err));
    }
  }

  return (
    <Modal
      title={`Delete this ${noun}?`}
      subtitle={name}
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending} className="w-full sm:w-auto">
            {linked > 0 ? 'Close' : 'Cancel'}
          </Button>
          {linked === 0 && (
            <Button variant="danger" onClick={() => void confirm()} disabled={remove.isPending} className="w-full sm:w-auto">
              {remove.isPending ? 'Deleting…' : `Delete ${noun}`}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3 text-sm text-gray-700">
        <ErrorBanner message={error} />
        {linked > 0 ? (
          <p>
            {linked} food item{linked === 1 ? ' is' : 's are'} in “{name}”. Food items are never deleted with a {noun}: move or delete them first,
            or switch the {noun} off to hide it from customers.
          </p>
        ) : deleting.kind === 'item' ? (
          <p>“{name}” will be removed from your menu and can no longer be ordered. Past orders keep it. This action cannot be undone.</p>
        ) : (
          <p>
            This {noun} will be removed from your menu
            {deleting.kind === 'menu' && deleting.menu.subcategories.length > 0 ? `, together with its ${deleting.menu.subcategories.length} empty section(s)` : ''}.
            This action cannot be undone.
          </p>
        )}
      </div>
    </Modal>
  );
}
