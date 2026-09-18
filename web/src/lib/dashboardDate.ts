/**
 * Date helpers for the admin dashboard's date picker.
 *
 * Deliberately anchored to the store's business timezone (Asia/Kolkata),
 * not the admin's own device timezone — an admin checking the dashboard
 * from outside India should still see the same "today" and day boundaries
 * the store itself operates on.
 */

/** "YYYY-MM-DD" for right now, in the store's business timezone. */
export function todayIsoInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
}

/**
 * "17 Sep" for a "YYYY-MM-DD" string. Parsed at UTC noon rather than UTC
 * midnight so formatting on the admin's own (possibly non-Indian) device
 * timezone can't shift it to the adjacent day.
 */
export function formatShortDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00.000Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}
