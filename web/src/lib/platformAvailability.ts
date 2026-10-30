/**
 * App Settings → Global Availability — API (backend platform-availability.routes.ts).
 * Every write answers with the full, recomputed admin view, which replaces
 * the cached one. The master switch, its message, the timezone and the
 * default radius are existing configuration keys (PATCH /admin/config).
 */

import { useQuery } from '@tanstack/react-query';
import type { AdminPlatformAvailabilityDto, ConfigKey, PlatformDayHours, PlatformLocation } from '@shared';
import { api } from '@/lib/api';

export const PLATFORM_AVAILABILITY_KEY = ['admin', 'platform-availability'] as const;
const BASE = '/admin/platform-availability';

export const platformApi = {
  view: () => api.get<AdminPlatformAvailabilityDto>(BASE),
  setHours: (hours: PlatformDayHours[]) => api.put<AdminPlatformAvailabilityDto>(`${BASE}/hours`, { hours }),
  setLocation: (location: PlatformLocation | null) => api.put<AdminPlatformAvailabilityDto>(`${BASE}/location`, { location }),
  pauseNow: (message: string | null, resumeAtLocal: string | null) =>
    api.post<AdminPlatformAvailabilityDto>(`${BASE}/pauses`, { kind: 'IMMEDIATE', message, resumeAtLocal }),
  schedulePause: (message: string | null, startsAtLocal: string, endsAtLocal: string) =>
    api.post<AdminPlatformAvailabilityDto>(`${BASE}/pauses`, { kind: 'SCHEDULED', message, startsAtLocal, endsAtLocal }),
  startEmergency: (message: string | null) => api.post<AdminPlatformAvailabilityDto>(`${BASE}/pauses`, { kind: 'EMERGENCY', message }),
  updatePause: (id: string, body: { message?: string | null; startsAtLocal?: string; endsAtLocal?: string | null }) =>
    api.patch<AdminPlatformAvailabilityDto>(`${BASE}/pauses/${id}`, body),
  cancelPause: (id: string) => api.post<AdminPlatformAvailabilityDto>(`${BASE}/pauses/${id}/cancel`),
  endPause: (id: string) => api.post<AdminPlatformAvailabilityDto>(`${BASE}/pauses/${id}/end`),
  addHoliday: (body: HolidayBody) => api.post<AdminPlatformAvailabilityDto>(`${BASE}/holidays`, body),
  updateHoliday: (id: string, body: HolidayBody) => api.put<AdminPlatformAvailabilityDto>(`${BASE}/holidays/${id}`, body),
  deleteHoliday: (id: string) => api.delete<AdminPlatformAvailabilityDto>(`${BASE}/holidays/${id}`),
  /** Existing configuration keys: ORDERING_ENABLED, ORDERING_PAUSED_MESSAGE, STORE_TIMEZONE, MAX_SERVICE_RADIUS_KM. */
  setConfig: (key: ConfigKey, value: unknown) => api.patch<unknown>('/admin/config', { key, value }),
};

export interface HolidayBody {
  name: string;
  message: string | null;
  startDate: string;
  endDate: string;
}

export function usePlatformAvailabilityAdmin() {
  return useQuery({
    queryKey: PLATFORM_AVAILABILITY_KEY,
    queryFn: platformApi.view,
    // The computed status follows the clock: refresh it while the page is open.
    refetchInterval: 60_000,
  });
}

/** Monday first, as the admin reads a week; dayOfWeek is 0 = Sunday … 6 = Saturday. */
export const WEEK_DAYS: { dayOfWeek: number; name: string }[] = [
  { dayOfWeek: 1, name: 'Monday' },
  { dayOfWeek: 2, name: 'Tuesday' },
  { dayOfWeek: 3, name: 'Wednesday' },
  { dayOfWeek: 4, name: 'Thursday' },
  { dayOfWeek: 5, name: 'Friday' },
  { dayOfWeek: 6, name: 'Saturday' },
  { dayOfWeek: 0, name: 'Sunday' },
];

/** Problems with a weekly schedule draft, in words (the server checks the same). */
export function hoursProblems(hours: PlatformDayHours[]): string | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const day of hours) {
    if (day.isClosed) continue;
    if (!time.test(day.opensAt) || !time.test(day.closesAt)) {
      return `${WEEK_DAYS.find((d) => d.dayOfWeek === day.dayOfWeek)?.name ?? 'A day'}: enter both an opening and a closing time.`;
    }
  }
  return null;
}

/** "8:00 AM" from "08:00". */
export function time12(value: string): string {
  const [h = 0, m = 0] = value.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "8:00 AM – 10:00 PM", "Open all day", "6:00 PM – 2:00 AM (next day)", "Closed". */
export function describeHours(day: { isClosed: boolean; opensAt: string; closesAt: string } | null | undefined): string {
  if (!day || day.isClosed) return 'Closed';
  if (day.opensAt === day.closesAt) return 'Open all day';
  return `${time12(day.opensAt)} – ${time12(day.closesAt)}${day.closesAt < day.opensAt ? ' (next day)' : ''}`;
}

/** An ISO instant shown in the platform timezone. */
export function formatInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "YYYY-MM-DDTHH:mm" shown readably (it is already a platform-timezone wall time). */
export function formatLocal(local: string | null | undefined): string {
  if (!local) return '—';
  const [date = '', time = ''] = local.split('T');
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const label = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return `${label}, ${time12(time)}`;
}
