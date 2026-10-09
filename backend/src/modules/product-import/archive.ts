/**
 * Safe ZIP reading for bulk imports (image archives and .xlsx workbooks).
 *
 * Nothing from an archive is ever written to disk: entries are read one at a
 * time into memory, each capped, so there is no path to traverse. On top of
 * that the archive is refused outright when it
 *
 *   - has an unsafe entry path (absolute, "..", backslashes — yauzl checks),
 *   - has more entries than allowed, or claims more total data than allowed,
 *
 * and a single entry is never read when it is bigger than its cap, is
 * encrypted, or is compressed suspiciously well (a zip bomb). yauzl also
 * verifies that the bytes actually inflated match the sizes the archive
 * claims, so a lying header cannot sneak past the cap.
 */

import path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { SheetError } from './csv';

export interface ArchiveLimits {
  maxEntries: number;
  /** One entry, uncompressed. */
  maxEntryBytes: number;
  /** Everything, uncompressed (as claimed by the archive). */
  maxTotalBytes: number;
}

export interface ArchiveEntry {
  /** Full path inside the archive. */
  path: string;
  /** Base name, e.g. "RB-250.jpg". */
  fileName: string;
  uncompressedSize: number;
  /** Why this entry must not be read (too big, encrypted, zip-bomb ratio), if so. */
  problem: string | null;
  entry: Entry;
}

/** Operating-system clutter that is never an image the seller meant. */
function isJunk(entryPath: string): boolean {
  const base = path.posix.basename(entryPath);
  return entryPath.startsWith('__MACOSX/') || base.startsWith('._') || base === '.DS_Store' || base.toLowerCase() === 'thumbs.db' || base === 'desktop.ini';
}

/** Compression ratios above this, on entries above 1 MB, are treated as bombs. */
const MAX_RATIO = 100;

export class SafeArchive {
  private constructor(
    private readonly zip: ZipFile,
    readonly entries: ArchiveEntry[],
    private readonly limits: ArchiveLimits,
  ) {}

  static async open(filePath: string, limits: ArchiveLimits, label = 'ZIP file'): Promise<SafeArchive> {
    let zip: ZipFile;
    try {
      zip = await yauzl.openPromise(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true });
    } catch (error) {
      throw new SheetError(`The ${label} could not be opened. Make sure it is a normal .zip file.`, `zip open failed: ${(error as Error).message}`);
    }
    if (zip.entryCount > limits.maxEntries) {
      zip.close();
      throw new SheetError(`The ${label} has ${zip.entryCount} files; the limit is ${limits.maxEntries}. Split it into smaller ZIP files.`);
    }
    const entries: ArchiveEntry[] = [];
    let total = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on('entry', (entry: Entry) => {
          const entryPath = entry.fileName;
          if (!entryPath.endsWith('/') && !isJunk(entryPath)) {
            total += entry.uncompressedSize;
            let problem: string | null = null;
            if (entry.isEncrypted()) problem = 'is password-protected';
            else if (entry.uncompressedSize > limits.maxEntryBytes) problem = `is larger than ${Math.round(limits.maxEntryBytes / 1024 / 1024)} MB`;
            else if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize > entry.compressedSize * MAX_RATIO) problem = 'looks like a compressed bomb';
            entries.push({ path: entryPath, fileName: path.posix.basename(entryPath), uncompressedSize: entry.uncompressedSize, problem, entry });
          }
          zip.readEntry();
        });
        zip.on('end', () => resolve());
        zip.on('error', reject);
        zip.readEntry();
      });
    } catch (error) {
      zip.close();
      throw new SheetError(`The ${label} contains unsafe or damaged file entries and was not used.`, `zip entries: ${(error as Error).message}`);
    }
    if (total > limits.maxTotalBytes) {
      zip.close();
      throw new SheetError(`The ${label} would unpack to more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB. Split it into smaller ZIP files.`);
    }
    return new SafeArchive(zip, entries, limits);
  }

  /** The entry's bytes — never more than the per-entry cap. */
  async read(item: ArchiveEntry): Promise<Buffer> {
    if (item.problem) throw new SheetError(`${item.fileName} ${item.problem}.`);
    const stream = await this.zip.openReadStreamPromise(item.entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += (chunk as Buffer).byteLength;
      if (size > this.limits.maxEntryBytes) {
        stream.destroy();
        throw new SheetError(`${item.fileName} is larger than allowed.`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks, size);
  }

  find(entryPath: string): ArchiveEntry | undefined {
    return this.entries.find((e) => e.path === entryPath);
  }

  close(): void {
    this.zip.close();
  }
}

/** First bytes of a ZIP (also .xlsx, which is a ZIP). */
export function looksLikeZip(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06);
}
