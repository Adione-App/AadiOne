/**
 * Splash / Get Started
 *
 * Branded AdiOne welcome screen.
 *
 * Design:
 * - Larger grocery bag at the top
 * - AdiOne logo
 * - Hindi headline
 * - Delivery promise
 * - Three feature highlights
 * - Large soft village/store illustration in the lower section
 * - Get Started button over the illustration
 * - No login text/link
 */

import {
  Image,
  ImageBackground,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";

import type { PublicConfig } from "@shared";
import { colors, radius, spacing } from "@shared/theme";

import { api } from "@/lib/api";
import { AppText, Button, Screen } from "@/components/ui";

import adioneBagLogo from "../../../assets/adione-bag-logo.png";
import adioneLogo from "../../../assets/adione-logo.png";

import fastDeliveryIcon from "../../../assets/fast-delivary-icon.png";
import bestPricesIcon from "../../../assets/best-prices-icon.png";
import trustedStoreIcon from "../../../assets/trusted-store-icon.png";

import adioneBackground from "../../../assets/adione-background.png";

/* =====================================================================
   HIGHLIGHTS
===================================================================== */

const HIGHLIGHTS = [
  {
    title: "Fast Delivery",
    image: fastDeliveryIcon,
  },
  {
    title: "Trusted Store",
    image: trustedStoreIcon,
  },
  {
    title: "Best Prices",
    image: bestPricesIcon,
  },
];

/* =====================================================================
   SPLASH SCREEN
===================================================================== */

export default function SplashScreen({
  onGetStarted,
}: {
  onGetStarted: () => void;
}) {
  const insets = useSafeAreaInsets();

  const { height: screenHeight, width: screenWidth } = useWindowDimensions();

  /* ================================================================
     PUBLIC CONFIG
  ================================================================ */

  const { data } = useQuery({
    queryKey: ["public-config"],
    queryFn: () => api.get<PublicConfig>("/config/public"),
    staleTime: 5 * 60_000,
  });

  const promise = data?.DELIVERY_PROMISE_TEXT ?? "in 10 minutes";

  /* ================================================================
     RESPONSIVE SIZES

     These values are deliberately based on screen height so the
     layout remains close to the reference on different phones.
  ================================================================ */

  const isSmallScreen = screenHeight < 720;
  const isMediumScreen = screenHeight >= 720 && screenHeight <= 850;
  const isLargeScreen = screenHeight > 850;

  /* ================================================================
     GROCERY BAG

     Larger than the previous version.
  ================================================================ */

  const bagSize = isSmallScreen ? 250 : isMediumScreen ? 270 : 300;

  /* ================================================================
     ADIONE LOGO
  ================================================================ */

  const logoWidth = isSmallScreen ? 215 : isMediumScreen ? 235 : 280;

  const logoHeight = isSmallScreen ? 61 : isMediumScreen ? 67 : 80;

  /* ================================================================
     LOWER BACKGROUND

     IMPORTANT:

     The old implementation used a small 180-235px image at the
     bottom. That is why the village illustration appeared only
     at the very bottom.

     This version makes the illustration a large lower section.
  ================================================================ */

  const lowerBackgroundTop = isSmallScreen
    ? screenHeight * 0.64
    : isMediumScreen
      ? screenHeight * 0.61
      : screenHeight * 0.59;

  return (
    <Screen style={styles.screen}>
      {/* =============================================================
          LOWER VILLAGE / STORE BACKGROUND

          It begins below the feature section and fills the entire
          lower portion of the screen.

          The button is positioned above this background.
      ============================================================= */}

      <ImageBackground
        source={adioneBackground}
        resizeMode="contain"
        style={[
          styles.background,
          {
            top: lowerBackgroundTop,
            bottom: -insets.bottom,
          },
        ]}
        imageStyle={styles.backgroundImage}
      >
        {/* Makes the original illustration softer/lighter */}
        <View style={styles.backgroundLightOverlay} />
      </ImageBackground>

      {/* =============================================================
          MAIN CONTENT
      ============================================================= */}

      <View
        style={[
          styles.content,
          {
            paddingTop:
              insets.top + (isSmallScreen ? 14 : isMediumScreen ? 20 : 26),

            paddingBottom: 0,
          },
        ]}
      >
        {/* =========================================================
            BRAND
        ========================================================= */}

        <View
          style={[
            styles.brandSection,
            {
              marginTop: isSmallScreen ? 4 : isMediumScreen ? 8 : 12,
            },
          ]}
        >
          {/* ---------------------------------------------------------
              GROCERY BAG
          --------------------------------------------------------- */}

          <Image
            source={adioneBagLogo}
            style={{
              width: bagSize,
              height: bagSize,
            }}
            resizeMode="contain"
            accessibilityLabel="AdiOne grocery bag"
          />

          {/* ---------------------------------------------------------
              ADIONE FULL LOGO
          --------------------------------------------------------- */}

          <Image
            source={adioneLogo}
            style={{
              width: logoWidth,
              height: logoHeight,
              marginTop: isSmallScreen ? -2 : 0,
            }}
            resizeMode="contain"
            accessibilityLabel="AdiOne"
          />
        </View>

        {/* =========================================================
            TEXT
        ========================================================= */}

        <View
          style={[
            styles.textSection,
            {
              marginTop: isSmallScreen ? 1 : 4,
            },
          ]}
        >
          <AppText variant="h2" style={styles.heading}>
            Sab kuch, abhi ke abhi!
          </AppText>

          <AppText
            variant="bodyLarge"
            color={colors.textSecondary}
            style={styles.subtitle}
            numberOfLines={1}
          >
            Daily essentials, delivered{" "}
            <AppText variant="bodyLarge" color={colors.primary}>
              {promise}
            </AppText>
          </AppText>
        </View>

        {/* =========================================================
            FEATURES
        ========================================================= */}

        <View
          style={[
            styles.highlights,
            {
              marginTop: isSmallScreen ? 17 : isMediumScreen ? 22 : 27,
            },
          ]}
        >
          {HIGHLIGHTS.map((item) => (
            <View key={item.title} style={styles.highlight}>
              {/* ---------------------------------------------------
                  ICON CIRCLE
              --------------------------------------------------- */}

              <View style={styles.highlightCircle}>
                <Image
                  source={item.image}
                  style={styles.featureImage}
                  resizeMode="contain"
                  accessibilityLabel={item.title}
                />
              </View>

              {/* ---------------------------------------------------
                  LABEL
              --------------------------------------------------- */}

              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.highlightText}
                numberOfLines={1}
              >
                {item.title}
              </AppText>
            </View>
          ))}
        </View>

        {/* =========================================================
            LOWER FLEXIBLE AREA

            This pushes the CTA toward the bottom while the
            background illustration remains visible behind it.
        ========================================================= */}

        <View style={styles.illustrationSpace} />

        {/* =========================================================
            GET STARTED BUTTON

            Button is intentionally placed inside the lower
            illustration section.
        ========================================================= */}

        <View
          style={[
            styles.bottomSection,
            {
              paddingBottom:
                insets.bottom + (isSmallScreen ? 22 : isMediumScreen ? 25 : 28),
            },
          ]}
        >
          <Button
            label="Get Started"
            onPress={onGetStarted}
            style={styles.getStartedButton}
          />
        </View>
      </View>
    </Screen>
  );
}

