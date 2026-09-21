/**
 * Category icon.
 *
 * Categories carry an optional `imageUrl` that the shop can set from the admin
 * panel. Until they do, the app showed an empty grey circle for every
 * category, which is worse than useless — it reads as a broken image and gives
 * the customer nothing to scan for.
 *
 * The fallback is a Lucide vector icon chosen by matching keywords in the
 * category name, each on its own tinted background. Vector icons over emoji
 * because emoji render inconsistently across Android OEM keyboards/fonts (some
 * show as outlined placeholders), while a vector icon looks identical and
 * crisp on every device and can carry the app's own colour system instead of
 * the phone's stock emoji palette — the difference between "looks like a
 * grocery list" and "looks like a shopping app". A real uploaded image always
 * wins when one exists.
 *
 * Matching is on the name rather than a fixed id map so a category the shop
 * adds later still gets a sensible icon instead of the generic bag.
 */

import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { LucideIcon } from "lucide-react-native";
import {
  Baby,
  Candy,
  Carrot,
  Cookie,
  CupSoda,
  Croissant,
  Droplet,
  Egg,
  Flame,
  Milk,
  PawPrint,
  Pencil,
  ShoppingBag,
  ShowerHead,
  Snowflake,
  Soup,
  SprayCan,
  Wheat,
} from "lucide-react-native";
import { palette, radius } from "@shared/theme";
import { resolveImageUrl } from "@/lib/api";

/** A tinted background paired with the icon colour drawn on top of it. */
type Tint = { bg: string; fg: string };

const TINTS = {
  green: { bg: palette.green50, fg: palette.green600 },
  amber: { bg: palette.amber50, fg: palette.amber500 },
  blue: { bg: palette.blue50, fg: palette.blue500 },
  purple: { bg: palette.purple50, fg: palette.purple500 },
  red: { bg: palette.red50, fg: palette.red500 },
  grey: { bg: palette.grey100, fg: palette.grey600 },
} as const satisfies Record<string, Tint>;

interface Rule {
  match: RegExp;
  icon: LucideIcon;
  tint: Tint;
}

/**
 * Ordered: the first match wins, so put specific terms before generic ones.
 * "baby" must beat "care", and "ice cream" must beat "cream".
 */
const RULES: Rule[] = [
  { match: /baby|diaper|infant/i, icon: Baby, tint: TINTS.purple },
  { match: /atta|flour|rice|dal|pulse|grain|staple/i, icon: Wheat, tint: TINTS.amber },
  { match: /oil|ghee|vanaspati/i, icon: Droplet, tint: TINTS.amber },
  { match: /masala|spice|salt|namak/i, icon: Flame, tint: TINTS.red },
  { match: /tea|coffee|drink|beverage|juice|water/i, icon: CupSoda, tint: TINTS.blue },
  { match: /biscuit|snack|namkeen|chips|cookie/i, icon: Cookie, tint: TINTS.amber },
  { match: /milk|dairy|curd|paneer|butter|cheese/i, icon: Milk, tint: TINTS.blue },
  { match: /noodle|pasta|vermicelli|maggi/i, icon: Soup, tint: TINTS.amber },
  { match: /sauce|spread|ketchup|jam|pickle|achar/i, icon: Soup, tint: TINTS.red },
  { match: /sweet|sugar|honey|jaggery|gur/i, icon: Candy, tint: TINTS.amber },
  { match: /packaged|ready|instant|frozen/i, icon: Snowflake, tint: TINTS.blue },
  { match: /household|clean|detergent|utensil|dishwash/i, icon: SprayCan, tint: TINTS.blue },
  { match: /personal|soap|shampoo|toothpaste|hygiene|care/i, icon: ShowerHead, tint: TINTS.purple },
  { match: /fruit|vegetable|veg|sabzi|fresh/i, icon: Carrot, tint: TINTS.green },
  { match: /egg|meat|chicken|fish|non.?veg/i, icon: Egg, tint: TINTS.red },
  { match: /bread|bakery|cake|bun/i, icon: Croissant, tint: TINTS.amber },
  { match: /chocolate|candy|confection/i, icon: Candy, tint: TINTS.red },
  { match: /pet|dog|cat/i, icon: PawPrint, tint: TINTS.purple },
  { match: /stationer|office|book/i, icon: Pencil, tint: TINTS.grey },
];

/** Generic enough to never look wrong, specific enough to read as "goods". */
const FALLBACK: Rule = { match: /.*/, icon: ShoppingBag, tint: TINTS.green };

function resolveCategoryVisual(name: string): Rule {
  return RULES.find((rule) => rule.match.test(name)) ?? FALLBACK;
}

export default function CategoryIcon({
  name,
  imageUrl,
  size = 56,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  const box = {
    width: size,
    height: size,
    borderRadius: radius.circle,
  };

  if (imageUrl) {
    return (
      <Image
        source={{
          uri: resolveImageUrl(imageUrl) ?? undefined,
        }}
        style={[box, styles.image]}
        contentFit="cover"
        transition={150}
        cachePolicy="memory-disk"
        accessibilityLabel={name}
      />
    );
  }

  const { icon: Icon, tint } = resolveCategoryVisual(name);

  return (
    <View
      style={[box, styles.iconBox, { backgroundColor: tint.bg }]}
      accessibilityLabel={name}
    >
      <Icon size={size * 0.46} color={tint.fg} strokeWidth={1.9} />
    </View>
  );
}

const styles = StyleSheet.create({
  image: { backgroundColor: palette.grey50 },
  iconBox: {
    alignItems: "center",
    justifyContent: "center",
  },
});
