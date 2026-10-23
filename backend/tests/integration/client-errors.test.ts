/**
 * App crash reports (POST /api/v1/client-errors): accepted without sign-in,
 * strictly validated, redacted before logging, rate-limited, never stored.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../helpers/api';
import { cache } from '../../src/infra/cache';
import { redactClientText } from '../../src/modules/client-errors/client-errors.routes';

const report = (overrides: Record<string, unknown> = {}) => ({
  source: 'error-boundary',
  fatal: true,
  name: 'TypeError',
  message: "Cannot read properties of undefined (reading 'items')",
  stack: 'TypeError: …\n    at CartScreen (index.bundle:1:2)',
  screen: 'CartHome',
  appVersion: '1.0.9',
  build: '10',
  platform: 'android',
  lastRequestId: '6f1c2b1e-8a4d-4c3b-9d2e-1a2b3c4d5e6f',
  ...overrides,
});

beforeEach(async () => {
  await cache.clear();
});

describe('app crash reports', () => {
  it('a valid report is accepted (204) without sign-in', async () => {
    await api().post('/api/v1/client-errors').send(report()).expect(204);
  });

  it('personal data and secrets never reach the log', () => {
    const redacted = redactClientText(
      'user asha@store.test mobile +91 98765 43210 / 9876543210 token Bearer abc.def.ghi jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig order 123456789012345 key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd',
    );
    for (const secret of ['asha@store.test', '98765 43210', '9876543210', 'abc.def.ghi', 'eyJhbGci', '123456789012345', 'AbCdEfGhIjKlMnOp']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[mobile]');
    expect(redacted).toContain('Bearer [redacted]');
  });

  it('unknown fields, bad values and oversized text are refused or cut', async () => {
    expect((await api().post('/api/v1/client-errors').send(report({ password: 'x' }))).status).toBe(400);
    expect((await api().post('/api/v1/client-errors').send(report({ source: 'anything' }))).status).toBe(400);
    expect((await api().post('/api/v1/client-errors').send(report({ screen: '<script>' }))).status).toBe(400);
    expect((await api().post('/api/v1/client-errors').send(report({ message: 'x'.repeat(5000) }))).status).toBe(400);
    await api().post('/api/v1/client-errors').send(report({ message: 'y'.repeat(1500) })).expect(204); // within bounds: cut to 500
  });

  it('is rate-limited per IP (a crash loop cannot flood the log)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await api().post('/api/v1/client-errors').send(report())).status);
    expect(statuses.slice(0, 30).every((s) => s === 204)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });
});
