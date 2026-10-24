/**
 * Lets `npm run test:unit` (Node's own test runner, type stripping) load the
 * app's pure TypeScript modules the way Metro does:
 *
 *   "@shared", "@shared/x"   → src/shared/index.ts, src/shared/x.ts
 *   "@/x"                     → src/x.ts
 *   "./x" without extension   → ./x.ts (or .tsx, or ./x/index.ts) when that file exists
 *
 * Only paths to files that exist are rewritten; everything else resolves as
 * usual. Loaded with `node --import ./tests/resolve-ts.mjs`.
 */

import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function asFile(target) {
  if (existsSync(target) && statSync(target).isFile()) return target;
  for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let target = null;
    if (specifier === "@shared") target = path.join(SRC, "shared", "index.ts");
    else if (specifier.startsWith("@shared/")) target = path.join(SRC, "shared", specifier.slice("@shared/".length));
    else if (specifier.startsWith("@/")) target = path.join(SRC, specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    const file = target ? asFile(target) : null;
    return file ? nextResolve(pathToFileURL(file).href, context) : nextResolve(specifier, context);
  },
});
