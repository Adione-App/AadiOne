/**
 * Minimal, read-only .xlsx reader for bulk imports: the FIRST worksheet's
 * cell values as text, nothing else (no formulas evaluated, no macros, no
 * external links, no styles). An .xlsx file is a ZIP of XML parts; it is
 * opened with the same SafeArchive limits as image archives, and every part
 * read is size-capped.
 *
 * Numbers come back as Excel stored them, normalised so 8901234567890 stays
 * 8901234567890 (never 8.90123E+12) and 49.900000000000006 becomes 49.9.
 */

import { SafeArchive } from './archive';
import { SheetError } from './csv';

export interface SheetRecord {
  /** Spreadsheet row number (1 = the header row). */
  rowNumber: number;
  cells: string[];
}

const XLSX_LIMITS = { maxEntries: 2000, maxEntryBytes: 60 * 1024 * 1024, maxTotalBytes: 400 * 1024 * 1024 };

function decodeXml(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
      if (ref === 'amp') return '&';
      if (ref === 'lt') return '<';
      if (ref === 'gt') return '>';
      if (ref === 'quot') return '"';
      if (ref === 'apos') return "'";
      const code = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]!) : null;
}

/** Text of all <t> runs, skipping phonetic hints (<rPh>). */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decodeXml(m[1] ?? '');
  return out;
}

/** "AB12" -> 27 (0-based column). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

export function normaliseNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) return value.toFixed(0);
  return String(Number(value.toFixed(6)));
}

async function readPart(archive: SafeArchive, partPath: string): Promise<string | null> {
  const entry = archive.find(partPath);
  if (!entry) return null;
  return (await archive.read(entry)).toString('utf8');
}

/** Reads the first worksheet; stops with an error past `maxRows` data rows (plus the header). */
export async function readXlsxRecords(filePath: string, maxRows: number): Promise<SheetRecord[]> {
  const archive = await SafeArchive.open(filePath, XLSX_LIMITS, 'Excel file');
  try {
    const types = await readPart(archive, '[Content_Types].xml');
    if (!types || !types.includes('spreadsheetml')) {
      throw new SheetError('This is not an Excel .xlsx workbook. Upload a .xlsx or .csv file.');
    }
    if (/macroEnabled/i.test(types)) {
      throw new SheetError('Macro-enabled workbooks are not accepted. Save the file as a normal .xlsx (or CSV) and upload again.');
    }

    const workbook = (await readPart(archive, 'xl/workbook.xml')) ?? '';
    const firstSheet = /<sheet\b([^>]*)\/?>/.exec(workbook);
    const relId = firstSheet ? attr(firstSheet[1]!, 'r:id') : null;
    const rels = (await readPart(archive, 'xl/_rels/workbook.xml.rels')) ?? '';
    let target: string | null = null;
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      if (attr(m[1]!, 'Id') === relId) target = attr(m[1]!, 'Target');
    }
    if (!target) throw new SheetError('The Excel file has no worksheet.');
    const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;

    const sharedXml = await readPart(archive, 'xl/sharedStrings.xml');
    const shared: string[] = [];
    if (sharedXml) for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textRuns(m[1] ?? ''));

    const sheet = await readPart(archive, sheetPath);
    if (sheet === null) throw new SheetError('The Excel file has no worksheet.');

    const records: SheetRecord[] = [];
    let lastRow = 0;
    for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNumber = Number(attr(rowMatch[1]!, 'r')) || lastRow + 1;
      lastRow = rowNumber;
      const cells: string[] = [];
      let next = 0;
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1]!;
        const body = cellMatch[2] ?? '';
        const ref = attr(attrs, 'r');
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        if (col < 0 || col > 200) continue;
        const type = attr(attrs, 't');
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = textRuns(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
        else if (type === 'str' || type === 'e') value = decodeXml(raw ?? '');
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined) value = normaliseNumber(decodeXml(raw));
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
      if (cells.every((c) => c.trim() === '')) continue;
      records.push({ rowNumber, cells });
      if (records.length > maxRows + 1) {
        throw new SheetError(`The file has more than ${maxRows} product rows. Split it into smaller files and upload them one by one.`);
      }
    }
    return records;
  } finally {
    archive.close();
  }
}
