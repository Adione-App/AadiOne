/**
 * The mock payment gateway outside the test suite (audit 2026-10-15).
 *
 * Its signing secret is in the source and its webhooks are unsigned, so on
 * any deployed environment anyone could forge a paid order. Two guards:
 *   - the env validator refuses PAYMENT_PROVIDER=mock unless NODE_ENV is
 *     development or test (staging included);
 *   - even in development, a mock webhook is never believed — only the test
 *     suite (NODE_ENV=test) accepts them.
 *
 * Each case runs a fresh child process: the env module validates once, at
 * import. The child loads ONLY a temporary copy of `.env.test` (test values,
 * never real credentials) through ENV_FILE, so no developer or production
 * `.env` is ever read.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const BACKEND = path.resolve(__dirname, '../..');
const TSX = path.join(BACKEND, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adione-env-guard-'));

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** `.env.test` with these keys replaced, written to a temp file. */
function envFile(overrides: Record<string, string>): string {
  const base = fs
    .readFileSync(path.join(BACKEND, '.env.test'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !Object.keys(overrides).some((key) => line.startsWith(`${key}=`)));
  const file = path.join(tmpDir, `env-${Object.values(overrides).join('-')}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, [...base, ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`)].join('\n'));
  return file;
}

/** Runs `code` (an ES module body) under the given environment. */
function run(overrides: Record<string, string>, code: string) {
  const script = path.join(tmpDir, `probe-${Math.random().toString(36).slice(2)}.mts`);
  fs.writeFileSync(script, code);
  const { NODE_ENV: _drop, ...parentEnv } = process.env;
  return spawnSync(TSX, [script], {
    cwd: BACKEND,
    env: { ...parentEnv, ENV_FILE: envFile(overrides), ...overrides },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
}

const importEnv = `await import(${JSON.stringify(pathToFileURL(path.join(BACKEND, 'src/config/env.ts')).href)}); console.log('ENV_OK');`;

describe('mock payment provider outside tests', () => {
  it('is refused on a staging deployment', () => {
    const result = run({ NODE_ENV: 'staging', PAYMENT_PROVIDER: 'mock' }, importEnv);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the mock payment provider accepts forged payments');
    expect(result.stdout).not.toContain('ENV_OK');
  }, 70_000);

  it('still starts for local development (control)', () => {
    const result = run({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'mock' }, importEnv);
    expect(result.stderr).not.toContain('accepts forged payments');
    expect(result.stdout).toContain('ENV_OK');
  }, 70_000);

  it('never believes a mock webhook outside the test suite — even in development', () => {
    const result = run(
      { NODE_ENV: 'development', PAYMENT_PROVIDER: 'mock' },
      `const { MockPaymentProvider } = await import(${JSON.stringify(pathToFileURL(path.join(BACKEND, 'src/infra/payment/index.ts')).href)});
       const event = new MockPaymentProvider().parseWebhook(Buffer.from(JSON.stringify({
         type: 'payment.captured', provider_order_id: 'mock_order_x', provider_payment_id: 'mock_pay_x', amount_paise: 100,
       })));
       console.log('SIGNATURE_VALID=' + event.signatureValid);`,
    );
    expect(result.stdout).toContain('SIGNATURE_VALID=false');
  }, 70_000);
});

/*
 * Maintenance scripts (`with-env.mjs --no-payments`): an env file holding LIVE
 * Cashfree keys with NODE_ENV=development is refused as before, unless the
 * process is a payments-free maintenance run — which then holds no payment
 * setting at all and cannot start a payment provider. Fake values only.
 */
const LIVE_KEYS_ON_A_DEV_BOX = {
  NODE_ENV: 'development',
  PAYMENT_PROVIDER: 'cashfree',
  CASHFREE_APP_ID: 'fake-live-app-id',
  CASHFREE_SECRET_KEY: 'fake-live-secret',
  CASHFREE_ENV: 'production',
};

describe('maintenance scripts without payments', () => {
  it('live Cashfree keys with NODE_ENV=development are still refused for every other process', () => {
    const result = run(LIVE_KEYS_ON_A_DEV_BOX, importEnv);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('live Cashfree credentials are only allowed with NODE_ENV=production');
    expect(result.stdout).not.toContain('ENV_OK');
  }, 70_000);

  it('--no-payments: starts with no payment setting in the process, NODE_ENV unchanged, and no payment provider', () => {
    const result = run(
      { ...LIVE_KEYS_ON_A_DEV_BOX, ADIONE_PAYMENTS_DISABLED: '1' },
      `const { env } = await import(${JSON.stringify(pathToFileURL(path.join(BACKEND, 'src/config/env.ts')).href)});
       console.log('NODE_ENV=' + env.NODE_ENV);
       console.log('PAYMENT_VARS=' + Object.keys(process.env).filter((k) => /^(CASHFREE_|RAZORPAY_|PAYMENT_PROVIDER)/.test(k)).length);
       try {
         await import(${JSON.stringify(pathToFileURL(path.join(BACKEND, 'src/infra/payment/index.ts')).href)});
         console.log('PAYMENTS_LOADED');
       } catch (error) {
         console.log('PAYMENTS_REFUSED ' + error.message);
       }`,
    );
    expect(result.stdout).toContain('NODE_ENV=development');
    expect(result.stdout).toContain('PAYMENT_VARS=0');
    expect(result.stdout).toContain('PAYMENTS_REFUSED payments are disabled in this process');
    expect(result.stdout).not.toContain('PAYMENTS_LOADED');
    expect(result.stdout + result.stderr).not.toContain('fake-live-secret');
  }, 70_000);
});
