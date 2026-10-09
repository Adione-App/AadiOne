/**
 * multipart/form-data for bulk imports. Files go to a private temp folder
 * (never served, deleted after analysis — import-analysis.ts), not memory: an
 * image ZIP may be up to PRODUCT_IMPORT_MAX_ARCHIVE_MB.
 *
 *   file     one .csv or .xlsx            (≤ 10 MB)
 *   archive  one .zip of images           (≤ PRODUCT_IMPORT_MAX_ARCHIVE_MB)
 *   images   loose .jpg/.png/.webp/.avif  (≤ 50, each ≤ 5 MB) — images-only
 *
 * File names and browser-claimed types are only a first filter: the bytes
 * are checked here (ZIP / .xlsx signature) and again during analysis (CSV
 * must be UTF-8 text; every image is decoded by the image pipeline).
 */

import { randomUUID } from 'node:crypto';
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

function parser() {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, done) => {
        ensureTmpDir().then((dir) => done(null, dir), (error: Error) => done(error, ''));
      },
      // Random names: nothing from the client ever becomes a path.
      filename: (_req, _file, done) => done(null, `${randomUUID()}.upload`),
    }),
    limits: {
      fileSize: importLimits().maxArchiveBytes,
      files: PRODUCT_IMPORT_LIMITS.maxLooseImages + 2,
      fields: 5,
      fieldSize: 200,
      parts: PRODUCT_IMPORT_LIMITS.maxLooseImages + 10,
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
    { name: 'images', maxCount: PRODUCT_IMPORT_LIMITS.maxLooseImages },
  ]);
}

/** Parses the upload; maps multer's own errors to the API's error shape. */
export const importUpload: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.is('multipart/form-data')) {
    next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload the files as multipart/form-data.' }));
    return;
  }
  parser()(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: `A file is larger than ${Math.round(importLimits().maxArchiveBytes / 1024 / 1024)} MB. Split it into smaller uploads.` }));
      }
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: `Upload at most ${PRODUCT_IMPORT_LIMITS.maxLooseImages} images at once, or put them in a ZIP.` }));
      }
      return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The upload could not be read.', internalMessage: error.code }));
    }
    return next(error);
  });
};

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

/** The request's files, checked: sizes, and ZIP / .xlsx signatures. */
export async function readImportFiles(req: Request, kind: 'PRODUCTS' | 'IMAGES'): Promise<ImportFiles> {
  const files = (req.files as MulterFiles) ?? {};
  const sheet = files['file']?.[0];
  const archive = files['archive']?.[0];
  const images = files['images'] ?? [];
  const out: ImportFiles = {};

  if (kind === 'PRODUCTS') {
    if (!sheet) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose the product file (.csv or .xlsx).' });
    if (images.length > 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Put the product images in one ZIP file.' });
    if (sheet.size > PRODUCT_IMPORT_LIMITS.maxSheetBytes) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'The product file must be 10 MB or smaller. Split it into several files.' });
    }
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
