/**
 * multipart/form-data parsing for ONE settlement payment proof (field `file`):
 * a screenshot (JPEG / PNG / WebP) or a receipt PDF.
 *
 * Memory storage (the service checks the actual bytes and writes them to
 * PRIVATE storage — nothing touches disk here), a hard 5 MB limit, one file.
 * The browser's claimed type is only a first filter.
 */

import multer from 'multer';
import type { RequestHandler } from 'express';
import { ErrorCode } from '../shared';
import { AppError } from '../common/errors';

export const MAX_PAYOUT_PROOF_BYTES = 5 * 1024 * 1024;
const CLAIMED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf', 'application/x-pdf']);

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PAYOUT_PROOF_BYTES, files: 1, fields: 2, fieldSize: 200, parts: 3 },
  fileFilter: (_req, file, accept) => {
    if (!CLAIMED_TYPES.has(file.mimetype.toLowerCase())) {
      accept(
        new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
          message: 'Upload the payment proof as a JPEG, PNG or WebP image, or a PDF.',
          internalMessage: `rejected payout proof content type ${file.mimetype}`,
        }),
      );
      return;
    }
    accept(null, true);
  },
}).single('file');

/** Parses the upload; maps multer's own errors to the API's error shape. */
export const payoutProofUpload: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload the payment proof as a file (multipart/form-data).' }));
    return;
  }
  parser(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'The payment proof must be 5 MB or smaller.' }));
      }
      return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Send one file in the "file" field.', internalMessage: error.code }));
    }
    return next(error);
  });
};
