/**
 * Tiny ZIP writer for tests: real archives (stored or deflated) for image
 * ZIPs and .xlsx workbooks — and deliberately broken ones (unsafe names,
 * sizes that lie, compression bombs) to prove the importer refuses them.
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer | string;
  /** Default: deflate. */
  store?: boolean;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
}

export function makeZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? raw : deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const size = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A minimal real .xlsx: one sheet, strings as shared strings, numbers as
 * numbers (pass a number to get a numeric cell).
 */
export function makeXlsx(rows: (string | number | null)[][], options: { macro?: boolean } = {}): Buffer {
  const shared: string[] = [];
  const sharedIndex = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          if (cell === null || cell === '') return '';
          const ref = `${col(c)}${r + 1}`;
          return typeof cell === 'number' ? `<c r="${ref}"><v>${cell}</v></c>` : `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join('');
  const contentType = options.macro ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${contentType}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` },
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    },
  ]);
}
