/**
 * Rajasthan-only service area (service-state.ts): the state text is never
 * enough on its own — the point is checked against Rajasthan's boundary, and
 * a point too close to the border to place reliably fails safe.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared';
import { AppError } from '../../src/common/errors';
import {
  assertServiceState,
  normalizeServiceState,
  pointInServiceState,
  serviceStateProblem,
} from '../../src/modules/addresses/service-state';

const inside: [string, number, number][] = [
  ['Railmagra', 24.983, 74.12],
  ['Udaipur', 24.585, 73.712],
  ['Jaipur', 26.9124, 75.7873],
  ['Sikar', 27.6364, 75.1399],
  ['Bhiwadi', 28.205, 76.86],
  ['Abu Road', 24.48, 72.78],
  ['Jaisalmer', 26.915, 70.908],
  ['Sri Ganganagar', 29.904, 73.877],
  ['Kota', 25.18, 75.83],
];

const outside: [string, number, number][] = [
  ['Ahmedabad (GJ)', 23.03, 72.58],
  ['Delhi', 28.61, 77.21],
  ['Indore (MP)', 22.72, 75.86],
  ['Palanpur (GJ)', 24.17, 72.43],
  ['Gurugram (HR)', 28.46, 77.03],
  ['Agra (UP)', 27.18, 78.01],
  ['Neemuch (MP)', 24.47, 74.87],
  ['Mumbai', 19.07, 72.88],
  ['Across the Bhiwadi border (HR)', 28.235, 76.86],
];

describe('Rajasthan-only service area', () => {
  it.each(inside)('accepts %s', (_name, latitude, longitude) => {
    expect(serviceStateProblem({ state: 'Rajasthan', latitude, longitude })).toBeNull();
    expect(pointInServiceState(latitude, longitude)).toBe(true);
  });

  it.each(outside)('refuses %s even when the state text says Rajasthan', (_name, latitude, longitude) => {
    expect(serviceStateProblem({ state: 'Rajasthan', latitude, longitude })).toBe('OUTSIDE_STATE');
    expect(pointInServiceState(latitude, longitude)).toBe(false);
  });

  it('refuses a Rajasthan point whose state text is another state — or missing', () => {
    expect(serviceStateProblem({ state: 'Gujarat', latitude: 24.983, longitude: 74.12 })).toBe('STATE_NOT_SERVED');
    expect(serviceStateProblem({ state: '', latitude: 24.983, longitude: 74.12 })).toBe('STATE_NOT_SERVED');
    expect(serviceStateProblem({ state: null, latitude: 24.983, longitude: 74.12 })).toBe('STATE_NOT_SERVED');
  });

  it('fails safe within the border margin instead of guessing', () => {
    // ~200 m inside Rajasthan at Bhiwadi: cannot be placed reliably.
    expect(serviceStateProblem({ state: 'Rajasthan', latitude: 28.218, longitude: 76.86 })).toBe('NEAR_BORDER');
    expect(pointInServiceState(28.218, 76.86)).toBe(false);
  });

  it('normalises only spellings of Rajasthan', () => {
    expect(normalizeServiceState(' rajasthan ')).toBe('Rajasthan');
    expect(normalizeServiceState('RAJASTHAN')).toBe('Rajasthan');
    expect(normalizeServiceState('राजस्थान')).toBe('Rajasthan');
    expect(normalizeServiceState('Rajasthan Pradesh')).toBeNull();
    expect(normalizeServiceState('Gujarat')).toBeNull();
    expect(normalizeServiceState(undefined)).toBeNull();
  });

  it('throws OUTSIDE_SERVICE_STATE (422) with a clear message', () => {
    let error: unknown;
    try {
      assertServiceState({ state: 'Rajasthan', latitude: 23.03, longitude: 72.58 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.OUTSIDE_SERVICE_STATE);
    expect((error as AppError).message).toMatch(/only in Rajasthan/);
    expect(() => assertServiceState({ state: 'Rajasthan', latitude: 24.983, longitude: 74.12 })).not.toThrow();
  });
});
