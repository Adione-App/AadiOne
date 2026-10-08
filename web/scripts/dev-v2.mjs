#!/usr/bin/env node
/**
 * Runs the admin panel against the LOCAL V2 backend — what `npm run dev` (and
 * its alias `npm run dev:v2`) runs.
 *
 * Why this exists: `web/.env` sets VITE_API_URL / VITE_SOCKET_URL to the
 * production API (https://api.adione.in) for production builds — which until
 * the V1-to-V2 cutover is still the V1 API. A bare Vite dev server would point
 * the V2 panel at it, where V2-only routes don't exist and V2 orders never
 * appear. Vite gives variables already present in the process environment
 * priority over .env files, so this sets them on the spawned Vite process
 * instead of editing .env. `npm run dev:prod-api` is the explicit opt-in to
 * the .env API.
 *
 * The V2 backend must list this origin (http://localhost:5173) in its
 * CORS_ORIGINS for both the REST API and the socket.
 *
 * Usage:
 *   npm run dev:v2 [-- <extra vite args>]
 *   V2_API_ORIGIN=http://192.168.1.5:4100 npm run dev:v2   (another host)
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = (process.env["V2_API_ORIGIN"] ?? "http://localhost:4100").replace(/\/+$/, "");

process.env["VITE_API_URL"] = `${origin}/api/v1`;
process.env["VITE_SOCKET_URL"] = origin;

console.log(`[dev:v2] API ${process.env["VITE_API_URL"]}  socket ${process.env["VITE_SOCKET_URL"]}`);

// `vite/bin/vite.js` is not in Vite's package "exports"; its package.json is.
const viteBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const child = spawnSync(process.execPath, [viteBin, ...process.argv.slice(2)], {
  cwd: webRoot,
  stdio: "inherit",
  env: process.env,
});

if (child.error) {
  console.error(`\n[dev:v2] Failed to start Vite: ${child.error.message}\n`);
  process.exit(1);
}
process.exit(child.status ?? 1);
