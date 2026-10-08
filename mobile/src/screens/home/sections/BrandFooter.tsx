/**
 * The page's sign-off once every shelf has loaded — brand, not catalogue,
 * so it is the one section with fixed copy.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ArrowRight } from "lucide-react-native";
import { palette, radius, spacing } from "@shared/theme";
import BrandMark from "@/components/BrandMark";
import { AppText } from "@/components/ui";
import { PANEL_INSET } from "./SectionShell";

function BrandFooterImpl({ onShop }: { onShop: () => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.bubble} />
      <View style={styles.copy}>
        <AppText style={styles.brand}>
          Adi<AppText style={styles.brandAccent}>One</AppText>
        </AppText>
        <AppText style={styles.tagline}>Everything you need from local stores</AppText>
        <Pressable onPress={onShop} style={styles.cta} accessibilityRole="button" accessibilityLabel="Search products">
          <AppText style={styles.ctaText}>Shop Now</AppText>
          <ArrowRight size={12} color={palette.green700} strokeWidth={2.75} />
        </Pressable>
      </View>
      <BrandMark size={72} />
    </View>
  );
}

export const BrandFooter = memo(BrandFooterImpl);

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: PANEL_INSET,
    marginTop: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.xl,
    backgroundColor: palette.green700,
    overflow: "hidden",
  },
  bubble: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 100,
    right: -50,
    top: -80,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  copy: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  brand: {
    fontSize: 24,
    lineHeight: 29,
    fontWeight: "900",
    color: palette.white,
  },
  brandAccent: {
    fontSize: 24,
    lineHeight: 29,
    fontWeight: "900",
    color: palette.green300,
  },
  tagline: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: "rgba(255,255,255,0.9)",
    marginTop: 2,
  },
  cta: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 30,
    borderRadius: radius.pill,
    backgroundColor: palette.white,
  },
  ctaText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "800",
    color: palette.green700,
  },
});
