/**
 * The Aadione logo in the Admin and Seller Panels.
 *
 * Shows the PUBLISHED logo for its place (Admin Panel → Branding & Identity;
 * lib/branding.ts) and falls back to the built-in wordmark below while
 * nothing is published, or if the image cannot be loaded — never a broken
 * image or an empty space.
 */

import { useState } from 'react';
import type { BrandUse } from '@shared';
import { useBrandAsset } from '@/lib/branding';

function Leaf({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M21 2.5C11 2.5 4.5 7.6 4.5 14.8c0 2 .5 3.7 1.4 5 1.4-6.3 6-10.3 11-12.5-4.1 3-7.3 7-8.6 13 1 .4 2 .6 3.1.6 6.7 0 9.6-7.6 9.6-18.4z"
      />
    </svg>
  );
}

/**
 * The built-in mark: "Aadione" with a leaf for the dot of the i. The visible
 * glyphs are aria-hidden (the i is a dotless ı) and the whole mark is
 * labelled once.
 */
export function AadioneWordmark({ className = 'text-4xl' }: { className?: string }) {
  return (
    <span role="img" aria-label="Aadione" className={`inline-flex items-baseline font-bold leading-none tracking-tight ${className}`}>
      <span aria-hidden="true" className="text-gray-900">
        Aad
      </span>
      <span aria-hidden="true" className="relative text-brand-500">
        ı
        <Leaf className="absolute left-1/2 top-[-0.2em] h-[0.4em] w-[0.4em] -translate-x-[35%] text-brand-500" />
      </span>
      <span aria-hidden="true" className="text-brand-500">
        one
      </span>
    </span>
  );
}

export function BrandLogo({
  use,
  className = 'h-8',
  wordmarkClassName = 'text-2xl',
}: {
  /** Which published logo: 'light' (Admin Panel), 'seller' (Seller Panel). */
  use: BrandUse;
  /** Height of the published image (its width follows). */
  className?: string;
  /** Size of the built-in wordmark. */
  wordmarkClassName?: string;
}) {
  const asset = useBrandAsset(use);
  const [failed, setFailed] = useState<string | null>(null);
  if (!asset || failed === asset.url) return <AadioneWordmark className={wordmarkClassName} />;
  return (
    <img
      src={asset.url}
      alt="Aadione"
      width={asset.width}
      height={asset.height}
      decoding="async"
      className={`block w-auto max-w-full object-contain ${className}`}
      onError={() => setFailed(asset.url)}
    />
  );
}
