/**
 * CSV for bulk imports — a small RFC 4180 reader and a safe writer.
 *
 * Reading streams the file in chunks and yields one record at a time, so a
 * file is never held whole in memory and parsing stops as soon as the row cap
 * is passed. Quoted fields may contain commas, quotes ("") and line breaks;
 * CRLF, LF and a UTF-8 byte-order mark are handled. The bytes must be UTF-8
 * (what "CSV UTF-8" in Excel and Google Sheets produce): anything else is
 * refused rather than silently turning Hindi names into "?".
 *
 * Writing escapes every cell for spreadsheet formula injection: a cell that
 * starts with = + - @ (or a tab / carriage return) is prefixed with ' so that
 * opening an error report in Excel can never run a formula a file contained.
 */

import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';

export class SheetError extends AppError {
  constructor(message: string, internalMessage?: string) {
    super(ErrorCode.VALIDATION_ERROR, { message, ...(internalMessage ? { internalMessage } : {}) });
  }
}

/** Incremental RFC 4180 parser: feed text, collect complete records. */
export class CsvParser {
  private field = '';
  private record: string[] = [];
  private inQuotes = false;
  /** The previous character closed a quoted section ("abc"| …). */
  private afterQuote = false;
  private pendingCr = false;
  private started = false;
  readonly records: string[][] = [];

  feed(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      let ch = text[i]!;
      if (!this.started) {
        this.started = true;
        if (ch === '﻿') continue; // byte-order mark
      }
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === '\n') continue; // CRLF = one line break
      }
      if (this.inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            this.field += '"';
            i += 1;
          } else {
            // Closing quote — unless the chunk ended here and the next one
            // starts with the second " of an escaped "" (handled below).
            this.inQuotes = false;
            this.afterQuote = true;
          }
        } else {
          this.field += ch;
        }
        continue;
      }
      if (this.afterQuote && ch === '"') {
        // "" split across two chunks: an escaped quote inside the field.
        this.field += '"';
        this.inQuotes = true;
        this.afterQuote = false;
        continue;
      }
      this.afterQuote = false;
      if (ch === '"' && this.field.length === 0) {
        this.inQuotes = true;
      } else if (ch === ',') {
        this.endField();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') this.pendingCr = true;
        this.endRecord();
      } else {
        if (ch === '\u0000') ch = '';
        this.field += ch;
      }
    }
  }

  /** End of input: the last record may have no trailing line break. */
  end(): void {
    if (this.inQuotes) throw new SheetError('The file has a quoted value that is never closed (a missing ").');
    if (this.field.length > 0 || this.record.length > 0) this.endRecord();
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = '';
  }

  private endRecord(): void {
    this.endField();
    const record = this.record;
    this.record = [];
    // A blank line still counts as a spreadsheet row (row numbers must match
    // what the seller sees in Excel); it just carries no cells.
    this.records.push(record.length === 1 && record[0]!.trim() === '' ? [] : record);
  }
}

const tooManyRows = (max: number) =>
  new SheetError(`The file has more than ${max} product rows. Split it into smaller files and upload them one by one.`);
const notUtf8 = () =>
  new SheetError('The file is not saved as UTF-8. In Excel use "Save As > CSV UTF-8 (Comma delimited)" and upload again.', 'invalid UTF-8 in CSV');

/**
 * Streams a CSV file, yielding its non-blank records with their spreadsheet
 * row numbers (header = row 1). Stops with an error once more than `maxRows`
 * data rows are seen, so an oversized file is never read to the end.
 */
export async function* readCsvRecords(filePath: string, maxRows: number): AsyncGenerator<{ rowNumber: number; cells: string[] }> {
  const parser = new CsvParser();
  const decoder = new StringDecoder('utf8');
  let line = 0;
  let dataRows = 0;
  let headerSeen = false;
  function* drain(): Generator<{ rowNumber: number; cells: string[] }> {
    while (parser.records.length > 0) {
      const cells = parser.records.shift()!;
      line += 1;
      if (cells.length === 0 || cells.every((c) => c.trim() === '')) continue;
      if (headerSeen) {
        dataRows += 1;
        if (dataRows > maxRows) throw tooManyRows(maxRows);
      } else headerSeen = true;
      yield { rowNumber: line, cells };
    }
  }
  for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
    const buffer = chunk as Buffer;
    if (buffer.includes(0)) {
      throw new SheetError('This is not a text CSV file. Save it as "CSV UTF-8" and upload again.', 'NUL byte in CSV');
    }
    const text = decoder.write(buffer);
    if (text.includes('�')) throw notUtf8();
    parser.feed(text);
    yield* drain();
  }
  const rest = decoder.end();
  if (rest.includes('�')) throw notUtf8();
  parser.feed(rest);
  parser.end();
  yield* drain();
}

/** One CSV cell: quoted when needed, and neutralised against formula injection. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** UTF-8 byte-order mark: makes Excel read Hindi text in a CSV correctly. */
export const CSV_BOM = '﻿';
