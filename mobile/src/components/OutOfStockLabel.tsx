/**
 * The shared out-of-stock status — every customer-facing product surface
 * draws this one component, so the label is always exactly "Out of Stock"
 * (lib/stockLabel.ts), never "Sold Out" or a cut-off "Out of" / "Out".
 *
 * Why it used to be cut off: the card's badge sat at the image's top-left, on
 * the same row as the wishlist heart (top-right, drawn on top). On narrow
 * cards (≈96–106 dp wide, three to a row) — and more so with Android's
 * larger font sizes — the badge ran under the heart, which hid "Stock" or
 * "of Stock". Now the card shows it where its other statuses already sit
 * (the action slot, bottom-right, where Add / the stepper would be), and the
 * text itself can never wrap or be ellipsised:
 *
 *   - one line, its own width (`flexShrink: 0`) — the box grows to the text;
 *   - the phone's font-size setting is honoured up to a cap
 *     (`maxFontSizeMultiplier`), so the pill still fits the narrowest card;
 *   - as a last resort the text shrinks a little (`adjustsFontSizeToFit`)
 *     rather than lose letters.
 *
 * The look is the card's existing status pill (white, rounded, grey bold
 * text) — the Aadione green/white card is unchanged.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, spacing } from "@shared/theme";
import { OUT_OF_STOCK_A11Y_LABEL, OUT_OF_STOCK_LABEL } from "../lib/stockLabel";

/** Largest font scaling applied (the phone's "Font size" setting) — beyond it the pill would outgrow a card. */
export const OUT_OF_STOCK_MAX_FONT_SCALE = 1.3;

export function OutOfStockLabel({
  size = "card",
  style,
}: {
  /** "card": the product card's action slot; "large": the product page footer / sheets. */
  size?: "card" | "large";
  style?: StyleProp<ViewStyle>;
}) {
  const large = size === "large";
  return (
    <View
      style={[styles.pill, large && styles.pillLarge, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={OUT_OF_STOCK_A11Y_LABEL}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        maxFontSizeMultiplier={OUT_OF_STOCK_MAX_FONT_SCALE}
        style={[styles.text, large && styles.textLarge]}
      >
        {OUT_OF_STOCK_LABEL}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The card's status pill (ProductCard `floatingOutOfStock`), sized by its text.
  pill: {
    minHeight: 28,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    flexShrink: 0,
  },
  pillLarge: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    alignSelf: "stretch",
    backgroundColor: colors.surfaceSunken,
  },
  text: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
    color: colors.textSecondary,
    textAlign: "center",
    flexShrink: 0,
    includeFontPadding: false,
  },
  textLarge: {
    fontSize: 15,
    lineHeight: 20,
  },
});
