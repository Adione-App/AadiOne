/**
 * Information pages — Privacy Policy, Terms & Conditions, About Aadione —
 * and the business / contact details they show.
 *
 * Three shapes from one source (content/info-page.service.ts):
 *   GET /legal/business     JSON: who runs Aadione and how to reach them
 *   GET /legal/:slug        JSON, for the app screens AND the website
 *   GET /legal/:slug/page   plain HTML at a public URL
 *   GET/POST /legal/consent the signed-in customer's acceptance (legal-consent.service.ts)
 *
 * The HTML page exists because Google Play requires a privacy policy reachable
 * without installing or logging into anything — a screen inside the app does
 * not satisfy that. The app, the website (adione.in) and this page all read
 * the same published revision, so they can never drift apart.
 *
 * Public and read-only: no admin data, drafts or settings beyond what the
 * published page itself shows, readable from any website (app.ts allows any
 * origin, without credentials, for GET /legal/*). Every value is escaped
 * before it goes into the HTML — page content is plain text, never markup;
 * the only links are mailto:/tel:/https: ones made by infoTextSegments.
 *
 * Responses may be cached for a minute (the server's own copy is dropped the
 * moment an admin publishes), so a publish reaches every reader within ~1 min.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ErrorCode,
  LEGAL_CONSENT_SOURCES,
  UserRole,
  INFO_PAGE_SLUGS,
  INFO_PAGE_TITLES,
  infoTextSegments,
  isInfoPageSlug,
  telHref,
  type BusinessInfoDto,
  type InfoPageDto,
  type InfoPageSlug,
} from '../../shared';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/response';
import { authenticate, requireRole, requireUser } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { getBusinessInfo, getPublicInfoPage } from '../content/info-page.service';
import * as consentService from './legal-consent.service';

export const legalRouter: Router = Router();

/** How long a browser, the app or a proxy may reuse a response. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60';

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

/** Text with its email addresses, web addresses and phone numbers as links (all escaped). */
const linkedText = (text: string): string =>
  infoTextSegments(text)
    .map((segment) =>
      segment.href
        ? `<a href="${escapeHtml(segment.href)}"${segment.href.startsWith('http') ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(segment.text)}</a>`
        : escapeHtml(segment.text),
    )
    .join('');

const META_DESCRIPTIONS: Record<InfoPageSlug, string> = {
  privacy: 'What personal information Aadione collects, why, who it is shared with, how long it is kept and how to exercise your rights.',
  terms: 'The terms for using Aadione: accounts, orders, payments, delivery, cancellations, refunds, returns and complaints.',
  about: 'Aadione is a hyperlocal marketplace that brings the shops and restaurants of your town into one app.',
};

export function renderInfoPageHtml(page: InfoPageDto, business: BusinessInfoDto): string {
  const brand = escapeHtml(business.tradeName);
  const meta = [page.lastUpdatedLabel ? `Last updated ${page.lastUpdatedLabel}` : null, page.version ? `Version ${page.version}` : null]
    .filter(Boolean)
    .join(' · ');
  const contents =
    page.sections.length > 3
      ? `<nav class="toc" aria-label="Contents"><p class="toc-title">Contents</p><ol>${page.sections
          .map((section) => `<li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.heading)}</a></li>`)
          .join('')}</ol></nav>`
      : '';
  const sections = page.sections
    .map(
      (section) =>
        `<section id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.heading)}</h2>` +
        section.blocks
          .map((block) =>
            block.type === 'paragraph'
              ? `<p>${linkedText(block.text)}</p>`
              : `<ul>${block.items.map((item) => `<li>${linkedText(item)}</li>`).join('')}</ul>`,
          )
          .join('') +
        '</section>',
    )
    .join('');
  const otherPages = INFO_PAGE_SLUGS.filter((slug) => slug !== page.slug)
    .map((slug) => `<a href="../${slug}/page">${escapeHtml(INFO_PAGE_TITLES[slug])}</a>`)
    .join('');
  const contact = [
    business.support.email ? `<a href="mailto:${escapeHtml(business.support.email)}">${escapeHtml(business.support.email)}</a>` : null,
    business.support.phone ? `<a href="${escapeHtml(telHref(business.support.phone))}">${escapeHtml(business.support.phone)}</a>` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title)} | ${brand}</title>
