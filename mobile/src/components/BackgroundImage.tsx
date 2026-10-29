/**
 * Drop-in replacement for React Native's ImageBackground, which RN 0.88
 * deprecates (it logs a warning and will be removed). Renders the same tree
 * RN's own implementation does — a View with the given style, an Image filling
 * it, then the children — so screens look exactly as before.
 */

import type { ReactNode } from "react";
import { Image, StyleSheet, View, type ImageProps, type StyleProp, type ViewStyle } from "react-native";

type Props = Omit<ImageProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  imageStyle?: ImageProps["style"];
  children?: ReactNode;
};

export function BackgroundImage({ children, style, imageStyle, importantForAccessibility, ...props }: Props) {
  const flattened = StyleSheet.flatten(style);
  return (
    <View accessibilityIgnoresInvertColors importantForAccessibility={importantForAccessibility} style={style}>
      <Image
        {...props}
        importantForAccessibility={importantForAccessibility}
        // Same workaround as RN's ImageBackground: re-apply the box's width and
        // height to the Image, which otherwise overrides them with its own.
        style={[StyleSheet.absoluteFill, { width: flattened?.width, height: flattened?.height }, imageStyle]}
      />
      {children}
    </View>
  );
}
