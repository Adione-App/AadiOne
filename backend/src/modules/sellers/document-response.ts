/**
 * Sends a seller-document PDF to an authorised caller. The bytes come from
 * private storage through the API — there is no public URL to share, cache
 * or leak. `no-store` keeps it out of shared/browser caches; `nosniff` and a
 * sandbox CSP stop the response being treated as anything but a PDF.
 */

import type { Response } from 'express';
import type { DocumentFile } from './seller-onboarding.service';

export function sendDocumentFile(res: Response, file: DocumentFile, disposition: 'inline' | 'attachment' = 'inline'): void {
  const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', String(file.body.length));
  res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.status(200).end(file.body);
}
