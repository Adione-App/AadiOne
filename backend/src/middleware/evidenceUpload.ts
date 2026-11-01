/**
 * multipart/form-data parsing for a refund request: up to
 * MAX_EVIDENCE_PHOTOS photos (field `photos`) plus a few small text fields
 * (`category`, `description`, `items` as JSON).
 *
 * Memory storage — the bytes are checked by the service (the actual image
 * type, from the bytes) and written to PRIVATE storage; nothing touches disk
 * here. The claimed type is only a first filter.
 */

import multer from 'multer';
import type { RequestHandler } from 'express';
import { ErrorCode } from '../shared';
import { AppError } from '../common/errors';
import { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_PHOTOS } from '../modules/refunds/refund-request-rules';

const ACCEPTED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: MAX_EVIDENCE_PHOTOS, fields: 6, fieldSize: 8_000, parts: MAX_EVIDENCE_PHOTOS + 6 },
  fileFilter: (_req, file, accept) => {
    if (file.fieldname !== 'photos' || !ACCEPTED.has(file.mimetype.toLowerCase())) {
      accept(
        new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
          message: 'Photos must be JPEG, PNG or WebP images.',
          internalMessage: `rejected evidence part ${file.fieldname} (${file.mimetype})`,
        }),
      );
      return;
    }
    accept(null, true);
  },
}).array('photos', MAX_EVIDENCE_PHOTOS);

/** Parses the request; maps multer's own errors to the API's error shape. */
export const evidenceUpload: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Send the refund request as multipart/form-data.' }));
    return;
  }
  parser(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'Each photo must be 5 MB or smaller.' }));
      }
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: `Attach at most ${MAX_EVIDENCE_PHOTOS} photos.` }));
      }
      return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The refund request could not be read.', internalMessage: error.code }));
    }
    return next(error);
  });
};
