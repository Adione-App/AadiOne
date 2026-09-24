---
name: project-mobile-scroll-jitter-fix
description: HomeScreen scroll jitter root causes and the transform-only fix applied to MainTabs.tsx/HomeScreen.tsx/MiniCartBar.tsx
metadata:
  type: project
---

The Adione mobile app's HomeScreen had severe jitter (product cards/images
shaking, whole page appearing to move) during slow scroll, held-finger
tremor, and direction changes. Fixed 2026-09-24.

Two independent root causes, both were "animate a real layout property
(`height`/`marginTop`) tied to scroll," which reflows the ScrollView (and
therefore all product content) on every frame:

1. `mobile/src/navigation/MainTabs.tsx` — `AnimatedTabBar` animated its
   wrapper's actual `height` (0 <-> barHeight) as a flex sibling of the
   screen content, so hiding/showing the tab bar resized HomeScreen's own
   ScrollView viewport on every scroll-direction flip.
2. `mobile/src/screens/home/HomeScreen.tsx` — the collapsing
   location-header row animated `height`/`marginTop` directly off raw,
   unthrottled `scrollY` (no hysteresis at all, unlike the tab-bar-hide
   logic), so any sub-pixel scrollY wobble during a slow/held drag reflowed
   the entire page below it, every frame. This was likely the DOMINANT
   contributor to the reported symptoms, more so than #1.

**Fix pattern established for this codebase**: never animate `height`,
`marginTop`, or `bottom` on anything that shares layout with scrollable
product content. Convert to `transform: translateY` + `opacity` on an
absolutely-positioned overlay instead, with any needed space reservation
done via a CONSTANT (never-animated) padding/slot.

**Why:** The MainTabs.tsx AnimatedTabBar doc comment records THREE prior
designs tried and rejected for this exact bar before landing on the
constant-slot + transform-overlay split — `display:none` (jump), a
constant-height slot with no background (revealed white through it), and
the height-animation this fix replaced (caused this bug). The header
collapse was never previously fixed with hysteresis the way the tab-bar
hide logic was.

**How to apply:** If asked to touch scroll/tab-bar/mini-cart animation in
this app again, check `mobile/src/navigation/MainTabs.tsx`'s
`AnimatedTabBar` comment and `mobile/src/screens/home/HomeScreen.tsx`'s
`scrollY` comment first — they document this constraint in detail. Product
Detail is a deliberate, safe exception: its tab-bar-hide is a
navigation-focus-driven (not scroll-driven) change, so animating the
reservation slot's height JUST for that one case is fine — see
`slotAnimatedStyle` in MainTabs.tsx.

Related: [[feedback-scroll-animation-architecture]]
