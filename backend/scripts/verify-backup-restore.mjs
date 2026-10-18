#!/usr/bin/env node
/**
 * Restore drill for a pg_dump (custom format) — proves a backup actually
 * restores, without touching the database it came from.
 *
 *   node scripts/verify-backup-restore.mjs --backup <file.dump> \
 *     --restore-server postgresql://postgres@localhost:55432/postgres
 *
 * 1. reads the dump's header (source database, creation time);
 * 2. creates a throwaway database on the given LOCAL server (any other host is
 *    refused — a restore never goes near production);
 * 3. restores the application schema (`public`) into it;
 * 4. counts the key tables, so they can be compared with the dry-run report;
 * 5. drops the throwaway database.
 *
 * PostgreSQL client tools (pg_restore, psql) come from PATH, or from PG_BIN.
 * Prints counts and names only — never a connection string or a credential.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const backup = arg("backup");
const server = arg("restore-server");
if (!backup || !server) {
  console.error("usage: node scripts/verify-backup-restore.mjs --backup <file.dump> --restore-server <local postgres url>");
  process.exit(2);
}
if (!existsSync(backup) || statSync(backup).size === 0) {
  console.error(`backup ${backup} does not exist or is empty`);
  process.exit(2);
}

const serverUrl = new URL(server);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(serverUrl.hostname)) {
  console.error(`REFUSING: the restore server must be local (got host ${serverUrl.hostname}).`);
  process.exit(2);
}

const bin = (tool) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, tool) : tool);
const run = (tool, args) => spawnSync(bin(tool), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const urlFor = (database) => {
  const url = new URL(server);
  url.pathname = `/${database}`;
  return url.toString();
};
const psql = (database, sql) => {
  const result = run("psql", ["-v", "ON_ERROR_STOP=1", "-At", "-d", urlFor(database), "-c", sql]);
  if (result.error || result.status !== 0) throw new Error(`psql failed: ${(result.error?.message ?? result.stderr).split("\n")[0]}`);
  return result.stdout.trim();
};

const listed = run("pg_restore", ["--list", backup]);
if (listed.error || listed.status !== 0) {
  console.error(`pg_restore --list could not read ${backup}`);
  process.exit(1);
}
const source = listed.stdout.match(/^;\s*dbname:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
const created = listed.stdout.match(/^;\s*Archive created at (.+)$/m)?.[1]?.trim() ?? "unknown";
const maintenance = serverUrl.pathname.replace(/^\//, "") || "postgres";
const scratch = `aadione_restore_check_${Date.now()}`;

let ok = false;
try {
  psql(maintenance, `CREATE DATABASE ${scratch}`);
  psql(scratch, "CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const restored = run("pg_restore", ["--no-owner", "--no-privileges", "--schema=public", "--dbname", urlFor(scratch), backup]);
  const errors = (restored.stderr.match(/^pg_restore: error:/gm) ?? []).length;
  const tables = ["sellers", "products", "seller_listings", "categories", "orders", "seller_orders", "payments", "refunds", "seller_settlements", "payment_events", "audit_logs", "users"];
  const counts = Object.fromEntries(tables.map((table) => [table, Number(psql(scratch, `SELECT count(*) FROM public.${table}`))]));
  console.log(`backup: ${backup}`);
  console.log(`  source database: ${source}; created: ${created}; size ${statSync(backup).size} bytes`);
  console.log(`  restored into a throwaway local database: ${errors === 0 ? "no errors" : `${errors} pg_restore error(s) — review below`}`);
  for (const [table, count] of Object.entries(counts)) console.log(`  ${table}: ${count}`);
  if (errors > 0) console.log(restored.stderr.split("\n").filter((line) => line.includes("error")).slice(0, 10).join("\n"));
  ok = errors === 0 && counts.sellers > 0;
  console.log(ok ? "RESTORE CHECK OK" : "RESTORE CHECK FAILED");
} catch (error) {
  console.error(`restore check failed: ${error instanceof Error ? error.message : error}`);
} finally {
  try {
    psql(maintenance, `DROP DATABASE IF EXISTS ${scratch}`);
  } catch {
    console.error(`could not drop the throwaway database ${scratch} — drop it by hand`);
  }
}
process.exit(ok ? 0 : 1);
