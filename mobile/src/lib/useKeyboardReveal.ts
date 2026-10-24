/**
 * Keeps a form's working block — its input through its main button — fully
 * visible above the keyboard (login and OTP screens).
 *
 * The screen wraps its ScrollView in a KeyboardAvoidingView with
 * behavior="padding" on both platforms (as AddressFormScreen does): with
 * Android edge-to-edge the window is no longer resized for the keyboard, so
 * the padding is what makes room. This hook then scrolls just far enough to
 * show the block, from MEASURED sizes only — the scroll view's position on
 * screen and the keyboard's real top edge — never a fixed offset, so any
 * keyboard height, phone size or navigation bar works (keyboardReveal.ts).
 *
 * It re-checks when the keyboard opens, when the scroll view's size changes
 * (the padding landing after the keyboard event) and when an input is
 * focused (`reveal`).
 */

import { useCallback, useEffect, useRef } from "react";
import { Keyboard, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, type View } from "react-native";
import { revealScrollTarget } from "./keyboardReveal";

export function useKeyboardReveal({ topReserve, bottomGap = 16 }: { topReserve: number; bottomGap?: number }) {
  const scrollRef = useRef<ScrollView>(null);
  /** A plain View filling the same area as the ScrollView — measured on screen. */
  const frameRef = useRef<View>(null);
  /** The ScrollView's single content child — the block is measured against it. */
  const contentRef = useRef<View>(null);
  /** The block to keep visible. */
  const blockRef = useRef<View>(null);
  const scrollY = useRef(0);
  /** The keyboard's top edge in screen coordinates while it is open, else null. */
  const keyboardTop = useRef<number | null>(null);

  const reveal = useCallback(() => {
    const scroll = scrollRef.current;
    const frame = frameRef.current;
    const content = contentRef.current;
    const block = blockRef.current;
    const top = keyboardTop.current;
    if (top === null || !scroll || !frame || !content || !block) return;
    // The scroll view's real visible area: its own measured height, or less
    // if the keyboard still overlaps its bottom (padding not applied yet).
    frame.measureInWindow((_x, y, _width, height) => {
      const viewportHeight = Math.min(height, top - y);
      block.measureLayout(
        content,
        (_left, blockTop, _blockWidth, blockHeight) => {
          const target = revealScrollTarget({
            blockTop,
            blockBottom: blockTop + blockHeight,
            viewportHeight,
            scrollY: scrollY.current,
            topReserve,
            bottomGap,
          });
          if (target !== null) scroll.scrollTo({ y: target, animated: true });
        },
        () => undefined,
      );
    });
  }, [topReserve, bottomGap]);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      requestAnimationFrame(reveal);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardTop.current = null;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [reveal]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = event.nativeEvent.contentOffset.y;
  }, []);

  /** Spread onto the ScrollView. */
  const scrollProps = { ref: scrollRef, onScroll, scrollEventThrottle: 16 };
  /** Spread onto the View (flex: 1) that wraps the ScrollView inside the KeyboardAvoidingView. */
  const frameProps = {
    ref: frameRef,
    collapsable: false,
    // The KeyboardAvoidingView's padding resizes the frame after the keyboard event.
    onLayout: () => requestAnimationFrame(reveal),
  };

  return { scrollProps, frameProps, contentRef, blockRef, reveal };
}