/* =====================================================================
   STYLES
===================================================================== */

const styles = StyleSheet.create({
  /* ================================================================
     SCREEN
  ================================================================ */

  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",

    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,

    overflow: "hidden",
  },

  /* ================================================================
     LOWER BACKGROUND
  ================================================================ */

  background: {
    position: "absolute",

    left: 0,
    right: 0,

    width: "100%",

    zIndex: 0,
  },

  backgroundImage: {
    opacity: 0.72,
  },

  backgroundLightOverlay: {
    ...StyleSheet.absoluteFill,

    backgroundColor: "rgba(255,255,255,0.28)",
  },

  /* ================================================================
     CONTENT
  ================================================================ */

  content: {
    flex: 1,

    width: "100%",

    paddingHorizontal: spacing.base,

    alignItems: "center",

    zIndex: 1,
  },

  /* ================================================================
     BRAND
  ================================================================ */

  brandSection: {
    width: "100%",

    alignItems: "center",

    justifyContent: "center",
  },

  /* ================================================================
     TEXT
  ================================================================ */

  textSection: {
    width: "100%",

    alignItems: "center",

    justifyContent: "center",
  },

  heading: {
    textAlign: "center",

    fontSize: 21,

    lineHeight: 26,

    fontWeight: "800",

    color: colors.textPrimary,
  },

  subtitle: {
    textAlign: "center",

    fontSize: 13.5,

    lineHeight: 19,

    marginTop: 4,
  },

  /* ================================================================
     FEATURES
  ================================================================ */

  highlights: {
    width: "100%",

    flexDirection: "row",

    justifyContent: "space-between",

    alignItems: "flex-start",

    paddingHorizontal: 4,
  },

  highlight: {
    flex: 1,

    alignItems: "center",

    justifyContent: "flex-start",

    maxWidth: 120,
  },

  /* ================================================================
     FEATURE ICON CIRCLE
  ================================================================ */

  highlightCircle: {
    width: 64,
    height: 64,

    borderRadius: radius.circle,

    backgroundColor: colors.primarySurface,

    alignItems: "center",
    justifyContent: "center",
  },

  featureImage: {
    width: 47,
    height: 47,
  },

  highlightText: {
    textAlign: "center",

    fontSize: 11.5,

    lineHeight: 16,

    marginTop: 7,
  },

  /* ================================================================
     ILLUSTRATION SPACE

     The large flexible area is what allows the background to sit
     between the features and the CTA instead of only at the bottom.
  ================================================================ */

  illustrationSpace: {
    flex: 1,

    width: "100%",

    minHeight: 40,
  },

  /* ================================================================
     BOTTOM CTA
  ================================================================ */

  bottomSection: {
    width: "100%",

    alignItems: "center",

    justifyContent: "flex-end",

    zIndex: 5,
  },

  /* ================================================================
     GET STARTED BUTTON
  ================================================================ */

  getStartedButton: {
    width: "100%",

    minHeight: 54,

    borderRadius: radius.pill,
  },
});
