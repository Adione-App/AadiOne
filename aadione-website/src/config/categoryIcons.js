import { ShoppingBasket, Apple, UtensilsCrossed, Shirt, Cable, Sparkles, CookingPot, LayoutGrid } from 'lucide-react'

// Maps `marketplaceKinds` ids (src/config/site.js) to a Lucide icon component.
export const CATEGORY_ICONS = {
  grocery: ShoppingBasket,
  'fruits-vegetables': Apple,
  food: UtensilsCrossed,
  'clothing-fashion': Shirt,
  'electronics-accessories': Cable,
  'beauty-wellness': Sparkles,
  'home-kitchen': CookingPot,
}

export const DefaultCategoryIcon = LayoutGrid
