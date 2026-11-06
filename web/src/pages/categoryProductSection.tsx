/**
 * Home Page Builder → "Category products": a product section for ONE main
 * category or subcategory, set up in one step — type, category (from the
 * live marketplace categories, GET /admin/content/category-options), heading,
 * how many products, and their order.
 *
 * The result is an ordinary product shelf (createCategoryProductSection):
 * a scrolling row, View All opening exactly that category. It is resolved,
 * checked before publishing and shown in the app exactly like every other
 * shelf, and can be edited, previewed, hidden, moved, duplicated or deleted
 * like one. The same category can have several sections (each with its own
 * heading).
 */

import { useMemo, useState } from 'react';
import {
  CATEGORY_SHELF_KIND_LABEL,
  CATEGORY_SHELF_SOURCES,
  PRODUCT_SHELF_COUNT_LIMITS,
  PRODUCT_SHELF_SOURCE_INFO,
  type AdminCategoryOptionDto,
  type CategoryShelfKind,
  type CategoryShelfSource,
  type HomeLayoutContent,
} from '@shared';
import { Button, Field, Modal, inputClass } from '@/components/ui';
import { categoryPathLabel } from './homeShelfEditor';
import { CATEGORY_SECTION_COUNTS, categorySectionProblem, type CategoryProductSectionInput } from './categoryProductSectionRules';

export type { CategoryProductSectionInput } from './categoryProductSectionRules';

export function CategoryProductSectionDialog({
  options,
  layout,
  onAdd,
  onClose,
}: {
  options: readonly AdminCategoryOptionDto[];
  layout: HomeLayoutContent;
  onAdd: (input: CategoryProductSectionInput) => void;
  onClose: () => void;
}) {
  const byPath = useMemo(() => new Map(options.map((option) => [option.path, option])), [options]);
  const [kind, setKind] = useState<CategoryShelfKind>('main');
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [count, setCount] = useState(12);
  const [source, setSource] = useState<CategoryShelfSource>('latest');

  const choices = useMemo(
    () =>
      options
        .filter((option) => (kind === 'main' ? option.depth === 0 : option.depth > 0))
        .map((option) => ({ option, label: categoryPathLabel(option.path, byPath) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [options, byPath, kind],
  );
  const chosen = byPath.get(path);
  const input: CategoryProductSectionInput = { path, title, count, source };
  const problem = categorySectionProblem(input, options, layout);

  const choose = (next: string) => {
    setPath(next);
    // The category's name, until the admin types a heading of their own.
    if (!titleTouched) setTitle(byPath.get(next)?.name ?? '');
  };

  return (
    <Modal
      title="Add a category products section"
      subtitle="Products of one main category or subcategory, as a scrolling row with “View All”."
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {problem && path && <p className="mr-auto text-sm text-danger-600">{problem}</p>}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={problem !== null} onClick={() => onAdd({ ...input, title: title.trim() })}>
            Add section
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Section type">
          <div className="inline-flex overflow-hidden rounded-xl border border-gray-200" role="radiogroup" aria-label="Section type">
            {(['main', 'sub'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => {
                  setKind(value);
                  setPath('');
                  if (!titleTouched) setTitle('');
                }}
                className={`min-h-10 px-4 text-sm font-semibold ${kind === value ? 'bg-brand-600 text-white' : 'bg-white text-gray-700'}`}
              >
                {CATEGORY_SHELF_KIND_LABEL[value]}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={kind === 'main' ? 'Main category' : 'Subcategory'}
          hint={
            kind === 'main'
              ? 'Every product under it, its subcategories included.'
              : 'Only the products of this subcategory.'
          }
        >
          <select className={inputClass} value={path} onChange={(event) => choose(event.target.value)} aria-label={kind === 'main' ? 'Main category' : 'Subcategory'}>
            <option value="">Choose…</option>
            {choices.map(({ option, label }) => (
              <option key={option.path} value={option.path}>
                {label} ({option.productCount} product{option.productCount === 1 ? '' : 's'})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Heading" hint="What customers see above the products. The same category can have several sections, each with its own heading.">
          <input
            className={inputClass}
            value={title}
            maxLength={60}
            placeholder={chosen?.name ?? 'e.g. Fresh Vegetables'}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleTouched(true);
            }}
          />
        </Field>

        <Field label="How many products" hint={`Fewer show when fewer can be bought right now. At most ${PRODUCT_SHELF_COUNT_LIMITS.max}.`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORY_SECTION_COUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setCount(value)}
                aria-pressed={count === value}
                className={`rounded-lg border px-3 py-1 text-sm font-semibold ${count === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}
              >
                {value}
              </button>
            ))}
            <input
              type="number"
              aria-label="Custom number of products"
              // inputClass is full width; this box is a short number field.
              className={`${inputClass.replace('w-full', '')} w-20`}
              min={PRODUCT_SHELF_COUNT_LIMITS.min}
              max={PRODUCT_SHELF_COUNT_LIMITS.max}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            />
          </div>
        </Field>

        <Field label="Order" hint={PRODUCT_SHELF_SOURCE_INFO[source].hint}>
          <select className={inputClass} value={source} onChange={(event) => setSource(event.target.value as CategoryShelfSource)}>
            {CATEGORY_SHELF_SOURCES.map((value) => (
              <option key={value} value={value}>
                {PRODUCT_SHELF_SOURCE_INFO[value].label}
              </option>
            ))}
          </select>
        </Field>

        <p className="rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600">
          Only products customers can buy right now are shown (approved, in stock, from a store taking orders). A section with nothing to show is left out
          of the Home page automatically. Open the section after adding it to preview it, or to change anything.
        </p>
      </div>
    </Modal>
  );
}
