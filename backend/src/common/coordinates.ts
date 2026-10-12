/**
 * Zod refinement for a location sent as a query (lat / lng): beyond the range
 * checks, refuses (0, 0) and latitude / longitude passed the wrong way round.
 * A point simply outside India is NOT an error here — it is answered as
 * "not serviceable" (a phone can be abroad); saved addresses and store points
 * are stricter (requireIndia, see address.routes / seller location).
 */

import { z } from 'zod';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../shared/distance';

export function refineQueryCoordinates(query: { lat?: number; lng?: number }, ctx: z.RefinementCtx): void {
  if (query.lat === undefined || query.lng === undefined) return;
  const problem = coordinateProblem(query.lat, query.lng);
  if (problem === 'SWAPPED' || problem === 'NULL_ISLAND') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lat'], message: COORDINATE_PROBLEM_MESSAGE[problem] });
  }
}
