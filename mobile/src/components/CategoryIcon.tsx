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
import { resolveImageUrl } from "@/lib/api";

type CategoryVisual = {
  icon: LucideIcon;
  tint: {
    bg: string;
    fg: string;
  };
};

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
    borderRadius: 10,
  };

  const imageSource = imageUrl ? resolveImageUrl(imageUrl) : undefined;

  if (imageSource) {
    return (
      <Image
        source={{ uri: imageSource }}
        style={[box, styles.image]}
        contentFit="contain"
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

function resolveCategoryVisual(name: string): CategoryVisual {
  const value = name.toLowerCase();

  if (
    value.includes("baby") ||
    value.includes("kid") ||
    value.includes("child")
  ) {
    return {
      icon: Baby,
      tint: { bg: "#E8F5E9", fg: "#388E3C" },
    };
  }

  if (
    value.includes("fruit") ||
    value.includes("vegetable") ||
    value.includes("sabzi")
  ) {
    return {
      icon: Carrot,
      tint: { bg: "#E8F5E9", fg: "#388E3C" },
    };
  }

  if (
    value.includes("rice") ||
    value.includes("atta") ||
    value.includes("wheat")
  ) {
    return {
      icon: Wheat,
      tint: { bg: "#FFF3E0", fg: "#A66A00" },
    };
  }

  if (value.includes("oil") || value.includes("ghee")) {
    return {
      icon: Droplet,
      tint: { bg: "#FFF8E1", fg: "#B8860B" },
    };
  }

  if (value.includes("masala") || value.includes("spice")) {
    return {
      icon: Flame,
      tint: { bg: "#FBE9E7", fg: "#D84315" },
    };
  }

  if (value.includes("salt") || value.includes("sugar")) {
    return {
      icon: Soup,
      tint: { bg: "#F3E5F5", fg: "#8E24AA" },
    };
  }

  if (value.includes("biscuit") || value.includes("cookie")) {
    return {
      icon: Cookie,
      tint: { bg: "#FFF3E0", fg: "#8D6E63" },
    };
  }

  if (value.includes("snack") || value.includes("candy")) {
    return {
      icon: Candy,
      tint: { bg: "#FCE4EC", fg: "#C2185B" },
    };
  }

  if (
    value.includes("drink") ||
    value.includes("juice") ||
    value.includes("beverage")
  ) {
    return {
      icon: CupSoda,
      tint: { bg: "#E3F2FD", fg: "#1976D2" },
    };
  }

  if (value.includes("dairy") || value.includes("milk")) {
    return {
      icon: Milk,
      tint: { bg: "#E3F2FD", fg: "#1565C0" },
    };
  }

  if (value.includes("egg")) {
    return {
      icon: Egg,
      tint: { bg: "#FFF8E1", fg: "#8D6E63" },
    };
  }

  if (value.includes("ice cream") || value.includes("icecream")) {
    return {
      icon: Snowflake,
      tint: { bg: "#E1F5FE", fg: "#0288D1" },
    };
  }

  if (
    value.includes("clothing") ||
    value.includes("cloth") ||
    value.includes("fashion") ||
    value.includes("men") ||
    value.includes("women")
  ) {
    return {
      icon: ShoppingBag,
      tint: { bg: "#F3E5F5", fg: "#7B1FA2" },
    };
  }

  if (value.includes("pet")) {
    return {
      icon: PawPrint,
      tint: { bg: "#FFF3E0", fg: "#8D6E63" },
    };
  }

  if (value.includes("clean") || value.includes("household")) {
    return {
      icon: SprayCan,
      tint: { bg: "#E0F2F1", fg: "#00796B" },
    };
  }

  if (
    value.includes("personal care") ||
    value.includes("bath") ||
    value.includes("shower")
  ) {
    return {
      icon: ShowerHead,
      tint: { bg: "#E3F2FD", fg: "#1976D2" },
    };
  }

  if (
    value.includes("stationery") ||
    value.includes("pencil") ||
    value.includes("school")
  ) {
    return {
      icon: Pencil,
      tint: { bg: "#FFF8E1", fg: "#F9A825" },
    };
  }

  return {
    icon: Croissant,
    tint: { bg: "#E8F5E9", fg: "#388E3C" },
  };
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: "transparent",
    borderRadius: 10,
  },
  iconBox: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
});
