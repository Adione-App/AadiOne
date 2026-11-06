/**
 * Home Page Builder → "Category products" sections — run with `npm run test:unit`.
 * The dialog's rules (src/pages/categoryProductSectionRules.ts) and the
 * shared section helpers it uses; the page itself needs a browser, so its
 * wiring is checked on the source. The server side:
 * backend tests/integration/home-category-sections.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HOME_LAYOUT,
  PRODUCT_SHELF_COUNT_PRESETS,
  addHomeSection,
  categoryShelfKind,
  createCategoryProductSection,
  homeLayoutProblems,
  productShelfViewAllProblem,
  resolveHomeLayout,
  type AdminCategoryOptionDto,
} from '../src/shared/index.ts';
import { CATEGORY_SECTION_COUNTS, categorySectionProblem } from '../src/pages/categoryProductSectionRules.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const option = (path: string, name: string): AdminCategoryOptionDto => ({
  id: path,
  path,
  parentPath: path.includes('/') ? path.split('/')[0]! : null,
  depth: path.includes('/') ? 1 : 0,
  name,
  nameHi: null,
  imageUrl: null,
  sellerCount: 1,
  productCount: 5,
});
const options = [option('grocery', 'Grocery'), option('grocery/dairy', 'Dairy Products'), option('vegetables-fruits/fruits', 'Fruits')];
const layout = () => structuredClone(resolveHomeLayout(DEFAULT_HOME_LAYOUT));

describe('category products section', () => {
  it('becomes an ordinary product shelf: one category, a scrolling row, View All to exactly that category', () => {
    const section = createCategoryProductSection('shelf-dairy', { path: 'grocery/dairy', title: '  Dairy Products ', count: 12, source: 'bestselling' })!;
    assert.equal(section.key, 'product_shelf');
    assert.equal(section.title, 'Dairy Products');
    assert.deepEqual(section.shelf!.categoryPaths, ['grocery/dairy']);
    assert.equal(section.shelf!.source, 'bestselling');
    assert.equal(section.shelf!.count, 12);
    assert.equal(section.shelf!.layout, 'carousel');
    assert.deepEqual(section.shelf!.viewAll, { type: 'category', path: 'grocery/dairy' });
    assert.equal(productShelfViewAllProblem(section.shelf!), null);
    assert.equal(categoryShelfKind(section.shelf), 'sub');
    assert.equal(categoryShelfKind(createCategoryProductSection('shelf-g', { path: 'grocery', title: 'Grocery', count: 10 })!.shelf), 'main');
  });

  it('a page of them passes the publish checks — the same category twice included, each with its own heading', () => {
    let next = layout();
    for (const [id, path, title] of [
      ['shelf-grocery', 'grocery', 'Grocery'],
      ['shelf-dairy', 'grocery/dairy', 'Dairy Products'],
      ['shelf-fruits', 'vegetables-fruits/fruits', 'Fruits'],
      ['shelf-fruits-2', 'vegetables-fruits/fruits', 'Fruits of the season'],
    ] as const) {
      next = addHomeSection(next, createCategoryProductSection(id, { path, title, count: 12 })!)!;
    }
    assert.deepEqual(homeLayoutProblems(next), []);
  });

  it('only other shelves (several categories, hand-picked, whole catalogue) have no category label', () => {
    const shelf = createCategoryProductSection('shelf-x', { path: 'grocery', title: 'X', count: 10 })!.shelf!;
    assert.equal(categoryShelfKind({ ...shelf, categoryPaths: ['grocery', 'grocery/dairy'] }), null);
    assert.equal(categoryShelfKind({ ...shelf, source: 'manual' }), null);
    assert.equal(categoryShelfKind({ ...shelf, categoryPaths: [] }), null);
    assert.equal(categoryShelfKind(null), null);
  });

  it('the dialog asks for a live category, a heading of its own and a count within 1–30', () => {
    const base = { path: 'grocery/dairy', title: 'Dairy Products', count: 12, source: 'latest' as const };
    assert.equal(categorySectionProblem(base, options, layout()), null);
    assert.match(categorySectionProblem({ ...base, path: '' }, options, layout())!, /Choose the category/);
    assert.match(categorySectionProblem({ ...base, path: 'grocery/snacks' }, options, layout())!, /Choose the category/);
    assert.match(categorySectionProblem({ ...base, title: '  ' }, options, layout())!, /heading/);
    assert.match(categorySectionProblem({ ...base, count: 0 }, options, layout())!, /between 1 and 30/);
    assert.match(categorySectionProblem({ ...base, count: 31 }, options, layout())!, /between 1 and 30/);
    const withDairy = addHomeSection(layout(), createCategoryProductSection('shelf-dairy', base)!)!;
    assert.match(categorySectionProblem({ ...base, title: 'dairy products' }, options, withDairy)!, /already has this heading/);
    assert.equal(categorySectionProblem({ ...base, title: 'More dairy' }, options, withDairy), null);
  });

  it('10, 12 and 15 are offered first; 12 is also a preset in the shelf editor', () => {
    assert.deepEqual([...CATEGORY_SECTION_COUNTS], [10, 12, 15]);
    assert.ok((PRODUCT_SHELF_COUNT_PRESETS as readonly number[]).includes(12));
  });

  it('the builder offers "Category products" and labels each section main / subcategory', () => {
    const builder = read('src/pages/HomeBuilder.tsx');
    assert.match(builder, /setAddingCategorySection\(true\)/);
    assert.match(builder, /createCategoryProductSection\(id, input\)/);
    assert.match(builder, /<CategoryProductSectionDialog/);
    assert.match(builder, /CATEGORY_SHELF_KIND_LABEL\[kind\]/);
    // Categories come from the live marketplace (GET /admin/content/category-options), never typed in.
    const dialog = read('src/pages/categoryProductSection.tsx');
    assert.match(dialog, /option\.depth === 0 : option\.depth > 0/);
  });
});
