/**
 * Bulk import hardening — no database:
 *
 *   - XLSX / XML: adversarial and malformed input costs at most one linear
 *     pass (scaling ratios, absolute bounds, early aborts), never a rescan.
 *   - CSV: one cell / one row cannot grow without bound.
 *   - Barcode-derived SKUs: stable without any secret, length-checked.
 *   - Uploads: per-field and total limits enforced WHILE streaming, by the
 *     real multipart parser, with or without a Content-Length — and no temp
 *     file survives a refusal.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CsvParser } from '../../src/modules/product-import/csv';
import { scanXml } from '../../src/modules/product-import/xml-scan';
import { readSharedStrings, readSheetXml, readXlsxRecords } from '../../src/modules/product-import/xlsx';
import { cellsByKey, mapHeader, parseRow } from '../../src/modules/product-import/row-rules';
import { sellerSkuTag } from '../../src/modules/product-import/import-validation';
import { createImportUpload, type UploadLimits } from '../../src/modules/product-import/import-upload';
import { makeZip } from '../helpers/zip';

/* -------------------------------------------------------------------------- */
/* XML / XLSX CPU behaviour                                                   */
/* -------------------------------------------------------------------------- */

/** Median wall time of `fn` over 3 runs (ms). Errors are part of the run. */
function median(fn: () => void): number {
  const times = [0, 1, 2].map(() => {
    const t = process.hrtime.bigint();
    try {
      fn();
    } catch {
      /* a refusal is a valid, timed outcome */
    }
    return Number(process.hrtime.bigint() - t) / 1e6;
  });
  return times.sort((a, b) => a - b)[1]!;
}

/** Time at n and 4n: linear work grows ~4x; the old regexes grew ~16x or worse. */
function scaling(make: (n: number) => string, run: (xml: string) => void, n: number) {
  const small = make(n);
  const large = make(n * 4);
  const tSmall = Math.max(median(() => run(small)), 1);
  const tLarge = median(() => run(large));
  return { ratio: tLarge / tSmall, tLarge, chars: large.length };
}

const sheet = (xml: string) => readSheetXml(xml, [], 5000);

