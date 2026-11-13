#!/usr/bin/env node
/**
 * Mirrors backend/src/shared into web/src/shared and mobile/src/shared.
 *
 * WHY THIS EXISTS
 * The three projects are intentionally independent folders with their own
 * package.json and node_modules — no npm workspaces, no symlinks, no build
 * ordering between them. That independence costs us the ability to `import`
 * a shared package, so the contract is copied instead.
 *
 * The copies carry a generated banner and are listed in each client's
 * .gitignore-adjacent conventions as "do not edit". Editing a copy is safe
 * only in the sense that the next sync silently overwrites it.
 *
 * Design tokens (theme.ts) go to both clients. Everything else is the domain
 * contract, which all three need.
 *
 * The public website (aadione-website/) gets ONLY info-pages.ts: it renders
 * the published Privacy Policy, Terms and About pages from the same API as
 * the app, with the same link and date rules (Vite compiles the .ts file).
 *
 * Usage:  npm run sync:shared        (from backend/)
 *         npm run sync:shared -- --check   (CI: fail if copies are stale)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const repoRoot = resolve(backendRoot, '..');

const SOURCE_DIR = join(backendRoot, 'src', 'shared');
const TARGETS = [
  { dir: join(repoRoot, 'web', 'src', 'shared'), only: null },
  { dir: join(repoRoot, 'mobile', 'src', 'shared'), only: null },
  { dir: join(repoRoot, 'aadione-website', 'src', 'shared'), only: ['info-pages.ts', 'branding.ts'] },
];

const BANNER = `/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by \`npm run sync:shared\`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

`;

const checkOnly = process.argv.includes('--check');

if (!existsSync(SOURCE_DIR)) {
  console.error(`[sync-shared] source folder missing: ${SOURCE_DIR}`);
  process.exit(1);
}

const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.ts'));
if (files.length === 0) {
  console.error('[sync-shared] no .ts files found to sync');
  process.exit(1);
}

let stale = 0;
let written = 0;

for (const { dir: targetDir, only } of TARGETS) {
  // A client folder that does not exist yet (mobile before Phase 14) is skipped
  // rather than treated as an error.
  const clientRoot = resolve(targetDir, '..', '..');
  if (!existsSync(clientRoot)) {
    console.log(`[sync-shared] skipped (project not created yet): ${clientRoot}`);
    continue;
  }

  mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    if (only && !only.includes(file)) continue;
    const contents = BANNER + readFileSync(join(SOURCE_DIR, file), 'utf8');
    const destination = join(targetDir, file);
    const current = existsSync(destination) ? readFileSync(destination, 'utf8') : null;

    if (current === contents) continue;

    if (checkOnly) {
      console.error(`[sync-shared] STALE: ${destination}`);
      stale += 1;
    } else {
      writeFileSync(destination, contents, 'utf8');
      written += 1;
    }
  }
}

if (checkOnly) {
  if (stale > 0) {
    console.error(
      `\n[sync-shared] ${stale} file(s) out of date. Run \`npm run sync:shared\` in backend/.`,
    );
    process.exit(1);
  }
  console.log('[sync-shared] all copies up to date.');
} else {
  console.log(
    `[sync-shared] synced ${files.length} file(s) to ${TARGETS.length} target(s); ${written} updated.`,
  );
}
