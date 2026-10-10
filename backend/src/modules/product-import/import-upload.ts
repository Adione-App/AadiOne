/**
 * multipart/form-data for bulk imports. Files go to a private temp folder
 * (never served, deleted after analysis — import-analysis.ts), not memory: an
 * image ZIP may be up to PRODUCT_IMPORT_MAX_ARCHIVE_MB.
 *
 *   file     one .csv or .xlsx            (≤ 10 MB)
 *   archive  one .zip of images           (≤ PRODUCT_IMPORT_MAX_ARCHIVE_MB)
 *   images   loose .jpg/.png/.webp/.avif  (≤ 50, each ≤ 5 MB) — images-only
 *   all of them together                  (≤ the archive limit + 10 MB)
 *
 * Every limit is enforced WHILE the bytes stream in (LimitedDiskStorage):
 * the moment a field passes its own limit, or the request passes the total,
 * writing stops, the partial file is deleted and the request is refused —
 * never after a large file has been written. A Content-Length header that
 * already announces too much is refused before anything is read, and a raw
 * byte counter cuts off a client that keeps streaming after it was refused,
 * so nothing depends on the header being present or honest.
 *
 * File names and browser-claimed types are only a first filter: the bytes
 * are checked here (ZIP / .xlsx signature) and again during analysis (CSV
 * must be UTF-8 text; every image is decoded by the image pipeline).
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode, PRODUCT_IMPORT_LIMITS } from '../../shared';
import { AppError } from '../../common/errors';
import { looksLikeZip } from './archive';
import { importLimits } from './import-limits';
import { ensureTmpDir } from './import-worker';
import type { ImportFiles, UploadedFile } from './import-analysis';

const FIELD_RULES: Record<string, { pattern: RegExp; message: string }> = {
  file: { pattern: /\.(csv|xlsx)$/i, message: 'Upload the product list as a .csv or .xlsx file.' },
  archive: { pattern: /\.zip$/i, message: 'Upload the images as one .zip file.' },
  images: { pattern: /\.(jpe?g|png|webp|avif)$/i, message: 'Images must be JPG, PNG, WebP or AVIF files.' },
};

export interface UploadLimits {
  sheetBytes: number;
  archiveBytes: number;
  imageBytes: number;
  maxImages: number;
  /** Every file of the request together. */
  totalBytes: number;
}

export function defaultUploadLimits(): UploadLimits {
  const archiveBytes = importLimits().maxArchiveBytes;
  return {
    sheetBytes: PRODUCT_IMPORT_LIMITS.maxSheetBytes,
    archiveBytes,
    imageBytes: PRODUCT_IMPORT_LIMITS.maxImageBytes,
    maxImages: PRODUCT_IMPORT_LIMITS.maxLooseImages,
    totalBytes: archiveBytes + PRODUCT_IMPORT_LIMITS.maxSheetBytes,
  };
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function fieldLimit(limits: UploadLimits, field: string): { bytes: number; message: string } {
  if (field === 'file') return { bytes: limits.sheetBytes, message: `The product file must be ${mb(limits.sheetBytes)} or smaller. Split it into several files.` };
  if (field === 'archive') return { bytes: limits.archiveBytes, message: `The images ZIP must be ${mb(limits.archiveBytes)} or smaller. Split it into several ZIP files.` };
  return { bytes: limits.imageBytes, message: `Each image must be ${mb(limits.imageBytes)} or smaller.` };
}

const TOTAL = Symbol('importUploadBytes');
type Counted = Request & { [TOTAL]?: { bytes: number } };

/** Disk storage that counts bytes per field and per request as they arrive. */
class LimitedDiskStorage implements multer.StorageEngine {
  constructor(
    private readonly limits: UploadLimits,
    private readonly dir: () => Promise<string>,
  ) {}

  _handleFile(req: Request, file: Express.Multer.File, cb: (error?: unknown, info?: Partial<Express.Multer.File>) => void): void {
    const limit = fieldLimit(this.limits, file.fieldname);
    const total = ((req as Counted)[TOTAL] ??= { bytes: 0 });
    this.dir().then(
      (dir) => {
        // Random names: nothing from the client ever becomes a path.
        const target = path.join(dir, `${randomUUID()}.upload`);
        const out = createWriteStream(target, { flags: 'wx' });
        let size = 0;
        let done = false;
        const fail = (error: unknown) => {
          if (done) return;
          done = true;
          file.stream.unpipe(out);
          file.stream.resume(); // discard the rest of this field — nothing more is written
          // Remove only once the stream is fully closed: a file still opening
          // would otherwise be (re)created after the removal.
          out.once('close', () => {
            rm(target, { force: true }).finally(() => cb(error));
          });
          out.destroy();
        };
        file.stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          total.bytes += chunk.length;
          if (size > limit.bytes) fail(new AppError(ErrorCode.FILE_TOO_LARGE, { message: limit.message }));
          else if (total.bytes > this.limits.totalBytes) {
            fail(new AppError(ErrorCode.FILE_TOO_LARGE, { message: `All files together must be ${mb(this.limits.totalBytes)} or smaller.` }));
          }
        });
        file.stream.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (done) return;
          done = true;
          cb(null, { destination: dir, filename: path.basename(target), path: target, size });
        });
        file.stream.pipe(out);
      },
      (error: unknown) => cb(error),
    );
  }

  _removeFile(_req: Request, file: Express.Multer.File, cb: (error: Error | null) => void): void {
    rm(file.path, { force: true }).then(
      () => cb(null),
      (error: Error) => cb(error),
    );
  }
}