describe('XLSX parsing stays linear on adversarial XML', () => {
  it('the old attack (thousands of unclosed <row>) is refused at the first nested row', () => {
    const xml = `<sheetData>${'<row r="1">'.repeat(200_000)}`; // 2.2 MB; regexes needed hours
    const t = median(() => sheet(xml));
    expect(() => sheet(xml)).toThrow(/row inside a row/);
    expect(t).toBeLessThan(50);
  });

  it('unclosed cells and an unclosed tag at the end are refused after one pass', () => {
    expect(() => sheet(`<sheetData><row r="1">${'<c r="A1">'.repeat(50_000)}`)).toThrow(/damaged/);
    const tail = `<sheetData>${'x'.repeat(4_000_000)}<row`; // no closing '>' anywhere
    expect(() => sheet(tail)).toThrow(/damaged/);
    expect(median(() => sheet(tail))).toBeLessThan(500);
  });

  it('well-formed but huge rows, junk tags and long text all scale ~linearly', () => {
    const cases: Array<[string, (n: number) => string, (xml: string) => void, number]> = [
      ['valid rows', (n) => `<sheetData>${'<row><c t="inlineStr"><is><t>abc</t></is></c><c><v>12.5</v></c></row>'.repeat(n)}</sheetData>`, (x) => readSheetXml(x, [], 10_000_000), 10_000],
      ['empty rows', (n) => `<sheetData>${'<row/>'.repeat(n)}</sheetData>`, sheet, 10_000],
      ['self-closing junk tags', (n) => `<sheetData>${'<zz a="1"/>'.repeat(n)}</sheetData>`, sheet, 50_000],
      ['shared strings with phonetic runs', (n) => `<sst>${'<si><t>नमकीन</t><rPh><t>x</t></rPh></si>'.repeat(n)}</sst>`, (x) => readSharedStrings(x), 20_000],
      ['unterminated comment', (n) => `<sheetData>${'<row/>'.repeat(n)}<!-- ${'a'.repeat(n * 10)}`, sheet, 20_000],
    ];
    for (const [label, make, run, n] of cases) {
      const { ratio, tLarge, chars } = scaling(make, run, n);
      // Linear ≈ 4; allow generous noise but far below quadratic (≈16).
      expect({ label, ratio: ratio < 8 }).toEqual({ label, ratio: true });
      // Absolute bound: ~1 MB-scale inputs take well under a second.
      expect({ label, chars, fast: tLarge < 1500 }).toEqual({ label, chars, fast: true });
    }
  });

  it('refuses DOCTYPE/ENTITY declarations, oversized tags, deep nesting, huge text and oversized parts', () => {
    expect(() => scanXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>', {})).toThrow(/damaged/);
    expect(() => scanXml(`<c ${'a'.repeat(10_000)}>`, {})).toThrow(/damaged/);
    expect(() => scanXml('<a>'.repeat(100), {})).toThrow(/damaged/);
    expect(() => scanXml(`<t>${'x'.repeat(70_000)}</t>`, {})).toThrow(/damaged/);
    expect(() => scanXml('x'.repeat(21 * 1024 * 1024), {})).toThrow(/damaged/);
    expect(() => sheet(`<sheetData>${'<row/>'.repeat(50_001)}</sheetData>`)).toThrow(/too many rows/);
    expect(() => sheet(`<sheetData><row>${'<c><v>1</v></c>'.repeat(1001)}</row></sheetData>`)).toThrow(/too many cells/);
    expect(() => sheet(`<sheetData><row><c t="inlineStr"><is><t>${'y'.repeat(40_000)}</t></is></c></row></sheetData>`)).toThrow();
  });

  it('a malicious workbook end to end is refused quickly (archive + XML limits)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xlsx-adv-'));
    const file = path.join(dir, 'evil.xlsx');
    writeFileSync(
      file,
      makeZip([
        { name: '[Content_Types].xml', data: '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
        { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>' },
        { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
        { name: 'xl/worksheets/sheet1.xml', data: `<sheetData>${'<row r="1">'.repeat(1_000_000)}` }, // 11 MB, compresses to KBs
      ]),
    );
    // Deflated: the archive's bomb check refuses it before any XML is read.
    let t = Date.now();
    await expect(readXlsxRecords(file, 5000)).rejects.toThrow(/compressed bomb|row inside a row/);
    expect(Date.now() - t).toBeLessThan(2000);
    // Stored (no compression): it reaches the XML scanner, which refuses it in one pass.
    const stored = path.join(dir, 'evil-stored.xlsx');
    writeFileSync(
      stored,
      makeZip([
        { name: '[Content_Types].xml', data: '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>', store: true },
        { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>', store: true },
        { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', store: true },
        { name: 'xl/worksheets/sheet1.xml', data: `<sheetData>${'<row r="1">'.repeat(1_000_000)}`, store: true },
      ]),
    );
    t = Date.now();
    await expect(readXlsxRecords(stored, 5000)).rejects.toThrow(/row inside a row/);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('still reads a normal sheet (namespaced tags, inline strings, booleans, gaps)', () => {
    const rows = readSheetXml(
      '<x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="b"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="B3" t="inlineStr"><x:is><x:t>a &amp; b</x:t></x:is></x:c></x:row></x:sheetData>',
      ['sku'],
      10,
    );
    expect(rows).toEqual([
      { rowNumber: 1, cells: ['sku', '', 'TRUE'] },
      { rowNumber: 3, cells: ['', 'a & b'] },
    ]);
  });
});

describe('CSV cell and row caps', () => {
  it('one enormous cell or a row with hundreds of columns is refused', () => {
    expect(() => new CsvParser().feed(`a,${'x'.repeat(40_000)}\n`)).toThrow(/far too large/);
    expect(() => new CsvParser().feed(`${','.repeat(400)}\n`)).toThrow(/far too large/);
    const ok = new CsvParser();
    ok.feed(`a,${'x'.repeat(30_000)}\n`);
    expect(ok.records[0]![1]).toHaveLength(30_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Barcode-derived SKUs                                                       */
/* -------------------------------------------------------------------------- */

describe('barcode-derived SKUs', () => {
  it('the seller tag is a plain hash of the seller id: no secret, stable across key rotation', () => {
    const id = '5b0c5f7e-9a59-4f3e-9d0e-6a3f1c2b7d10';
    expect(sellerSkuTag(id)).toBe(createHash('sha256').update(`import-sku:${id}`).digest('hex').slice(0, 6).toUpperCase());
    expect(sellerSkuTag(id)).not.toBe(sellerSkuTag('0f7c1f2a-2b3c-4d5e-8f90-a1b2c3d4e5f6'));
  });

  it('a barcode too long to make a SKU from is a row error, never a truncated SKU', () => {
    const headers = ['barcode', 'product_name', 'category', 'mrp', 'selling_price', 'stock_quantity', 'unit', 'unit_value'];
    const map = mapHeader(headers);
    const row = (barcode: string) => parseRow(cellsByKey(map, [barcode, 'Thing', 'Snacks', '10', '9', '1', 'g', '50']), 'CREATE', 'ABC123');
    expect(row('8'.repeat(50)).parsed.sku).toBe(`BC-${'8'.repeat(50)}-ABC123`);
    const long = row('8'.repeat(52));
    expect(long.parsed.sku).toBeNull();
    expect(long.errors[0]!.message).toMatch(/too long to make a SKU/);
  });
});

/* -------------------------------------------------------------------------- */
/* Upload limits with the real multipart parser                               */
/* -------------------------------------------------------------------------- */

const LIMITS: UploadLimits = { sheetBytes: 64 * 1024, archiveBytes: 256 * 1024, imageBytes: 32 * 1024, maxImages: 5, totalBytes: 300 * 1024 };

function uploadApp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'import-upload-'));
  const app = express();
  app.post('/u', createImportUpload(LIMITS, async () => dir), (req: Request, res: Response) => {
    const files = Object.values((req.files as Record<string, Express.Multer.File[]>) ?? {}).flat();
    res.json({ files: files.map((f) => ({ field: f.fieldname, size: f.size })) });
  });
  app.use((error: { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status ?? 500).json({ code: error.code ?? 'ERR' });
  });
  return { app, dir, files: () => readdirSync(dir) };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

describe('upload limits are enforced while streaming', () => {
  it('accepts files within every limit', async () => {
    const { app, files } = uploadApp();
    const res = await request(app).post('/u').attach('file', Buffer.alloc(60 * 1024, 'a'), 'p.csv').attach('archive', Buffer.alloc(200 * 1024, 1), 'i.zip');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([
      { field: 'file', size: 60 * 1024 },
      { field: 'archive', size: 200 * 1024 },
    ]);
    expect(files()).toHaveLength(2);
  });

  it('a product file over its own limit is refused and leaves no temp file — even though the request total is allowed', async () => {
    const { app, files } = uploadApp();
    const res = await request(app).post('/u').attach('file', Buffer.alloc(65 * 1024, 'a'), 'p.csv');
    expect(res.status).toBe(413);
    await settle();
    expect(files()).toEqual([]);
  });

  it('one loose image over the per-image limit is refused; the earlier, valid images are removed too', async () => {
    const { app, files } = uploadApp();
    const res = await request(app)
      .post('/u')
      .attach('images', Buffer.alloc(10 * 1024, 1), 'a.jpg')
      .attach('images', Buffer.alloc(10 * 1024, 1), 'b.jpg')
      .attach('images', Buffer.alloc(33 * 1024, 1), 'c.jpg');
    expect(res.status).toBe(413);
    await settle();
    expect(files()).toEqual([]);
  });

  it('files each within their limit but over the request total are refused', async () => {
    const { app, files } = uploadApp();
    const res = await request(app).post('/u').attach('file', Buffer.alloc(60 * 1024, 'a'), 'p.csv').attach('archive', Buffer.alloc(250 * 1024, 1), 'i.zip');
    expect(res.status).toBe(413);
    await settle();
    expect(files()).toEqual([]);
  });

  it('a Content-Length that announces too much is refused before anything is read', async () => {
    const { app, files } = uploadApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ port, path: '/u', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=xx', 'Content-Length': String(50 * 1024 * 1024) } });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.write('--xx\r\n'); // a few bytes only; the server answers from the header
      });
      expect(status).toBe(413);
      expect(files()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('without any Content-Length (chunked), an endless stream is cut off and nothing stays on disk', async () => {
    const { app, files } = uploadApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      let sent = 0;
      const outcome = await new Promise<string>((resolve) => {
        const req = http.request({ port, path: '/u', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=xx', 'Transfer-Encoding': 'chunked' } });
        req.on('response', (res) => resolve(`status ${res.statusCode}`));
        req.on('error', () => resolve('connection cut'));
        req.write('--xx\r\nContent-Disposition: form-data; name="archive"; filename="i.zip"\r\nContent-Type: application/zip\r\n\r\n');
        const chunk = Buffer.alloc(16 * 1024, 7);
        const pump = () => {
          // Keeps sending far past every limit unless the server stops it.
          while (sent < 20 * 1024 * 1024) {
            sent += chunk.length;
            if (!req.write(chunk)) return void req.once('drain', pump);
          }
          req.end();
        };
        pump();
      });
      expect(['status 413', 'connection cut']).toContain(outcome);
      expect(sent).toBeLessThan(20 * 1024 * 1024); // the client was stopped well before it finished
      await settle();
      expect(files()).toEqual([]);
    } finally {
      server.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Structure, link entries, aborted uploads                                   */
/* -------------------------------------------------------------------------- */

describe('XML structure is verified, not just counted', () => {
  it('a closing tag must match the innermost open element, and nothing may stay open', () => {
    expect(() => scanXml('<a><b></a></b>', {})).toThrow(/damaged/);
    expect(() => scanXml('<row><c></row></c>', {})).toThrow(/damaged/);
    expect(() => scanXml('<a><b/></a><c>', {})).toThrow(/damaged/);
    expect(() => scanXml('</a>', {})).toThrow(/damaged/);
    expect(() => scanXml('<a><b>x</b><c/></a>', {})).not.toThrow();
    // A mismatched sheet is refused, not silently half-read.
    expect(() => sheet('<sheetData><row><c><v>1</v></row></c></sheetData>')).toThrow(/damaged/);
  });
});

describe('ZIP entries that are not plain files', () => {
  it('symbolic links and special files are flagged and never read; plain files and Windows-made entries are fine', async () => {
    const { SafeArchive } = await import('../../src/modules/product-import/archive');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'zip-links-'));
    const file = path.join(dir, 'links.zip');
    writeFileSync(
      file,
      makeZip([
        { name: 'link.jpg', data: '/etc/passwd', store: true, unixMode: 0o120777 },
        { name: 'fifo.jpg', data: 'x', store: true, unixMode: 0o010644 },
        { name: 'plain.jpg', data: 'x', store: true, unixMode: 0o100644 },
        { name: 'windows.jpg', data: 'x', store: true },
      ]),
    );
    const archive = await SafeArchive.open(file, { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096 });
    const problems = Object.fromEntries(archive.entries.map((e) => [e.fileName, e.problem]));
    expect(problems).toEqual({ 'link.jpg': expect.stringMatching(/link or special file/), 'fifo.jpg': expect.stringMatching(/link or special file/), 'plain.jpg': null, 'windows.jpg': null });
    await expect(archive.read(archive.entries[0]!)).rejects.toThrow(/link or special file/);
    archive.close();
  });
});

describe('an upload aborted mid-stream', () => {
  it('leaves no temp file behind', async () => {
    const { app, files } = uploadApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => {
        const req = http.request({ port, path: '/u', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=xx', 'Transfer-Encoding': 'chunked' } });
        req.on('error', () => resolve());
        req.on('response', () => resolve());
        req.write('--xx\r\nContent-Disposition: form-data; name="archive"; filename="i.zip"\r\nContent-Type: application/zip\r\n\r\n');
        req.write(Buffer.alloc(40 * 1024, 7)); // within limits, then the client goes away
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 150);
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(files()).toEqual([]);
    } finally {
      server.close();
    }
  });
});
