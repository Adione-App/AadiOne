/**
 * App restart, background/foreground and reconnect with the REAL React Query
 * cache and disk persistence (query-core + query-persist-client-core, the
 * same libraries App.tsx's PersistQueryClientProvider runs) — no React
 * Native, no mocks of the cache.
 *
 * The restart gap this guards: a restored entry keeps its old fetch time, so
 * within its staleTime (categories 10 min) a cold start trusted it and did
 * not ask again — a category deleted meanwhile came back until then. App.tsx
 * now runs the catalogue revalidation right after the restore.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { persistQueryClientRestore, persistQueryClientSave, type PersistedClient, type Persister } from "@tanstack/query-persist-client-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalogRevalidator } from "../src/lib/catalogSync.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The query keys as queries.ts / homeLayoutQuery.ts build them. */
const CATEGORIES_KEY = ["categories", "v-test"] as const;
const LAYOUT_KEY = ["content", "home-layout"] as const;
const TEN_MIN = 10 * 60_000;

/** AsyncStorage stand-in: the persister's whole contract. */
function memoryPersister(): Persister & { saved: () => PersistedClient | undefined } {
  let stored: string | undefined;
  return {
    persistClient: async (client) => void (stored = JSON.stringify(client)),
    restoreClient: async () => (stored ? (JSON.parse(stored) as PersistedClient) : undefined),
    removeClient: async () => void (stored = undefined),
    saved: () => (stored ? (JSON.parse(stored) as PersistedClient) : undefined),
  };
}

/** The "server": what GET /categories answers right now. */
function server(initial: string[]) {
  let names = initial;
  let calls = 0;
  return {
    set: (next: string[]) => void (names = next),
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      return names.map((name) => ({ name }));
    },
  };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
const catalogRevalidator = (client: QueryClient) =>
  createCatalogRevalidator((queryKey) => void client.invalidateQueries({ queryKey: [...queryKey] }));

/** A screen mounting (useQuery = a QueryObserver): resolves with the data once it settles. */
async function mount(client: QueryClient, api: ReturnType<typeof server>) {
  const observer = new QueryObserver(client, { queryKey: CATEGORIES_KEY, queryFn: api.fetch, staleTime: TEN_MIN });
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await client.getQueryCache().find({ queryKey: CATEGORIES_KEY })?.promise?.catch(() => undefined);
  const names = (observer.getCurrentResult().data as { name: string }[] | undefined)?.map((c) => c.name);
  return { names, observer, unsubscribe };
}

const restoreOptions = (client: QueryClient, persister: Persister) => ({ queryClient: client, persister, maxAge: 7 * 24 * 60 * 60_000, buster: "v4" });

describe("app restart: a deleted category never comes back from the saved cache", () => {
  async function previousSession(api: ReturnType<typeof server>) {
    const persister = memoryPersister();
    const before = newClient();
    const first = await mount(before, api);
    assert.deepEqual(first.names, ["Grocery", "Tea & Coffee"]);
    first.unsubscribe();
    await persistQueryClientSave({ queryClient: before, persister, buster: "v4" });
    return persister;
  }

  it("the gap, reproduced: restored within staleTime and NOT revalidated, the deleted category stays and nothing is asked", async () => {
    const api = server(["Grocery", "Tea & Coffee"]);
    const persister = await previousSession(api);
    api.set(["Grocery"]); // Tea & Coffee deleted while the app was closed
    const after = newClient();
    await persistQueryClientRestore(restoreOptions(after, persister));
    const screen = await mount(after, api);
    assert.deepEqual(screen.names, ["Grocery", "Tea & Coffee"]);
    assert.equal(api.calls(), 1);
    screen.unsubscribe();
  });

  it("the fix: revalidated right after the restore (App.tsx onSuccess), the screen shows the saved copy and asks again — Tea & Coffee is gone", async () => {
    const api = server(["Grocery", "Tea & Coffee"]);
    const persister = await previousSession(api);
    api.set(["Grocery"]);
    const after = newClient();
    await persistQueryClientRestore(restoreOptions(after, persister));
    catalogRevalidator(after)(); // PersistQueryClientProvider onSuccess
    const screen = await mount(after, api);
    assert.equal(api.calls(), 2);
    assert.deepEqual(screen.names, ["Grocery"]);
    screen.unsubscribe();
  });

  it("an older saved snapshot never overwrites a newer answer already in memory", async () => {
    const api = server(["Grocery", "Tea & Coffee"]);
    const persister = await previousSession(api);
    api.set(["Grocery"]);
    const client = newClient();
    const fresh = await mount(client, api);
    assert.deepEqual(fresh.names, ["Grocery"]);
    await persistQueryClientRestore(restoreOptions(client, persister)); // the old snapshot arrives late
    assert.deepEqual((client.getQueryData(CATEGORIES_KEY) as { name: string }[]).map((c) => c.name), ["Grocery"]);
    fresh.unsubscribe();
  });

  it("App.tsx wires the revalidation to the restore", () => {
    const app = readFileSync(path.join(ROOT, "App.tsx"), "utf8");
    assert.match(app, /onSuccess=\{revalidateCatalog\}/);
  });
});

describe("while the app runs: the realtime event / foreground / reconnect refetch what is on screen", () => {
  it("a mounted screen gets the new answer at once; a screen not on screen is refreshed when it is next shown", async () => {
    const api = server(["Grocery", "Tea & Coffee", "Fashion"]);
    const client = newClient();
    const categoriesTab = await mount(client, api);
    assert.deepEqual(categoriesTab.names, ["Grocery", "Tea & Coffee", "Fashion"]);
    // A layout query cached but not on screen.
    client.setQueryData(LAYOUT_KEY, { revision: 1 });

    // Admin: hide Tea & Coffee and reorder (Fashion first). The signal arrives (socket, resume or reconnect).
    api.set(["Fashion", "Grocery"]);
    catalogRevalidator(client)();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.getQueryCache().find({ queryKey: CATEGORIES_KEY })?.promise;
    assert.deepEqual((categoriesTab.observer.getCurrentResult().data as { name: string }[]).map((c) => c.name), ["Fashion", "Grocery"]);
    // Not on screen: marked stale, so its next mount asks again.
    assert.equal(client.getQueryCache().find({ queryKey: LAYOUT_KEY })?.isStale(), true);

    // A new category is added: shown after the next signal.
    api.set(["Fashion", "Grocery", "Ice Cream"]);
    await new Promise((resolve) => setTimeout(resolve, 2_100)); // past the 2 s throttle
    catalogRevalidator(client)();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.getQueryCache().find({ queryKey: CATEGORIES_KEY })?.promise;
    assert.deepEqual((categoriesTab.observer.getCurrentResult().data as { name: string }[]).map((c) => c.name), ["Fashion", "Grocery", "Ice Cream"]);
    categoriesTab.unsubscribe();
  });

  it("guests (no socket): the resume handler and tab focus are the triggers — focus only re-asks for data older than a minute", async () => {
    const app = readFileSync(path.join(ROOT, "App.tsx"), "utf8");
    // Resume runs for everyone, logged in or not.
    assert.match(app, /AppState\.addEventListener\("change", \(next\) => \{\s*if \(next !== "active"\) return;[\s\S]*?revalidateCatalog\(\);/);
    const focus = readFileSync(path.join(ROOT, "src/lib/useRefreshOnFocus.ts"), "utf8");
    assert.match(focus, /else if \(Date\.now\(\) - latest\.current\.dataUpdatedAt >= minAgeMs\) refresh\(\);/);
  });
});