/** Multipart framing on top of the files themselves. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/**
 * The upload middleware. `limits` / `dir` are injectable so the limits can
 * be tested with the real multipart parser at small sizes.
 */
export function createImportUpload(limits: UploadLimits = defaultUploadLimits(), dir: () => Promise<string> = ensureTmpDir): RequestHandler {
  const parser = multer({
    storage: new LimitedDiskStorage(limits, dir),
    limits: {
      fileSize: Math.max(limits.sheetBytes, limits.archiveBytes, limits.imageBytes),
      files: limits.maxImages + 2,
      fields: 5,
      fieldSize: 200,
      parts: limits.maxImages + 10,
    },
    fileFilter: (_req, file, accept) => {
      const rule = FIELD_RULES[file.fieldname];
      if (!rule) return accept(new AppError(ErrorCode.VALIDATION_ERROR, { message: `Unexpected file field "${file.fieldname.slice(0, 40)}".` }));
      if (!rule.pattern.test(file.originalname)) return accept(new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: rule.message }));
      accept(null, true);
    },
  }).fields([
    { name: 'file', maxCount: 1 },
    { name: 'archive', maxCount: 1 },
    { name: 'images', maxCount: limits.maxImages },
  ]);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('multipart/form-data')) {
      next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload the files as multipart/form-data.' }));
      return;
    }
    const ceiling = limits.totalBytes + MULTIPART_OVERHEAD;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > ceiling) {
      res.setHeader('Connection', 'close');
      next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: `All files together must be ${mb(limits.totalBytes)} or smaller.` }));
      return;
    }
    // Header absent or dishonest: count what actually arrives and cut the
    // connection once it passes the ceiling (after a refusal, multer only
    // drains — this stops a client that keeps streaming regardless).
    let received = 0;
    const counter = (chunk: Buffer) => {
      received += chunk.length;
      if (received > ceiling) {
        req.off('data', counter);
        res.setHeader('Connection', 'close');
        req.destroy();
      }
    };
    req.on('data', counter);

    parser(req, res, (error: unknown) => {
      // On a refusal the counter stays attached: multer drains the rest, and
      // a client that keeps streaming is cut off at the ceiling.
      if (!error) {
        req.off('data', counter);
        return next();
      }
      res.setHeader('Connection', 'close');
      if (error instanceof AppError) return next(error);
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') return next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: fieldLimit(limits, error.field ?? '').message }));
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: `Upload at most ${limits.maxImages} images at once, or put them in a ZIP.` }));
        }
        return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The upload could not be read.', internalMessage: error.code }));
      }
      return next(error);
    });
  };
}

export const importUpload: RequestHandler = (req, res, next) => createImportUpload()(req, res, next);

type MulterFiles = Record<string, Express.Multer.File[]> | undefined;

const toUploaded = (f: Express.Multer.File): UploadedFile => ({ path: f.path, originalName: path.basename(f.originalname).slice(0, 255), size: f.size });

async function head(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every temp file of this request (to delete when the request is refused). */
export function uploadedPaths(req: Request): string[] {
  return Object.values((req.files as MulterFiles) ?? {})
    .flat()
    .map((f) => f.path);
}

export async function discardUploads(req: Request): Promise<void> {
  await Promise.all(uploadedPaths(req).map((p) => rm(p, { force: true }).catch(() => undefined)));
}

/** The request's files, checked: presence, and ZIP / .xlsx signatures (sizes were enforced while streaming). */
export async function readImportFiles(req: Request, kind: 'PRODUCTS' | 'IMAGES'): Promise<ImportFiles> {
  const files = (req.files as MulterFiles) ?? {};
  const sheet = files['file']?.[0];
  const archive = files['archive']?.[0];
  const images = files['images'] ?? [];
  const out: ImportFiles = {};

  if (kind === 'PRODUCTS') {
    if (!sheet) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose the product file (.csv or .xlsx).' });
    if (images.length > 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Put the product images in one ZIP file.' });
    const format = /\.xlsx$/i.test(sheet.originalname) ? 'xlsx' : 'csv';
    if (format === 'xlsx' && !looksLikeZip(await head(sheet.path))) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'This is not a real .xlsx file. Old .xls files are not supported: save as .xlsx or CSV.' });
    }
    out.sheet = { ...toUploaded(sheet), format };
  } else {
    if (sheet) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'An images-only upload takes images or a ZIP, not a product file.' });
    if (!archive && images.length === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose a ZIP of images or the image files.' });
    if (archive && images.length > 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload either a ZIP or image files, not both.' });
    if (images.length > 0) out.looseImages = images.map(toUploaded);
  }
  if (archive) {
    if (!looksLikeZip(await head(archive.path))) throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'The images file is not a valid .zip archive.' });
    out.archive = toUploaded(archive);
  }
  return out;
}
