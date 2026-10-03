import { z } from 'zod';

/**
 * Coordinates arrive as query-string text and must be coerced.
 *
 * The range checks matter: a failed GPS fix on Android frequently yields
 * `0, 0`, which is ~6,000 km away in the Gulf of Guinea. Without an explicit
 * bound the customer would just see "we don't deliver here" and blame the app,
 * so an out-of-range value is rejected as invalid input instead.
 */
export const serviceabilityQuerySchema = z.object({
  lat: z.coerce
    .number({ invalid_type_error: 'Latitude must be a number' })
    .refine(Number.isFinite, 'Latitude must be a number')
    .refine((v) => v >= -90 && v <= 90, 'Latitude is out of range')
    .refine((v) => v !== 0, 'Could not read your location. Please try again.'),
  lng: z.coerce
    .number({ invalid_type_error: 'Longitude must be a number' })
    .refine(Number.isFinite, 'Longitude must be a number')
    .refine((v) => v >= -180 && v <= 180, 'Longitude is out of range')
    .refine((v) => v !== 0, 'Could not read your location. Please try again.'),
});

export type ServiceabilityQuery = z.infer<typeof serviceabilityQuerySchema>;
