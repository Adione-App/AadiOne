#!/usr/bin/env node
/**
 * Runs a command with variables from a named env file injected into its
 * environment — the mechanism behind every `*:v2` npm script.
 *
 * Why this exists instead of `ENV_FILE=.env.v2 <command>` directly in
 * package.json: that shell syntax only works in POSIX shells. This project is
 * developed on Windows/PowerShell, where it's a syntax error. Spawning the
 * child from Node instead means the exact same npm script works in
 * PowerShell, cmd, and bash without any shell-specific env-var prefix.
 *
 * Usage:
 *   node scripts/with-env.mjs [--no-payments] [--transaction-pooler] <envFile> <command> [args...]
 *
 * --no-payments: for maintenance scripts that never take or refund money —
 * the command runs with no payment settings at all (see below).
 *
 * --transaction-pooler: for maintenance scripts run against production while
 * the API is live. The env file's Supabase SESSION pooler (port 5432) allows
 * only 15 clients and the running API fills it (EMAXCONNSESSION); this sends
 * the command through the TRANSACTION pooler instead (port 6543,
 * pgbouncer=true, one connection). Only a `*.pooler.supabase.com:5432` URL is
 * accepted. src/config/env.ts re-reads ENV_FILE with override, so the changed
 * URL is handed over as a private temporary copy of the env file, deleted when
 * the command ends.
 *
 * Example (what `db:migrate:v2` runs under the hood):
 *   node scripts/with-env.mjs .env.v2 prisma migrate dev
 *
 * Deliberately does NOT read `backend/.env` at all, for comparison or
 * otherwise — this script only ever knows about the one file it was told to
 * load, so there is no code path where it could leak a V1 value.
 */

import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// `--no-payments` (before the env file): the command gets NO payment settings
// at all — no gateway credentials, no provider, no Cashfree environment. For
// maintenance scripts that never take or refund money (seller cleanup, stock
// backfill, diagnostics): they then run under the env file's own NODE_ENV
// without needing live keys, and src/infra/payment refuses to start a
// provider in such a process.
const cliArgs = process.argv.slice(2);
const flags = new Set();
while (cliArgs[0] === "--no-payments" || cliArgs[0] === "--transaction-pooler") flags.add(cliArgs.shift());
const noPayments = flags.has("--no-payments");
const transactionPooler = flags.has("--transaction-pooler");

const [envFileArg, command, ...commandArgs] = cliArgs;

if (!envFileArg || !command) {
  console.error(
    "Usage: node scripts/with-env.mjs [--no-payments] [--transaction-pooler] <envFile> <command> [args...]",
  );
  process.exit(1);
}

const envFilePath = path.isAbsolute(envFileArg)
  ? envFileArg
  : path.resolve(backendRoot, envFileArg);

if (!existsSync(envFilePath)) {
  console.error(
    `\n[with-env] "${envFileArg}" was not found at ${envFilePath}.\n` +
      `Create it before running this command.\n`,
  );
  process.exit(1);
}

const result = config({ path: envFilePath, override: true });

if (result.error) {
  console.error(
    `\n[with-env] Failed to parse "${envFileArg}": ${result.error.message}\n`,
  );
  process.exit(1);
}

if (!process.env["DATABASE_URL"] || !process.env["DATABASE_URL"].trim()) {
  console.error(
    `\n[with-env] DATABASE_URL is missing or empty in "${envFileArg}".\n` +
      `Set it before running this command.\n`,
  );
  process.exit(1);
}

// Downstream code (src/config/env.ts, prisma/seed/index.ts) checks this to
// know it must load ONLY this file — never falling back to backend/.env.
process.env["ENV_FILE"] = envFileArg;

let tempEnvDir = null;
if (transactionPooler) {
  let url;
  try {
    url = new URL(process.env["DATABASE_URL"]);
  } catch {
    console.error(`\n[with-env] --transaction-pooler: DATABASE_URL in "${envFileArg}" is not a valid URL.\n`);
    process.exit(1);
  }
  if (!url.hostname.endsWith(".pooler.supabase.com") || url.port !== "5432") {
    console.error(
      `\n[with-env] --transaction-pooler expects a Supabase session-pooler URL (*.pooler.supabase.com:5432); ` +
        `"${envFileArg}" has ${url.hostname}:${url.port || "(default)"}.\n`,
    );
    process.exit(1);
  }
  url.port = "6543";
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  process.env["DATABASE_URL"] = url.toString();

  // The same file with only DATABASE_URL replaced, readable by this user only.
  tempEnvDir = mkdtempSync(path.join(os.tmpdir(), "adione-env-"));
  const tempEnvFile = path.join(tempEnvDir, path.basename(envFilePath));
  const lines = readFileSync(envFilePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(export\s+)?DATABASE_URL\s*=/.test(line));
  lines.push(`DATABASE_URL="${process.env["DATABASE_URL"]}"`);
  writeFileSync(tempEnvFile, lines.join("\n"), { mode: 0o600 });
  process.env["ENV_FILE"] = tempEnvFile;
  console.error(`[with-env] --transaction-pooler: ${url.hostname}:6543 (pgbouncer, 1 connection)`);
}

// src/config/env.ts re-reads ENV_FILE itself, so the payment settings are
// withheld THERE, after that load (withholdPaymentSettings).
if (noPayments) {
  process.env["ADIONE_PAYMENTS_DISABLED"] = "1";
  console.error("[with-env] --no-payments: payment settings are withheld from this command");
}

let child;
try {
  child = spawnSync(command, commandArgs, {
    cwd: backendRoot,
    stdio: "inherit",
    // Required on Windows to resolve .cmd shims (npx/prisma installed via
    // npm); harmless on POSIX shells.
    shell: process.platform === "win32",
    env: process.env,
  });
} finally {
  if (tempEnvDir) rmSync(tempEnvDir, { recursive: true, force: true });
}

if (child.error) {
  console.error(`\n[with-env] Failed to start "${command}": ${child.error.message}\n`);
  process.exit(1);
}

process.exit(child.status ?? 1);
