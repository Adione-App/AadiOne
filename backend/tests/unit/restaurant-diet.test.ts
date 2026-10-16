/**
 * Restaurant diet classification and the ONE card mark (shared/dto.ts) —
 * pure. The Food list's filters and its card mark both come from these.
 */

import { describe, expect, it } from 'vitest';
import { classifyRestaurantDiet, restaurantCardDiet } from '../../src/shared';

const menu = (veg: boolean, nonVeg: boolean, any = veg || nonVeg) => ({
  hasLiveItem: any,
  hasLiveVegItem: veg,
  hasLiveNonVegItem: nonVeg,
});

describe('classifyRestaurantDiet', () => {
  it('pure veg: a veg-only kitchen with live items, or a menu whose marked items are all veg', () => {
    expect(classifyRestaurantDiet({ isVegOnly: true, ...menu(true, false) })).toEqual({ servesVeg: true, servesNonVeg: false, dietClass: 'PURE_VEG' });
    expect(classifyRestaurantDiet({ isVegOnly: false, ...menu(true, false) })).toEqual({ servesVeg: true, servesNonVeg: false, dietClass: 'PURE_VEG' });
    // A veg-only kitchen's unmarked items are veg by definition.
    expect(classifyRestaurantDiet({ isVegOnly: true, ...menu(false, false, true) })).toEqual({ servesVeg: true, servesNonVeg: false, dietClass: 'PURE_VEG' });
  });

  it('a veg-only kitchen NEVER serves non-veg, even with an item marked non-veg', () => {
    expect(classifyRestaurantDiet({ isVegOnly: true, ...menu(true, true) })).toEqual({ servesVeg: true, servesNonVeg: false, dietClass: 'PURE_VEG' });
    expect(classifyRestaurantDiet({ isVegOnly: true, ...menu(false, true) })).toEqual({ servesVeg: true, servesNonVeg: false, dietClass: 'PURE_VEG' });
  });

  it('pure non-veg: every marked live item is non-veg', () => {
    expect(classifyRestaurantDiet({ isVegOnly: false, ...menu(false, true) })).toEqual({ servesVeg: false, servesNonVeg: true, dietClass: 'PURE_NON_VEG' });
  });

  it('mixed: both kinds — eligible for both filters', () => {
    expect(classifyRestaurantDiet({ isVegOnly: false, ...menu(true, true) })).toEqual({ servesVeg: true, servesNonVeg: true, dietClass: 'MIXED' });
  });

  it('no live (or no marked) item: in no diet filter — a veg-only kitchen with an empty menu included', () => {
    expect(classifyRestaurantDiet({ isVegOnly: true, ...menu(false, false, false) })).toEqual({ servesVeg: false, servesNonVeg: false, dietClass: null });
    expect(classifyRestaurantDiet({ isVegOnly: false, ...menu(false, false, false) })).toEqual({ servesVeg: false, servesNonVeg: false, dietClass: null });
    expect(classifyRestaurantDiet({ isVegOnly: false, ...menu(false, false, true) })).toEqual({ servesVeg: false, servesNonVeg: false, dietClass: null });
  });
});

describe('restaurantCardDiet — one mark, never both', () => {
  it('green for pure veg, red for pure non-veg, none for mixed or unknown', () => {
    expect(restaurantCardDiet({ dietClass: 'PURE_VEG', servesVeg: true, servesNonVeg: false })).toBe('VEG');
    expect(restaurantCardDiet({ dietClass: 'PURE_NON_VEG', servesVeg: false, servesNonVeg: true })).toBe('NON_VEG');
    expect(restaurantCardDiet({ dietClass: 'MIXED', servesVeg: true, servesNonVeg: true })).toBeNull();
    expect(restaurantCardDiet({ dietClass: null, servesVeg: false, servesNonVeg: false })).toBeNull();
  });

  it('a server without dietClass: from servesVeg / servesNonVeg — both means none — else the legacy single diet', () => {
    expect(restaurantCardDiet({ servesVeg: true, servesNonVeg: true, diet: 'NON_VEG' })).toBeNull();
    expect(restaurantCardDiet({ servesVeg: true, servesNonVeg: false })).toBe('VEG');
    expect(restaurantCardDiet({ servesVeg: false, servesNonVeg: true })).toBe('NON_VEG');
    expect(restaurantCardDiet({ diet: 'VEG' })).toBe('VEG');
    expect(restaurantCardDiet({ diet: null })).toBeNull();
    expect(restaurantCardDiet({})).toBeNull();
  });

  it('never returns two marks for any combination', () => {
    for (const isVegOnly of [true, false])
      for (const veg of [true, false])
        for (const nonVeg of [true, false])
          for (const any of [true, false]) {
            const c = classifyRestaurantDiet({ isVegOnly, hasLiveItem: any || veg || nonVeg, hasLiveVegItem: veg, hasLiveNonVegItem: nonVeg });
            const mark = restaurantCardDiet(c);
            expect([null, 'VEG', 'NON_VEG']).toContain(mark);
            if (c.dietClass === 'MIXED') expect(mark).toBeNull();
            if (isVegOnly) expect(c.servesNonVeg).toBe(false);
          }
  });
});
