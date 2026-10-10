/**
 * Minimal, read-only .xlsx reader for bulk imports: the FIRST worksheet's
 * cell values as text, nothing else (no formulas evaluated, no macros, no
 * external links, no styles). An .xlsx file is a ZIP of XML parts; it is
 * opened with SafeArchive, every part is size-capped, and every part is read
 * with the linear, bounded tokenizer in xml-scan.ts — never with regexes over
 * the document — so malformed or adversarial XML costs at most one pass.
 *
 * Numbers come back as Excel stored them, normalised so 8901234567890 stays
 * 8901234567890 (never 8.90123E+12) and 49.900000000000006 becomes 49.9.
 */

import { SafeArchive } from './archive';
import { SheetError } from './csv';
import { DEFAULT_XML_LIMITS, attr, decodeXml, scanXml } from './xml-scan';

export interface SheetRecord {
  /** Spreadsheet row number (1 = the header row). */
  rowNumber: number;
  cells: string[];
}

/** Workbook-level limits. A 5000-row, 17-column sheet is ~2–5 MB of XML. */
export const XLSX_LIMITS = {
  archive: { maxEntries: 500, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
  /** sheet1.xml / sharedStrings.xml */
  maxPartChars: 20 * 1024 * 1024,
  /** workbook.xml, its .rels, [Content_Types].xml */
  maxSmallPartChars: 1024 * 1024,
  /** <row> elements, empty ones included. */
  maxRowElements: 50_000,
  /** <c> elements in one row. */
  maxCellsPerRow: 1_000,
  /** Columns kept (A..GR); cells further right are ignored. */
  maxColumn: 200,
  maxSharedStrings: 500_000,
  /** One cell's text (Excel's own limit is 32767). */
  maxCellChars: 32_767,
};

/** Local element name: `x:row` -> `row`. */
const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** "AB12" -> 27 (0-based column); -1 when not a cell reference. */
function columnIndex(ref: string): number {
  let index = 0;
  let i = 0;
  for (; i < ref.length && i < 4; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return i === 0 ? -1 : index - 1;
}

export function normaliseNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) return value.toFixed(0);
  return String(Number(value.toFixed(6)));
}

async function readPart(archive: SafeArchive, partPath: string, maxChars: number): Promise<string | null> {
  const entry = archive.find(partPath);
  if (!entry) return null;
  if (entry.uncompressedSize > maxChars) throw new SheetError('The Excel file is too large. Keep it under 5000 rows, or upload a CSV.');
  return (await archive.read(entry)).toString('utf8');
}

const small = { ...DEFAULT_XML_LIMITS, maxLength: XLSX_LIMITS.maxSmallPartChars };
const big = { ...DEFAULT_XML_LIMITS, maxLength: XLSX_LIMITS.maxPartChars };

/** xl/sharedStrings.xml -> the strings, in order. Exported for the CPU regression tests. */
export function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let inT = false;
  let phonetic = 0;
  let current = '';
  scanXml(
    xml,
    {
      open(name, _attrs, selfClosing) {
        const tag = local(name);
        if (tag === 'si') {
          if (selfClosing) out.push('');
          else {
            inSi = true;
            current = '';
          }
        } else if (tag === 'rPh' && !selfClosing) phonetic += 1;
        else if (tag === 't' && inSi && phonetic === 0 && !selfClosing) inT = true;
      },
      close(name) {
        const tag = local(name);
        if (tag === 't') inT = false;
        else if (tag === 'rPh') phonetic = Math.max(0, phonetic - 1);
        else if (tag === 'si' && inSi) {
          inSi = false;
          if (out.length >= XLSX_LIMITS.maxSharedStrings) throw new SheetError('The Excel file has too many distinct texts. Save it as CSV and upload that.');
          out.push(current);
        }
      },
      text(text) {
        if (!inT) return;
        current += decodeXml(text);
        if (current.length > XLSX_LIMITS.maxCellChars) throw new SheetError('A cell in the Excel file has too much text.');
      },
    },
    big,
  );
  return out;
}

