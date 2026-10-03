/**
 * multipart/form-data parsing for ONE seller-document PDF (field `file`).
 *
 * Memory storage (the bytes are validated and then written to PRIVATE
 * storage by the service — nothing touches disk here), a hard 10 MB limit,
 * one file, a handful of small text fields. The browser's claimed type is
 * checked here only as a first filter; the service checks the actual bytes.
 */

import multer from 'multer';
import type { RequestHandler } from 'express';
import { ErrorCode } from '../shared';
import { AppError } from '../common/errors';
import { MAX_DOCUMENT_BYTES, isPdfMimeType } from '../modules/sellers/seller-document-rules';

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 6, fieldSize: 2_000, parts: 8 },
  fileFilter: (_req, file, accept) => {
    if (!isPdfMimeType(file.mimetype)) {
      accept(
        new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
          message: 'Upload the document as a PDF file.',
          internalMessage: `rejected document content type ${file.mimetype}`,
        }),
      );
      return;
    }
    accept(null, true);
  },
}).single('file');

/** Parses the upload; maps multer's own errors to the API's error shape. */
export const documentUpload: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload the document as a PDF file (multipart/form-data).' }));
    return;
  }
  parser(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'The PDF must be 10 MB or smaller.' }));
      }
      return next(new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Send one PDF in the "file" field.', internalMessage: error.code }));
    }
    return next(error);
  });
};
