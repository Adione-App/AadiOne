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
 *   node scripts/with-env.mjs <envFile> <command> [args...]
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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const [envFileArg, command, ...commandArgs] = process.argv.slice(2);

if (!envFileArg || !command) {
  console.error(
    "Usage: node scripts/with-env.mjs <envFile> <command> [args...]",
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

const child = spawnSync(command, commandArgs, {
  cwd: backendRoot,
  stdio: "inherit",
  // Required on Windows to resolve .cmd shims (npx/prisma installed via
  // npm); harmless on POSIX shells.
  shell: process.platform === "win32",
  env: process.env,
});

if (child.error) {
  console.error(`\n[with-env] Failed to start "${command}": ${child.error.message}\n`);
  process.exit(1);
}

process.exit(child.status ?? 1);
