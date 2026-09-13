/**
 * AadiOne brand mark used inside the app.
 *
 * Uses the same square icon asset as the launcher icon so the brand remains
 * consistent across the app.
 */

import { Image, StyleSheet } from "react-native";
import { radius } from "@shared/theme";

const SOURCE = require("../../assets/adione-icon.png") as number;

export default function BrandMark({ size = 72 }: { size?: number }) {
  return (
    <Image
      source={SOURCE}
      style={[
        styles.mark,
        { width: size, height: size, borderRadius: size * 0.225 },
      ]}
      resizeMode="contain"
      accessibilityLabel="AadiOne"
    />
  );
}

const styles = StyleSheet.create({
  mark: {
    borderRadius: radius.lg,
  },
});
