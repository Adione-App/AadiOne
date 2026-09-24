---
name: feedback-scroll-animation-architecture
description: User wants full architectural fixes for scroll/animation bugs in this app, not threshold tuning or partial patches
metadata:
  type: feedback
---

For scroll/animation jitter bugs in the Adione mobile app, the user
explicitly rejects partial fixes or threshold/cooldown tuning — they want
the real architectural cause found and fixed permanently, even if that
means refactoring (e.g. converting a layout-affecting animation to a
transform-based overlay).

**Why:** Their bug report for HomeScreen scroll jitter (2026-09-24) was
extremely detailed and explicitly said "I do NOT want a partial fix or
threshold tuning" and "If necessary, refactor... rather than applying
another small threshold/cooldown patch." They also want a debugging report
at the end identifying the exact root cause, not just "fixed it."

**How to apply:** When debugging jank/jitter/animation bugs in this repo,
inspect the FULL chain of shared values and animated styles (not just the
one file mentioned) before proposing a fix, prefer transform/opacity over
height/margin/layout animations tied to scroll, and end with a concrete
root-cause explanation (what moved, why, what changed) rather than just
"fixed." See [[project-mobile-scroll-jitter-fix]] for the concrete instance.
