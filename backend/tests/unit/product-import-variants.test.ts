/**
 * Pure rules behind importing / exporting products with sizes: option
 * columns, the export's formula guard, rupee formatting and shared product
 * details across a product's rows.
 */

import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/modules/product-import/csv';
import { shareProductCells } from '../../src/modules/product-import/import-groups';
import { rupees } from '../../src/modules/product-import/product-export';
import { parseOptions, parseRow, sameOptionName, unguardCell } from '../../src/modules/product-import/row-rules';

describe('option columns', () => {
  it('reads size, color and one named option', () => {
    expect(parseOptions({ size: ' M ', color: 'Blue', option_name: 'Material', option_value: 'Cotton' })).toEqual({
      values: { Size: 'M', Color: 'Blue', Material: 'Cotton' },
      errors: [],
    });
    expect(parseOptions({}).values).toEqual({});
  });

  it('refuses half an option, and an option_name that is really size or colour', () => {
    expect(parseOptions({ option_name: 'Material' }).errors[0]!.field).toBe('option_value');
    expect(parseOptions({ option_value: 'Cotton' }).errors[0]!.field).toBe('option_name');
    expect(parseOptions({ option_name: 'Colour', option_value: 'Red' }).errors[0]!.message).toMatch(/color column/);
    expect(parseOptions({ size: 'x'.repeat(41) }).errors[0]!.message).toMatch(/at most 40/);
  });

  it('compares option names case-insensitively, with Colour = Color', () => {
    expect(sameOptionName('colour', 'Color')).toBe(true);
    expect(sameOptionName('SIZE', 'Size')).toBe(true);
    expect(sameOptionName('Size', 'Fit')).toBe(false);
  });

  it('a row with options is named from them, not from its unit', () => {
    const row = parseRow(
      { seller_sku: 'TEE-M', parent_sku: 'tee', product_name: 'Tee', category: 'Clothing', mrp: '10', selling_price: '9', stock_quantity: '1', unit: 'piece', unit_value: '1', size: 'M' },
      'CREATE',
      'TAG',
    );
    expect(row.errors).toEqual([]);
    expect(row.parsed).toMatchObject({ parentSku: 'TEE', options: { Size: 'M' } });
    expect(row.parsed.variantName).toBeUndefined();
  });
});

describe('export / re-import text', () => {
  it('a formula-looking cell is guarded on export and restored on import', () => {
    for (const text of ['=SUM(A1)', '+91 pack', '-50% deal', '@home']) {
      const cell = csvCell(text);
      expect(cell.startsWith("'")).toBe(true);
      expect(unguardCell(cell)).toBe(text);
    }
    expect(unguardCell("'quoted name")).toBe("'quoted name");
    expect(unguardCell('Plain')).toBe('Plain');
  });

  it('prices are written the way the import reads them', () => {
    expect(rupees(12000)).toBe('120');
    expect(rupees(11950)).toBe('119.50');
    expect(rupees(5)).toBe('0.05');
  });
});

describe('shared product details across a product’s rows', () => {
  const rows = () => [
    { rowNumber: 2, excluded: false, cells: { parent_sku: 'TEE', product_name: 'Tee', category: 'Clothing', mrp: '499', selling_price: '399', unit: 'piece', unit_value: '1' } },
    { rowNumber: 3, excluded: false, cells: { parent_sku: 'tee', product_name: '  tee ', mrp: '', selling_price: '429' } },
    { rowNumber: 4, excluded: false, cells: { parent_sku: 'TEE', product_name: 'Other', category: '' } },
    { rowNumber: 5, excluded: true, cells: { parent_sku: 'TEE', product_name: 'Ignored' } },
  ];

  it('fills empty details from the product, reports contradictions, ignores excluded rows', () => {
    const list = rows();
    const issues = shareProductCells(list, 'CREATE');
    expect(list[1]!.cells).toMatchObject({ category: 'Clothing', mrp: '499', selling_price: '429', unit: 'piece' });
    expect(list[2]!.cells.category).toBe('Clothing');
    expect(issues.get(4)![0]!.message).toMatch(/Different product name from row 2/);
    expect(issues.has(3)).toBe(false);
    expect(issues.has(5)).toBe(false);
  });

  it('in Update mode an empty price stays "unchanged" (no inheritance)', () => {
    const list = rows();
    shareProductCells(list, 'UPDATE');
    expect(list[1]!.cells.mrp).toBe('');
  });
});
