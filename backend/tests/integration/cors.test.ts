/**
 * Browser origins (app.ts + config/cors.ts).
 *
 * The production API answered every request from a website missing from
 * CORS_ORIGINS — preflights included — with a 500 "Something went wrong",
 * because the rejected origin reached the error handler as an unhandled
 * Error. Now:
 *   - an allowed origin gets credentialed CORS (preflight 204 + headers);
 *   - a disallowed origin gets a clean 403 with no CORS headers and no
 *     internal detail, before the request does any work;
 *   - no Origin (the native app, curl) is untouched;
 *   - the public legal pages stay readable from any website, without
 *     credentials;
 *   - the allow-list is exact and normalised; wildcards are never honoured.
 */

import { describe, expect, it } from 'vitest';
import { corsOrigins } from '../../src/config/env';
import { isAllowedOrigin, normalizeOrigin, parseCorsOrigins } from '../../src/config/cors';
import { api, expectError } from '../helpers/api';

const ALLOWED = corsOrigins[0]!; // http://localhost:5173 in .env.test
const OTHER = 'https://not-allowed.example';

describe('allowed origins', () => {
  it('a preflight from an allowed origin succeeds with credentialed CORS', async () => {
    const res = await api()
      .options('/api/v1/auth/send-otp')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('an allowed origin matches however it is capitalised', async () => {
    const res = await api().get('/api/v1/config/public').set('Origin', ALLOWED.toUpperCase().replace('HTTP', 'http'));
    expect(res.status).toBe(200);
  });
});

describe('disallowed origins', () => {
  it('get a clean 403 — not a 500 — with no CORS headers and no internal detail', async () => {
    const preflight = await api()
      .options('/api/v1/auth/send-otp')
      .set('Origin', OTHER)
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const post = await api().post('/api/v1/auth/send-otp').set('Origin', OTHER).send({ mobile: '9400000901' });
    expect(post.status).toBe(403);
    const error = expectError(post.body);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Requests from this website are not allowed.');
    expect(JSON.stringify(post.body)).not.toMatch(/stack|Origin not allowed/);
  });

  it('the literal "null" origin is never allowed', async () => {
    expect((await api().get('/api/v1/config/public').set('Origin', 'null')).status).toBe(403);
  });
});

describe('requests without an Origin (the mobile app)', () => {
  it('are unaffected', async () => {
    const res = await api().get('/api/v1/config/public');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('public legal pages', () => {
  it('stay readable from any website, without credentials', async () => {
    const res = await api().get('/api/v1/legal/terms').set('Origin', OTHER);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('but a write to them from another website is still refused', async () => {
    expect((await api().post('/api/v1/legal/terms').set('Origin', OTHER).send({})).status).toBe(403);
  });
});

describe('CORS_ORIGINS parsing', () => {
  it('normalises exact origins and ignores anything else (never a wildcard)', () => {
    expect(parseCorsOrigins(' https://Adione.in/ ,https://www.adione.in,,http://localhost:5173 ')).toEqual({
      origins: ['https://adione.in', 'https://www.adione.in', 'http://localhost:5173'],
      invalid: [],
    });
    expect(parseCorsOrigins('*,https://*.adione.in,https://adione.in/path,ftp://adione.in,adione.in').origins).toEqual([]);
    expect(normalizeOrigin('https://adione.in?x=1')).toBeNull();
    expect(isAllowedOrigin('https://ADIONE.in', ['https://adione.in'])).toBe(true);
    expect(isAllowedOrigin('https://adione.in.evil.example', ['https://adione.in'])).toBe(false);
    expect(isAllowedOrigin(undefined, ['https://adione.in'])).toBe(false);
  });
});
