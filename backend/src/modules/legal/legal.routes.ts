/**
 * Legal pages.
 *
 * Two shapes from one source:
 *   GET /legal/:slug        JSON, for the in-app screens
 *   GET /legal/:slug/page   plain HTML at a public URL
 *
 * The HTML page exists because Google Play requires a privacy policy reachable
 * without installing or logging into anything — a screen inside the app does
 * not satisfy that. Serving both from one definition means they can never
 * drift apart.
 */

import { Router, type Request, type Response } from 'express';
import { ConfigKey, ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/response';
import * as configService from '../configuration/configuration.service';
import { LEGAL_DOCUMENTS, type LegalDocument } from './legal.content';

export const legalRouter: Router = Router();

/** Substitutes the {{PLACEHOLDER}} tokens with live store details. */
async function resolve(document: LegalDocument): Promise<LegalDocument> {
  const config = await configService.getMany([
    ConfigKey.SUPPORT_EMAIL,
    ConfigKey.SUPPORT_PHONE,
  ]);

  // The marketplace operator, not any one seller: there is no special store
  // row whose name/address/hours stand for the business. Each seller's own
  // hours are shown with that seller in the app.
  const sellerName = 'AdiOne';
  const sellerAddress = '';
  const hours = 'the opening hours each seller shows in the app';

  const replacements: Record<string, string> = {
    '{{BUSINESS_NAME}}': sellerName,
    '{{BUSINESS_ADDRESS}}': sellerAddress || 'address available on request',
    '{{SUPPORT_EMAIL}}': config.SUPPORT_EMAIL || 'support@adione.in',
    '{{SUPPORT_PHONE}}': config.SUPPORT_PHONE || 'our support number',
    '{{STORE_HOURS}}': hours,
  };

  const substitute = (text: string): string =>
    Object.entries(replacements).reduce(
      (result, [token, value]) => result.split(token).join(value),
      text,
    );

  return {
    ...document,
    sections: document.sections.map((section) => ({
      heading: section.heading,
      body: section.body.map(substitute),
    })),
  };
}

function findDocument(slug: string): LegalDocument {
  const document = LEGAL_DOCUMENTS[slug];
  if (!document) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Page not found.' });
  }
  return document;
}

/** Escapes user-visible text before it goes into HTML. */
const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

function renderHtml(document: LegalDocument): string {
  const sections = document.sections
    .map(
      (section) =>
        `<h2>${escapeHtml(section.heading)}</h2>` +
        section.body.map((line) => `<p>${escapeHtml(line)}</p>`).join(''),
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdiOne — ${escapeHtml(document.title)}</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6;
       max-width:44rem;margin:0 auto;padding:2rem 1.25rem;color:#141816}
  h1{color:#1E8E3E;margin-bottom:.25rem}
  h2{margin-top:2rem;font-size:1.15rem}
  .updated{color:#6B7671;font-size:.9rem;margin-top:0}
  p{margin:.6rem 0}
</style></head><body>
<h1>AdiOne — ${escapeHtml(document.title)}</h1>
<p class="updated">Last updated ${escapeHtml(document.updatedAt)}</p>
${sections}
</body></html>`;
}

legalRouter.get(
  '/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await resolve(findDocument(req.params['slug'] as string)));
  }),
);

legalRouter.get(
  '/:slug/page',
  asyncHandler(async (req: Request, res: Response) => {
    const document = await resolve(findDocument(req.params['slug'] as string));
    res.type('html').send(renderHtml(document));
  }),
);