/** A worksheet part -> its non-empty rows. Exported for the CPU regression tests. */
export function readSheetXml(xml: string, shared: string[], maxRows: number): SheetRecord[] {
  const records: SheetRecord[] = [];
  let rowElements = 0;
  let row: { rowNumber: number; cells: string[]; count: number } | null = null;
  let cell: { col: number; type: string | null; v: string; is: string } | null = null;
  let lastRow = 0;
  let nextCol = 0;
  let inV = false;
  let inIs = false;
  let inT = false;

  const finishCell = () => {
    if (!row || !cell) return;
    const c = cell;
    cell = null;
    inV = inIs = inT = false;
    if (c.col < 0 || c.col >= XLSX_LIMITS.maxColumn) return;
    let value = '';
    if (c.type === 's') value = shared[Number(c.v)] ?? '';
    else if (c.type === 'inlineStr') value = c.is;
    else if (c.type === 'str' || c.type === 'e') value = decodeXml(c.v);
    else if (c.type === 'b') value = c.v === '1' ? 'TRUE' : 'FALSE';
    else if (c.v !== '') value = normaliseNumber(decodeXml(c.v));
    while (row.cells.length < c.col) row.cells.push('');
    row.cells[c.col] = value;
  };
  const finishRow = () => {
    if (!row) return;
    const r = row;
    row = null;
    if (r.cells.every((x) => x.trim() === '')) return;
    records.push({ rowNumber: r.rowNumber, cells: r.cells });
    if (records.length > maxRows + 1) {
      throw new SheetError(`The file has more than ${maxRows} product rows. Split it into smaller files and upload them one by one.`);
    }
  };

  scanXml(
    xml,
    {
      open(name, attrs, selfClosing) {
        const tag = local(name);
        if (tag === 'row') {
          if (row) throw new SheetError('The Excel file is damaged (a row inside a row). Save it again as .xlsx or CSV.');
          rowElements += 1;
          if (rowElements > XLSX_LIMITS.maxRowElements) throw new SheetError('The Excel sheet has too many rows. Keep it under 5000 products per file.');
          const r = Number(attr(attrs, 'r'));
          const rowNumber = Number.isInteger(r) && r > lastRow ? r : lastRow + 1;
          lastRow = rowNumber;
          nextCol = 0;
          row = { rowNumber, cells: [], count: 0 };
          if (selfClosing) finishRow();
        } else if (tag === 'c') {
          if (!row || cell) throw new SheetError('The Excel file is damaged (a cell outside a row). Save it again as .xlsx or CSV.');
          row.count += 1;
          if (row.count > XLSX_LIMITS.maxCellsPerRow) throw new SheetError('A row in the Excel file has too many cells.');
          const ref = attr(attrs, 'r');
          const col = ref ? columnIndex(ref) : nextCol;
          nextCol = col + 1;
          cell = { col, type: attr(attrs, 't'), v: '', is: '' };
          if (selfClosing) finishCell();
        } else if (cell && !selfClosing) {
          if (tag === 'v') inV = true;
          else if (tag === 'is') inIs = true;
          else if (tag === 't' && inIs) inT = true;
        }
      },
      close(name) {
        const tag = local(name);
        if (tag === 'v') inV = false;
        else if (tag === 't') inT = false;
        else if (tag === 'is') inIs = false;
        else if (tag === 'c') finishCell();
        else if (tag === 'row') finishRow();
      },
      text(text) {
        if (!cell) return;
        if (inV) cell.v += text;
        else if (inT) cell.is += decodeXml(text);
        if (cell.v.length + cell.is.length > XLSX_LIMITS.maxCellChars) throw new SheetError('A cell in the Excel file has too much text.');
      },
    },
    big,
  );
  if (row || cell) throw new SheetError('The Excel file is damaged (the sheet ends inside a row). Save it again as .xlsx or CSV.');
  return records;
}

/** Reads the first worksheet; stops with an error past `maxRows` data rows (plus the header). */
export async function readXlsxRecords(filePath: string, maxRows: number): Promise<SheetRecord[]> {
  const archive = await SafeArchive.open(filePath, XLSX_LIMITS.archive, 'Excel file');
  try {
    const types = await readPart(archive, '[Content_Types].xml', XLSX_LIMITS.maxSmallPartChars);
    if (!types || !types.includes('spreadsheetml')) {
      throw new SheetError('This is not an Excel .xlsx workbook. Upload a .xlsx or .csv file.');
    }
    if (/macroEnabled/i.test(types)) {
      throw new SheetError('Macro-enabled workbooks are not accepted. Save the file as a normal .xlsx (or CSV) and upload again.');
    }

    let relId: string | null = null;
    scanXml(
      (await readPart(archive, 'xl/workbook.xml', XLSX_LIMITS.maxSmallPartChars)) ?? '',
      {
        open(name, attrs) {
          if (relId === null && local(name) === 'sheet') relId = attr(attrs, 'r:id');
        },
      },
      small,
    );
    let target: string | null = null;
    scanXml(
      (await readPart(archive, 'xl/_rels/workbook.xml.rels', XLSX_LIMITS.maxSmallPartChars)) ?? '',
      {
        open(name, attrs) {
          if (local(name) === 'Relationship' && relId !== null && attr(attrs, 'Id') === relId) target = attr(attrs, 'Target');
        },
      },
      small,
    );
    if (target === null) throw new SheetError('The Excel file has no worksheet.');
    const t: string = target;
    const sheetPath = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;

    const sharedXml = await readPart(archive, 'xl/sharedStrings.xml', XLSX_LIMITS.maxPartChars);
    const shared = sharedXml ? readSharedStrings(sharedXml) : [];
    const sheet = await readPart(archive, sheetPath, XLSX_LIMITS.maxPartChars);
    if (sheet === null) throw new SheetError('The Excel file has no worksheet.');
    return readSheetXml(sheet, shared, maxRows);
  } finally {
    archive.close();
  }
}
