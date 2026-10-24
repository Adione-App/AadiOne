/**
 * Where to scroll so a form's working block (its input through its main
 * button) is fully visible while the keyboard is open — pure, so
 * `npm run test:unit` covers it; useKeyboardReveal.ts applies it.
 *
 * Everything is measured, never assumed: `viewportHeight` is the scroll
 * view's real visible height with the keyboard open (KeyboardAvoidingView
 * has already taken the keyboard's actual height off it), so the result
 * holds for any keyboard size, phone height or system navigation bar.
 */

export interface RevealInput {
  /** The block's top and bottom, in scroll-content coordinates. */
  blockTop: number;
  blockBottom: number;
  /** Visible height of the scroll view above the keyboard. */
  viewportHeight: number;
  /** Current scroll offset. */
  scrollY: number;
  /** Space kept clear at the top (status bar, a floating button). */
  topReserve: number;
  /** Breathing room kept below the block's bottom edge. */
  bottomGap: number;
}

/**
 * The scroll offset that shows the whole block, or null when it already is
 * (no needless jump). A block taller than the room left is aligned to its
 * top, so the input itself is never pushed off-screen.
 */
export function revealScrollTarget({ blockTop, blockBottom, viewportHeight, scrollY, topReserve, bottomGap }: RevealInput): number | null {
  if (viewportHeight <= 0 || blockBottom <= blockTop) return null;
  const visibleTop = scrollY + topReserve;
  const visibleBottom = scrollY + viewportHeight - bottomGap;
  if (blockTop >= visibleTop && blockBottom <= visibleBottom) return null;

  const room = viewportHeight - topReserve - bottomGap;
  // Hidden above, or too tall to fit: bring its top just below the reserve.
  // Otherwise it is hidden below: lift its bottom just above the keyboard.
  const next = blockTop < visibleTop || blockBottom - blockTop > room ? blockTop - topReserve : blockBottom + bottomGap - viewportHeight;
  const clamped = Math.max(0, Math.round(next));
  return clamped === Math.round(scrollY) ? null : clamped;
}
