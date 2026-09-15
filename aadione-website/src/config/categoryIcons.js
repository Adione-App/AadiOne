import {
  ShoppingBasket,
  Apple,
  Milk,
  CupSoda,
  SprayCan,
  HeartPulse,
  Sparkles,
  Shirt,
  Cable,
  UtensilsCrossed,
  PackagePlus,
  LayoutGrid,
} from 'lucide-react'

// Maps `categories` ids (src/config/site.js) to a Lucide icon component.
export const CATEGORY_ICONS = {
  'grocery-food': ShoppingBasket,
  'fruits-vegetables': Apple,
  'dairy-bakery': Milk,
  beverages: CupSoda,
  'household-essentials': SprayCan,
  'personal-care': HeartPulse,
  'beauty-wellness': Sparkles,
  'clothing-fashion': Shirt,
  'electronics-accessories': Cable,
  'home-kitchen': UtensilsCrossed,
  'daily-essentials': PackagePlus,
  more: LayoutGrid,
}

export const DefaultCategoryIcon = LayoutGrid
