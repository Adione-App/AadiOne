/**
 * Bottom-tab glyphs.
 *
 * Uses Ionicons (already bundled via @expo/vector-icons for the rest of the
 * app) so the tab bar matches the icon style used everywhere else, with a
 * filled variant on the active tab and an outline variant when inactive.
 */

import { Ionicons } from '@expo/vector-icons';

const SIZE = 24;

type IconProps = { color: string; focused?: boolean };

export function HomeIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'home' : 'home-outline'} size={SIZE} color={color} />
  );
}

export function CategoriesIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'grid' : 'grid-outline'} size={SIZE} color={color} />
  );
}

export function FoodIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'fast-food' : 'fast-food-outline'} size={SIZE} color={color} />
  );
}

export function CartIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'cart' : 'cart-outline'} size={SIZE} color={color} />
  );
}

export function WishlistIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'heart' : 'heart-outline'} size={SIZE} color={color} />
  );
}

export function AccountIcon({ color, focused }: IconProps) {
  return (
    <Ionicons name={focused ? 'person' : 'person-outline'} size={SIZE} color={color} />
  );
}
