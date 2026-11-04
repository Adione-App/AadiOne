/**
 * Information pages — Privacy Policy, Terms & Conditions, About Aadione.
 *
 * Two shapes from one source (content/info-page.service.ts):
 *   GET /legal/:slug        JSON, for the in-app screens
 *   GET /legal/:slug/page   plain HTML at a public URL
 *
 * The HTML page exists because Google Play requires a privacy policy reachable
 * without installing or logging into anything — a screen inside the app does
 * not satisfy that. Serving both from one definition means they can never
 * drift apart.
 *
 * Public and read-only: no admin data, drafts or settings beyond what the
 * published page itself shows. Every value is escaped before it goes into
 * the HTML — page content is plain text, never markup.
 */

import { Router, type Request, type Response } from 'express';
import { ErrorCode, isInfoPageSlug, type InfoPageDto, type InfoPageSlug } from '../../shared';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/response';
import { getPublicInfoPage } from '../content/info-page.service';

export const legalRouter: Router = Router();

async function findPage(slug: string): Promise<InfoPageDto> {
  const page = isInfoPageSlug(slug) ? await getPublicInfoPage(slug as InfoPageSlug) : null;
  if (!page) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Page not found.' });
  return page;
}

/** Escapes user-visible text before it goes into HTML. */
const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

function renderHtml(page: InfoPageDto): string {
  const sections = page.sections
    .map(
      (section) =>
        `<h2>${escapeHtml(section.heading)}</h2>` +
        section.blocks
          .map((block) =>
            block.type === 'paragraph'
              ? `<p>${escapeHtml(block.text)}</p>`
              : `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`,
          )
          .join(''),
    )
    .join('');
  const meta = [
    page.version ? `Version ${page.version}` : null,
    page.effectiveDate ? `Effective ${page.effectiveDate}` : null,
    `Last updated ${page.updatedAt}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aadione — ${escapeHtml(page.title)}</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6;
       max-width:44rem;margin:0 auto;padding:2rem 1.25rem;color:#141816;background:#fff}
  h1{color:#1E8E3E;margin-bottom:.25rem}
  h2{margin-top:2rem;font-size:1.15rem}
  .updated{color:#6B7671;font-size:.9rem;margin-top:0}
  p{margin:.6rem 0}
  ul{margin:.6rem 0;padding-left:1.25rem}
  li{margin:.3rem 0}
</style></head><body>
<h1>${escapeHtml(page.title)}</h1>
<p class="updated">${escapeHtml(meta)}</p>
${sections}
</body></html>`;
}

legalRouter.get(
  '/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await findPage(req.params['slug'] as string));
  }),
);

legalRouter.get(
  '/:slug/page',
  asyncHandler(async (req: Request, res: Response) => {
    const page = await findPage(req.params['slug'] as string);
    res.type('html').send(renderHtml(page));
  }),
);
