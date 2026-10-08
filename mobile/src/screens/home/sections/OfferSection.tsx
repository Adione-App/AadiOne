/**
 * Offers & coupons — the promo codes any customer can apply right now
 * (GET /offers; expired, switched-off and used-up codes never arrive).
 * Tapping a card copies its code for the Cart's coupon field.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, Check } from "lucide-react-native";
import type { OfferDto } from "@shared";
import { formatPaise } from "@shared/money";
import { palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { offerHeadline } from "../homeEngine";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

const CARD_WIDTH = 248;

const TINTS = [
  { bg: palette.green500, ink: palette.white, sub: "rgba(255,255,255,0.85)", codeBg: "rgba(255,255,255,0.18)" },
  { bg: "#FCE7F0", ink: "#9D174D", sub: palette.grey600, codeBg: palette.white },
  { bg: "#FFF1DD", ink: "#9A5B00", sub: palette.grey600, codeBg: palette.white },
  { bg: palette.blue50, ink: "#1D4ED8", sub: palette.grey600, codeBg: palette.white },
] as const;

function conditionsOf(offer: OfferDto): string {
  const parts: string[] = [];
  if (offer.minOrderPaise > 0) parts.push(`On orders above ${formatPaise(offer.minOrderPaise)}`);
  if (offer.type === "PERCENT" && offer.maxDiscountPaise) parts.push(`up to ${formatPaise(offer.maxDiscountPaise)}`);
  if (offer.validTo) {
    const date = new Date(offer.validTo);
    parts.push(`valid till ${date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`);
  }
  return parts.join(" · ");
}

function OfferCard({
  offer,
  index,
  copied,
  onCopy,
}: {
  offer: OfferDto;
  index: number;
  copied: boolean;
  onCopy: (code: string) => void;
}) {
  const tint = TINTS[index % TINTS.length]!;
  const conditions = conditionsOf(offer);

  return (
    <Pressable
      onPress={() => onCopy(offer.code)}
      style={({ pressed }) => [styles.card, { backgroundColor: tint.bg }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${offerHeadline(offer, formatPaise)}. Copy code ${offer.code}`}
    >
      <AppText style={[styles.headline, { color: tint.ink }]} numberOfLines={1}>
        {offerHeadline(offer, formatPaise)}
      </AppText>
      {offer.description ? (
        <AppText style={[styles.description, { color: tint.ink }]} numberOfLines={2}>
          {offer.description}
        </AppText>
      ) : null}
      {conditions ? (
        <AppText style={[styles.conditions, { color: tint.sub }]} numberOfLines={2}>
          {conditions}
        </AppText>
      ) : null}

      <View style={[styles.code, { backgroundColor: tint.codeBg, borderColor: tint.ink }]}>
        <AppText style={[styles.codeLabel, { color: tint.sub }]}>USE CODE</AppText>
        <AppText style={[styles.codeValue, { color: tint.ink }]} numberOfLines={1}>
          {offer.code}
        </AppText>
        {copied ? (
          <Check size={14} color={tint.ink} strokeWidth={2.75} />
        ) : (
          <Copy size={13} color={tint.ink} strokeWidth={2.25} />
        )}
      </View>
    </Pressable>
  );
}

function OfferSectionImpl({ offers }: { offers: OfferDto[] }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback((code: string) => {
    void Clipboard.setStringAsync(code);
    void Haptics.selectionAsync().catch(() => undefined);
    setCopiedCode(code);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedCode(null), 2000);
  }, []);

  return (
    <SectionPanel>
      <SectionHeader
        title="Offers & Coupons"
        subtitle={copiedCode ? `Code ${copiedCode} copied — apply it in your cart` : "Tap a code to copy it"}
      />
      <FlatList
        horizontal
        data={offers}
        keyExtractor={(item) => item.code}
        extraData={copiedCode}
        renderItem={({ item, index }) => (
          <OfferCard offer={item} index={index} copied={copiedCode === item.code} onCopy={copy} />
        )}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      />
    </SectionPanel>
  );
}

export const OfferSection = memo(OfferSectionImpl);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: PANEL_PADDING,
    gap: spacing.sm,
  },
  card: {
    width: CARD_WIDTH,
    minHeight: 132,
    padding: spacing.md,
    borderRadius: radius.lg,
    justifyContent: "space-between",
  },
  pressed: {
    opacity: 0.88,
  },
  headline: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: "900",
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    marginTop: 2,
  },
  conditions: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  code: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  codeLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  codeValue: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "900",
    letterSpacing: 0.5,
    maxWidth: 130,
  },
});
