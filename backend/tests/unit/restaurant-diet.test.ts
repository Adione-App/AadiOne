/**
 * A restaurant's own veg / non-veg classification (shared/dto.ts) — pure.
 * The Food list's filters, its card mark and the menu header all come from
 * it; it is the restaurant's saved pure-veg setting, never its menu.
 */

import { describe, expect, it } from 'vitest';
import { restaurantDietOf } from '../../src/shared';

describe('restaurantDietOf', () => {
  it('a pure-veg restaurant is VEG', () => {
    expect(restaurantDietOf({ isVegOnly: true })).toBe('VEG');
  });

  it('every other restaurant is NON_VEG, whatever veg dishes its menu has', () => {
    // Nepali Kitchen: Chicken Curry, Paneer Dish, Veg Chow Mein — still non-veg.
    expect(restaurantDietOf({ isVegOnly: false })).toBe('NON_VEG');
  });

  it('takes nothing but the saved setting — extra menu facts cannot change it', () => {
    const nonVegWithVegDishes = { isVegOnly: false, items: [{ diet: 'VEG' }, { diet: 'VEG' }] };
    const vegWithMismarkedItem = { isVegOnly: true, items: [{ diet: 'NON_VEG' }] };
    expect(restaurantDietOf(nonVegWithVegDishes)).toBe('NON_VEG');
    expect(restaurantDietOf(vegWithMismarkedItem)).toBe('VEG');
  });
});
