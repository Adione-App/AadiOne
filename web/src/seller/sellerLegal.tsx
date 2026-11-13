/**
 * Seller Terms and Seller Privacy Policy in the Seller Panel.
 *
 *   SellerLegalLinks          links to the published documents (public pages)
 *   SellerLegalConsentPrompt  asks a signed-in seller user to accept the
 *                             current versions when an admin marked them as
 *                             needing acceptance (GET / POST /seller/legal/consent)
 *
 * Acceptance is recorded ONLY by "I agree" — never by signing in or by
 * submitting an application. "Not now" hides the prompt for this browser
 * session; it never blocks selling (the same rule as the customer app).
 * Nothing is shown while the documents are unpublished.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INFO_PAGE_TITLES, type InfoPageDto, type SellerLegalConsentStatusDto } from '@shared';
import { Button, ErrorBanner, Modal } from '@/components/ui';
import { apiAbsoluteUrl } from '@/lib/api';
import { sellerApi } from './sellerApi';

const SELLER_DOCS = ['seller-terms', 'seller-privacy'] as const;
type SellerDoc = (typeof SELLER_DOCS)[number];

const docUrl = (slug: SellerDoc, version?: number | null) =>
  apiAbsoluteUrl(version ? `/legal/${slug}/versions/${version}/page` : `/legal/${slug}/page`);

/** The published seller documents (none while unpublished — GET /legal/:slug answers 404 then). */
export function usePublishedSellerDocs() {
  return useQuery({
    queryKey: ['legal', 'seller-docs'],
    queryFn: async () => {
      const pages = await Promise.all(SELLER_DOCS.map((slug) => sellerApi.get<InfoPageDto>(`/legal/${slug}`).catch(() => null)));
      return pages.filter((page): page is InfoPageDto => page !== null && page.source === 'published');
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** "Seller Terms & Conditions · Seller Privacy Policy" — only the published ones; nothing when none is. */
export function SellerLegalLinks({ intro, className = '' }: { intro?: string; className?: string }) {
  const docs = usePublishedSellerDocs();
  const pages = docs.data ?? [];
  if (pages.length === 0) return null;
  return (
    <p className={`text-sm text-gray-500 ${className}`}>
      {intro ? `${intro} ` : null}
      {pages.map((page, i) => (
        <span key={page.slug}>
          {i > 0 ? ' · ' : null}
          <a
            href={docUrl(page.slug as SellerDoc)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-brand-600 hover:text-brand-700 hover:underline"
          >
            {INFO_PAGE_TITLES[page.slug]}
          </a>
          {page.version ? <span className="text-gray-400"> (version {page.version}, {page.lastUpdatedLabel})</span> : null}
        </span>
      ))}
    </p>
  );
}

const DISMISS_KEY = 'aadione.seller-legal-not-now';

function dismissedVersions(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Shown to a signed-in seller user when the current Seller Terms / Seller Privacy Policy need accepting. */
export function SellerLegalConsentPrompt() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['seller', 'legal-consent'],
    queryFn: () => sellerApi.get<SellerLegalConsentStatusDto>('/seller/legal/consent'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [hiddenFor, setHiddenFor] = useState<string | null>(dismissedVersions);
  const accept = useMutation({
    mutationFn: (body: { termsVersion: number; privacyVersion: number }) => sellerApi.post<SellerLegalConsentStatusDto>('/seller/legal/consent', body),
    onSuccess: (data) => queryClient.setQueryData(['seller', 'legal-consent'], data),
    // A newer version was published meanwhile: show it.
    onError: () => void status.refetch(),
  });

  const data = status.data;
  if (!data?.required || data.termsVersion === null || data.privacyVersion === null) return null;
  const versions = `${data.termsVersion}/${data.privacyVersion}`;
  if (hiddenFor === versions) return null;

  const notNow = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, versions);
    } catch {
      // Blocked storage: hidden until the page is reloaded.
    }
    setHiddenFor(versions);
  };

  return (
    <Modal
      title={data.accepted ? 'Updated Seller Terms and Privacy Policy' : 'Seller Terms and Privacy Policy'}
      subtitle="Please read and accept them to keep selling on Aadione."
      onClose={notNow}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={notNow} disabled={accept.isPending}>
            Not now
          </Button>
          <Button onClick={() => accept.mutate({ termsVersion: data.termsVersion!, privacyVersion: data.privacyVersion! })} disabled={accept.isPending}>
            {accept.isPending ? 'Saving…' : 'I agree'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-gray-700">
        <p>
          {data.accepted
            ? 'Aadione has published new versions of the documents that apply to your store. Please read what changed before you agree.'
            : 'These documents explain the terms for selling on Aadione and how your information is handled.'}
        </p>
        <ul className="space-y-1.5">
          <li>
            <a href={docUrl('seller-terms', data.termsVersion)} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-600 hover:underline">
              {INFO_PAGE_TITLES['seller-terms']} — version {data.termsVersion}
            </a>
          </li>
          <li>
            <a href={docUrl('seller-privacy', data.privacyVersion)} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-600 hover:underline">
              {INFO_PAGE_TITLES['seller-privacy']} — version {data.privacyVersion}
            </a>
          </li>
        </ul>
        <p className="text-xs text-gray-500">
          Choosing “I agree” records the versions you accepted and when, for this store. Earlier versions stay available at their own links.
        </p>
        <ErrorBanner message={accept.error ? 'The documents were just updated — please read the latest versions above.' : null} />
      </div>
    </Modal>
  );
}
