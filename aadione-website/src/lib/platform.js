// Which store to offer first. Only the visitor's own browser is read; nothing
// is sent anywhere. iPadOS reports itself as a Mac, so a touch-capable "Mac"
// counts as iOS. Anything unrecognised is 'desktop': both stores are shown.

export function detectPlatform(nav = typeof navigator === 'undefined' ? null : navigator) {
  if (!nav) return 'desktop'
  const ua = nav.userAgent || ''
  if (/android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return 'ios'
  return 'desktop'
}
