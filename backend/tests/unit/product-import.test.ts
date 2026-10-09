/**
 * Bulk product import — the pieces that need no database: CSV and .xlsx
 * reading, safe ZIP handling, header mapping and per-row rules.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvParser, csvCell, readCsvRecords } from '../../src/modules/product-import/csv';
import { SafeArchive, looksLikeZip } from '../../src/modules/product-import/archive';
import { normaliseNumber, readXlsxRecords } from '../../src/modules/product-import/xlsx';
import {
  hasValidGtinCheckDigit,
  headerProblems,
  mapHeader,
  parseBarcode,
  parseImageNames,
  parseRow,
  parseRupees,
  parseStock,
  parseUnit,
  cellsByKey,
} from '../../src/modules/product-import/row-rules';
import { identifierCandidates } from '../../src/modules/product-import/import-validation';
import { makeXlsx, makeZip } from '../helpers/zip';

const dir = mkdtempSync(path.join(os.tmpdir(), 'import-unit-'));
let n = 0;
function file(content: Buffer | string): string {
  const p = path.join(dir, `f${(n += 1)}`);
  writeFileSync(p, content);
  return p;
}
async function csv(content: Buffer | string, maxRows = 100) {
  const out: { rowNumber: number; cells: string[] }[] = [];
  for await (const r of readCsvRecords(file(content), maxRows)) out.push(r);
  return out;
}

describe('CSV reading', () => {
  it('handles quotes, escaped quotes, commas and line breaks inside fields, CRLF and a BOM', async () => {
    const rows = await csv('﻿seller_sku,product_name\r\nRB-250,"Red Bull, 250 ml"\r\nX-1,"Say ""hi""\nsecond line"\r\n');
    expect(rows).toEqual([
      { rowNumber: 1, cells: ['seller_sku', 'product_name'] },
      { rowNumber: 2, cells: ['RB-250', 'Red Bull, 250 ml'] },
      { rowNumber: 3, cells: ['X-1', 'Say "hi"\nsecond line'] },
    ]);
  });

  it('keeps spreadsheet row numbers across blank lines', async () => {
    const rows = await csv('a,b\n1,2\n\n3,4\n');
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 4]);
  });

  it('an escaped quote split across two chunks', () => {
    const parser = new CsvParser();
    parser.feed('a,"x"');
    parser.feed('"y"\n');
    parser.end();
    expect(parser.records).toEqual([['a', 'x"y']]);
  });

  it('refuses an unclosed quote, non-UTF-8 text and binary files', async () => {
    await expect(csv('a,b\n"1,2\n')).rejects.toThrow(/never closed/);
    await expect(csv(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x0a]))).rejects.toThrow(/UTF-8/);
    await expect(csv(Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).rejects.toThrow(/not a text CSV/);
  });

  it('stops past the row limit without reading the rest', async () => {
    await expect(csv(`h\n${'x\n'.repeat(11)}`, 10)).rejects.toThrow(/more than 10 product rows/);
    expect(await csv(`h\n${'x\n'.repeat(10)}`, 10)).toHaveLength(11);
  });

  it('report cells are neutralised against formula injection', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+91')).toBe("'+91");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(12)).toBe('12');
  });
});

describe('.xlsx reading', () => {
  it('reads the first sheet: shared strings, numbers kept exact', async () => {
    const rows = await readXlsxRecords(
      file(makeXlsx([['seller_sku', 'barcode', 'mrp', 'hindi_name'], ['RB-250', 8901234567890, 49.900000000000006, 'रेड बुल'], [null, null, null, null], ['B', 12, 10, null]])),
      100,
    );
    expect(rows).toEqual([
      { rowNumber: 1, cells: ['seller_sku', 'barcode', 'mrp', 'hindi_name'] },
      { rowNumber: 2, cells: ['RB-250', '8901234567890', '49.9', 'रेड बुल'] },
      { rowNumber: 4, cells: ['B', '12', '10'] },
    ]);
  });

  it('refuses macro workbooks and non-workbooks', async () => {
    await expect(readXlsxRecords(file(makeXlsx([['a']], { macro: true })), 10)).rejects.toThrow(/Macro-enabled/);
    await expect(readXlsxRecords(file(makeZip([{ name: 'a.txt', data: 'x' }])), 10)).rejects.toThrow(/not an Excel/);
    await expect(readXlsxRecords(file('not a zip at all'), 10)).rejects.toThrow(/could not be opened/);
  });

  it('normaliseNumber', () => {
    expect(normaliseNumber('8901234567890')).toBe('8901234567890');
    expect(normaliseNumber('1.2E+3')).toBe('1200');
    expect(normaliseNumber('0.30000000000000004')).toBe('0.3');
  });
});

describe('safe ZIP handling', () => {
  const limits = { maxEntries: 5, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };

  it('lists files by base name and skips folders and OS clutter', async () => {
    const archive = await SafeArchive.open(
      file(makeZip([{ name: 'photos/RB-250.jpg', data: 'x' }, { name: '__MACOSX/._RB-250.jpg', data: 'y' }, { name: '.DS_Store', data: 'z' }])),
      limits,
    );
    expect(archive.entries.map((e) => [e.path, e.fileName])).toEqual([['photos/RB-250.jpg', 'RB-250.jpg']]);
    expect((await archive.read(archive.entries[0]!)).toString()).toBe('x');
    archive.close();
  });

  it('refuses path traversal and absolute paths outright', async () => {
    await expect(SafeArchive.open(file(makeZip([{ name: '../../etc/evil.jpg', data: 'x' }])), limits)).rejects.toThrow(/unsafe/);
    await expect(SafeArchive.open(file(makeZip([{ name: '/abs/evil.jpg', data: 'x' }])), limits)).rejects.toThrow(/unsafe/);
  });

  it('refuses too many entries', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.jpg`, data: 'x' }));
    await expect(SafeArchive.open(file(makeZip(entries)), limits)).rejects.toThrow(/has 6 files; the limit is 5/);
  });

  it('flags oversized entries and compression bombs; never reads them', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0); // compresses ~1000x
    const archive = await SafeArchive.open(
      file(makeZip([{ name: 'big.jpg', data: big }, { name: 'ok.jpg', data: Buffer.alloc(100, 1), store: true }])),
      { ...limits, maxEntryBytes: 4 * 1024 * 1024 },
    );
    expect(archive.entries.find((e) => e.fileName === 'big.jpg')?.problem).toMatch(/bomb/);
    await expect(archive.read(archive.entries[0]!)).rejects.toThrow(/bomb/);
    archive.close();

    const tooBig = await SafeArchive.open(file(makeZip([{ name: 'big.jpg', data: Buffer.alloc(2 * 1024 * 1024, 7), store: true }])), limits);
    expect(tooBig.entries[0]!.problem).toMatch(/larger than 1 MB/);
    tooBig.close();
  });

  it('a header that under-states the size cannot sneak more bytes past the cap', async () => {
    const archive = await SafeArchive.open(file(makeZip([{ name: 'liar.jpg', data: Buffer.alloc(5000, 3), declaredSize: 10 }])), limits);
    await expect(archive.read(archive.entries[0]!)).rejects.toThrow();
    archive.close();
  });

  it('looksLikeZip', () => {
    expect(looksLikeZip(makeZip([{ name: 'a', data: 'b' }]).subarray(0, 8))).toBe(true);
    expect(looksLikeZip(Buffer.from('MZ\x90\x00'))).toBe(false);
  });
});

describe('cell rules', () => {
  it('prices: rupees with up to 2 decimals; malformed values are errors, never zero', () => {
    expect(parseRupees('120', 'MRP')).toEqual({ ok: true, value: 12000 });
    expect(parseRupees('119.5', 'MRP')).toEqual({ ok: true, value: 11950 });
    expect(parseRupees('0.05', 'MRP')).toEqual({ ok: true, value: 5 });
    for (const bad of ['1,200', '₹120', 'Rs 120', '12.345', '-5', 'abc', '0', '0.00']) expect(parseRupees(bad, 'MRP').ok, bad).toBe(false);
  });

  it('stock, units, barcodes, image names', () => {
    expect(parseStock('0')).toEqual({ ok: true, value: 0 });
    for (const bad of ['-1', '2.5', 'ten', '100001']) expect(parseStock(bad).ok, bad).toBe(false);
    expect(parseUnit('Ltr')).toEqual({ ok: true, value: 'L' });
    expect(parseUnit('pcs')).toEqual({ ok: true, value: 'PIECE' });
    expect(parseUnit('crate').ok).toBe(false);
    expect(hasValidGtinCheckDigit('8901058851298')).toBe(true);
    expect(parseBarcode('8901058851298')).toEqual({ ok: true, value: { code: '8901058851298', warning: null } });
    expect(parseBarcode('8901058851290')).toMatchObject({ ok: true, value: { warning: expect.stringMatching(/check digit/) } });
    expect(parseBarcode('8.90106E+12')).toMatchObject({ ok: false, message: expect.stringMatching(/scientific/) });
    expect(parseImageNames('a.jpg | b.webp;c.png')).toEqual({ ok: true, value: ['a.jpg', 'b.webp', 'c.png'] });
    expect(parseImageNames('photos/a.jpg').ok).toBe(false);
    expect(parseImageNames('setup.exe').ok).toBe(false);
  });

  it('header aliases, unknown and missing columns', () => {
    const map = mapHeader(['SKU', 'Product Name', 'Category', 'MRP', 'Price', 'Qty', 'UOM', 'Pack Size', 'Notes']);
    expect([...map.index.keys()]).toEqual(['seller_sku', 'product_name', 'category', 'mrp', 'selling_price', 'stock_quantity', 'unit', 'unit_value']);
    expect(map.ignored).toEqual(['Notes']);
    expect(headerProblems(map, 'CREATE')).toEqual([]);
    expect(headerProblems(mapHeader(['seller_sku', 'mrp']), 'CREATE').join(' ')).toMatch(/product_name, category, selling_price, stock_quantity, unit, unit_value/);
    expect(headerProblems(mapHeader(['seller_sku', 'mrp']), 'UPDATE')).toEqual([]);
    expect(headerProblems(mapHeader(['sku', 'seller sku']), 'UPDATE').join(' ')).toMatch(/appear twice/);
  });

  const headers = ['seller_sku', 'barcode', 'product_name', 'category', 'mrp', 'selling_price', 'stock_quantity', 'unit', 'unit_value', 'variant_name', 'image_filename', 'additional_image_filenames', 'is_active'];
  const row = (values: Partial<Record<string, string>>, mode: 'CREATE' | 'UPDATE' = 'CREATE') => {
    const map = mapHeader(headers);
    return parseRow(cellsByKey(map, headers.map((h) => values[h] ?? '')), mode, 'TAG01');
  };
  const good = { seller_sku: 'rb-250', product_name: 'Red Bull 250 ml', category: 'Cold Drinks', mrp: '125', selling_price: '120', stock_quantity: '24', unit: 'ml', unit_value: '250' };

  it('a complete CREATE row', () => {
    const r = row({ ...good, image_filename: 'RB-250.jpg', additional_image_filenames: 'RB-250-back.jpg' });
    expect(r.errors).toEqual([]);
    expect(r.parsed).toMatchObject({ sku: 'RB-250', mrpPaise: 12500, pricePaise: 12000, stockQty: 24, unit: 'ML', unitValue: 250, variantName: '250 ml', imageNames: ['RB-250.jpg', 'RB-250-back.jpg'], primaryImageGiven: true });
  });

  it('CREATE: empty required cells are errors (stock is never assumed 0); price above MRP is refused', () => {
    const r = row({ ...good, stock_quantity: '', selling_price: '130' });
    expect(r.errors.map((e) => e.message)).toEqual(expect.arrayContaining(['Stock quantity is required.', 'Selling price cannot exceed MRP.']));
    expect(r.parsed.stockQty).toBeUndefined();
  });

  it('no SKU: a stable, seller-specific SKU from the barcode; neither = error', () => {
    const r = row({ ...good, seller_sku: '', barcode: '8901058851298' });
    expect(r.parsed).toMatchObject({ sku: 'BC-8901058851298-TAG01', skuFromBarcode: true });
    expect(r.warnings[0]?.message).toMatch(/made from the barcode/);
    expect(row({ ...good, seller_sku: '' }).errors[0]?.message).toMatch(/seller_sku \(or a barcode\)/);
  });

  it('UPDATE: empty cells mean "unchanged"; a row with nothing to change is an error', () => {
    const r = row({ seller_sku: 'RB-250', selling_price: '99' }, 'UPDATE');
    expect(r.errors).toEqual([]);
    expect(r.parsed).toEqual({ sku: 'RB-250', skuFromBarcode: false, pricePaise: 9900, imageNames: [] });
    expect(row({ seller_sku: 'RB-250' }, 'UPDATE').errors[0]?.message).toMatch(/Nothing to change/);
  });

  it('image file names from the photos-only upload', () => {
    expect(identifierCandidates('OIL-1L-front.webp')).toEqual(['OIL-1L-front', 'OIL-1L']);
    expect(identifierCandidates('RB-250.jpg')).toEqual(['RB-250']);
    expect(identifierCandidates('8901058851298_2.png')).toEqual(['8901058851298_2', '8901058851298']);
  });
});