<meta name="description" content="${escapeHtml(META_DESCRIPTIONS[page.slug])}">
<meta name="color-scheme" content="light dark">
<style>
  :root{--ink:#16201B;--muted:#5C6B63;--line:#E3E9E5;--brand:#1E8E3E;--bg:#FFFFFF;--soft:#F4F8F5}
  @media (prefers-color-scheme:dark){:root{--ink:#E8EFEA;--muted:#A3B2A9;--line:#2A3530;--brand:#5FC57F;--bg:#111714;--soft:#18201C}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif;overflow-wrap:anywhere}
  header,main,footer{max-width:46rem;margin:0 auto;padding:0 1.25rem}
  header{padding-top:1.25rem;padding-bottom:1.25rem;border-bottom:1px solid var(--line);font-weight:700;color:var(--brand);letter-spacing:.01em}
  h1{font-size:1.9rem;line-height:1.25;margin:2rem 0 .4rem}
  .meta{color:var(--muted);font-size:.92rem;margin:0}
  .effective{margin:1rem 0 0;padding:.75rem 1rem;border-left:3px solid var(--brand);background:var(--soft);border-radius:.4rem;font-size:.95rem}
  .toc{margin:1.75rem 0 0;padding:1rem 1.25rem;background:var(--soft);border-radius:.75rem}
  .toc-title{margin:0 0 .35rem;font-weight:600}
  .toc ol{margin:0;padding-left:1.25rem;columns:2 16rem;column-gap:2rem}
  .toc li{margin:.15rem 0;break-inside:avoid}
  h2{font-size:1.2rem;line-height:1.35;margin:2.25rem 0 .5rem;scroll-margin-top:1rem}
  p{margin:.65rem 0}
  ul{margin:.65rem 0;padding-left:1.3rem}
  li{margin:.35rem 0}
  a{color:var(--brand)}
  footer{margin-top:3rem;padding-top:1.25rem;padding-bottom:2.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}
  footer nav a{margin-right:1rem}
</style></head><body>
<header>${brand}</header>
<main>
<h1>${escapeHtml(page.title)}</h1>
${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
${page.effectiveLabel ? `<p class="effective">This version takes effect on ${escapeHtml(page.effectiveLabel)}.</p>` : ''}
${contents}
${sections}
</main>
<footer>
<nav aria-label="More pages">${otherPages}</nav>
${contact ? `<p>${contact}</p>` : ''}
</footer>
</body></html>`;
}

legalRouter.get(
  '/business',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    ok(res, await getBusinessInfo());
  }),
);

/* Customer acceptance — signed-in customers only, never cached ------------- */

const acceptSchema = z
  .object({
    privacyVersion: z.number().int().positive(),
    termsVersion: z.number().int().positive(),
    source: z.enum(LEGAL_CONSENT_SOURCES),
    appVersion: z.string().trim().max(20).regex(/^[0-9A-Za-z.+-]*$/).optional(),
  })
  .strict();

legalRouter.get(
  '/consent',
  authenticate,
  requireRole(UserRole.CUSTOMER),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await consentService.getConsentStatus(requireUser(req).id));
  }),
);

legalRouter.post(
  '/consent',
  authenticate,
  requireRole(UserRole.CUSTOMER),
  validate({ body: acceptSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await consentService.acceptLegal(requireUser(req).id, req.body));
  }),
);

legalRouter.get(
  '/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const page = await findPage(req.params['slug'] as string);
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    ok(res, page);
  }),
);

legalRouter.get(
  '/:slug/page',
  asyncHandler(async (req: Request, res: Response) => {
    const [page, business] = await Promise.all([findPage(req.params['slug'] as string), getBusinessInfo()]);
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    res.type('html').send(renderInfoPageHtml(page, business));
  }),
);
