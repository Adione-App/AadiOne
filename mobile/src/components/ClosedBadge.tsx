/**
 * The light-red CLOSED label of a restaurant or cafe that is not taking
 * orders right now — on its Home and Food list cards, in its menu header and
 * in place of each menu item's ADD button / quantity stepper.
 *
 * A label, never a button: nothing about it looks or behaves pressable (a
 * closed restaurant's card stays pressable — the card itself is the button).
 * Food sellers only; grocery and other stores keep their own "Store closed"
 * treatment (ProductCard).
 */

import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { radius } from "@shared/theme";
import { AppText } from "./ui";

/** The closed colours: light red surface, dark red text. */
export const CLOSED_BG = "#FDECEC";
export const CLOSED_FG = "#B42318";

export function ClosedBadge({
  size = "small",
  style,
}: {
  /** `small`: a pill on a card or beside the name; `action`: fills the ADD button's slot. */
  size?: "small" | "action";
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[styles.badge, size === "action" ? styles.action : styles.small, style]}
      accessible
      accessibilityLabel="Closed, not taking orders right now"
    >
      <AppText style={size === "action" ? styles.actionText : styles.smallText}>CLOSED</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: CLOSED_BG,
  },
  small: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  smallText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
    letterSpacing: 0.4,
    color: CLOSED_FG,
  },
  // The menu's ADD button size (96 x 34), so the swap never moves the row.
  action: {
    minWidth: 96,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: radius.md,
  },
  actionText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
    letterSpacing: 0.6,
    color: CLOSED_FG,
  },
});
