/**
 * Aadione brand images inside the app.
 *
 * Each shows the logo published for its place in Admin Panel → Branding &
 * Identity (lib/branding.ts) and falls back to the bundled artwork while
 * nothing is published, while the published image is still loading, or if it
 * cannot be loaded — never a broken image. Published images are kept in
 * expo-image's disk cache, so they show offline too.
 *
 * The launcher icon and the native splash are part of the installed app and
 * do not change from here.
 */

import { useState } from 'react';
import type { ImageSourcePropType, StyleProp, ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import type { BrandUse } from '@shared';
import { radius } from '@shared/theme';
import { useBrandAsset } from '@/lib/branding';

const MARK = require('../../assets/adione-icon.png') as number;

export function BrandImage({
  use,
  fallback,
  style,
  accessibilityLabel = 'Aadione',
}: {
  use: BrandUse;
  /** The bundled artwork (a require()). */
  fallback: ImageSourcePropType | number;
  style: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
}) {
  const asset = useBrandAsset(use);
  const [failed, setFailed] = useState<string | null>(null);
  const published = asset && failed !== asset.url ? { uri: asset.url, width: asset.width, height: asset.height } : null;
  return (
    <Image
      source={published ?? (fallback as number)}
      // The bundled artwork until the published image is ready — never an empty box.
      placeholder={published ? (fallback as number) : undefined}
      placeholderContentFit="contain"
      contentFit="contain"
      cachePolicy="disk"
      transition={0}
      style={style}
      accessibilityLabel={accessibilityLabel}
      onError={() => asset && setFailed(asset.url)}
    />
  );
}

/** The square Aadione mark (Home footer, About, update screen). */
export default function BrandMark({ size = 72 }: { size?: number }) {
  return <BrandImage use="customerApp" fallback={MARK} style={{ width: size, height: size, borderRadius: size * 0.225 || radius.lg }} />;
}
