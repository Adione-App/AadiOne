# Aadione Smart Search V1

One search engine for the customer app, the Seller Panel and the Admin Panel. It is multilingual (English, Hindi, Hinglish), tolerates typos and ranks results by relevance. It runs only on PostgreSQL. There is no external search service and no translation API call per request.

> **Status:** implemented on the working tree of `main`. Nothing is committed, pushed or deployed. The migration is applied **only** to the local test database (`localhost:55432/adione_test`). See [Production release](#production-release).

---

## 1. Architecture

```
                        backend/src/shared/  (copied to web/ and mobile/)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ search-text.ts        normalise · Hindi→Roman transliteration ·      │
  │                       Hinglish phonetic key · edit distance          │
  │ search-dictionary.ts  English / Hinglish / Hindi synonym groups      │
  │ search-match.ts       term generation · query analysis · tiers ·     │
  │                       smartSearch() for in-memory lists              │
  └──────────────┬───────────────────────────────┬───────────────────────┘
                 │ same rules                    │ same rules
   ┌─────────────▼──────────────┐   ┌────────────▼──────────────────────┐
   │ backend/src/infra/search    │   │ web + mobile (lists already held) │
   │  indexer.ts  → product_     │   │  seller Products / Inventory,      │
   │              search_terms   │   │  admin seller listings, category   │
   │  engine.ts   ranked SQL     │   │  pickers, app Categories, Food,    │
   │  backfill.ts all products   │   │  suggestion chips                  │
   └─────────────┬──────────────┘   └───────────────────────────────────┘
                 │ where-predicate decides visibility
   ┌─────────────▼──────────────────────────────────────────────────────┐
   │ catalog/product-search-scope.ts                                     │
   │  marketplace (customer) · food (customer) · sellerOwn · admin       │
   └────────────────────────────────────────────────────────────────────┘
```

* **One rule set, two executions.**
  * **SQL** over the indexed `product_search_terms` table, for catalogue-sized lists. `engine.ts` turns the query into "probes" (`analyzeSearchQuery`) and matches them with the same tier rules as `matchTier`.
  * **In memory** (`smartSearch` / `createSmartMatcher`), for lists a screen already holds in full.

  Both call `buildSearchTerms`, so a word matches in both or in neither.
* **The engine ranks; callers decide visibility.** Every engine call must pass a `where` predicate over `products p`. The predicates in `product-search-scope.ts` restate the existing browse rules, so search can never show more than browsing does.
* **Every query value is a bound parameter** (`Prisma.sql`). LIKE patterns are escaped even though normalised text cannot contain wildcards.

## 2. Search inventory

| # | Panel | Screen / API | Before | Now |
|---|---|---|---|---|
| 1 | Customer app | Search screen → `GET /products/search` | full-text + trigram on the English name, a small alias list | **Engine** (marketplace scope); keyset cursor on (rank, id) |
| 2 | Customer app | Search suggestion chips (`lib/searchSuggestions.ts`) | its own 23-word list | **Shared dictionary** + phonetic prefix |
| 3 | Customer app | Categories screen search (`categorySections.searchCategories`) | `includes()` on name / Hindi name | **smartSearch** (name, Hindi, parent) |
| 4 | Customer app | Food tab restaurant search | `includes()` on name / cuisine | **smartSearch** at once, plus a debounced `GET /restaurants/search` (name, cuisine, **dishes**, food scope) |
| 5 | Seller Panel | Products page | `includes()` on name / category | **smartSearch** (name, Hindi name, category); relevance order unless a sort is chosen |
| 6 | Seller Panel | Inventory page | `includes()` | **smartSearch**, then the existing urgency order |
| 7 | Seller Panel | Orders → `GET /seller/orders?q=` | order number `contains` | **order-search.ts**: order number (separators ignored), phone, customer name (typos), **this seller's own lines** via the engine |
| 8 | Admin | Products → `GET /admin/marketplace/products?q=` | name `contains` | **Engine** (admin scope + seller filter); relevance order while searching |
| 9 | Admin | Inventory → `GET /admin/marketplace/inventory?q=` | name `contains` | **Engine**; relevance, then urgency |
| 10 | Admin | Categories (catalogue explorer) `?q=` | `includes()` | **Engine** for products + smart matcher for category / seller names |
| 11 | Admin | Home builder product picker (`listProductOptions`) | ILIKE name / Hindi / brand | **Engine** narrows; the picker keeps its name-order keyset pagination |
| 12 | Admin | Home shelf / Category display category pickers | `includes()` | **smartSearch** (+ plain path match) |
| 13 | Admin | Seller detail → listings & products tab | `includes()` | **Smart matcher** on name / Hindi name; plain text on variant / SKU / category |
| 14 | Admin | Seller detail → orders tab | order number | same as #7 (seller scope) |
| 15 | Admin | Orders → `GET /admin/orders?search=` | number / phone / name `contains`, request per keystroke | **order-search.ts** (all orders) + 350 ms debounce, previous results kept within a tab |
| 16 | Admin | Customers → `GET /admin/customers?q=` | ILIKE name, LIKE digits | + mobile in any format (last 10 digits), typo-tolerant name (`word_similarity ≥ 0.5`) |
| 17 | Admin | Sellers → `GET /admin/sellers?search=` | name / code / city `contains` | + code without separators, typo-tolerant name |
| 18 | Admin | Banner editor target pickers | admin products / sellers APIs | inherit #8 and #17 |
| — | Admin | Payments, Refunds, Audit logs | IDs / order numbers | **unchanged on purpose.** These are identifier lookups (Cashfree ids, UTRs, entity ids); fuzzy or language matching there would only add false hits. |

Searched for and **not found** (no search UI exists, so nothing to integrate): restaurant menu screen, store page, rail "See all", seller menu manager, product approvals, settlements.

## 3. Supported languages and matching

| Input | Example → finds | How |
|---|---|---|
| English, any case | `Banana`, `banana` | normalised term |
| English typos | `banna`, `baanana`, `bananna`, `bananaa` | phonetic key (doubled letters collapse) or trigram similarity on the key |
| Hindi (Devanagari) | `केला`, `आलू`, `टमाटर` | the product's own Hindi text, its Roman transliteration, or the dictionary |
| Hinglish / Roman Hindi | `kela`, `keela`, `kelaa`, `kayla`, `aloo`, `alu`, `tamatar`, `pyaaj`, `doodh`, `dud`, `saib`, `chaal` | phonetic key (ee~i, oo~u, aa~a, ai/ay~e, aspirates, w~v, z~j, n~m before b/p) + dictionary |
| Split words | `tamat ar` → Tomato | whole-query compact key |
| Partial | `ban`, `tom`, `pot` | prefix (2+ letters); inside-a-word from 4 letters |
| Mixed / multi-word | `amul milk`, `kela chips` | per-word matching with coverage |
| Unicode variants | `प्याज़` with a separate nukta, zero-width characters, accents | NFKC/NFC + nukta handling |

**Normalisation** (`normalizeSearchText`): NFKD + combining-mark removal for Latin, NFC for Devanagari, lower case, zero-width characters removed, apostrophes dropped (`lady's`→`ladys`), all other punctuation turned into spaces, whitespace collapsed. Original names are never modified.

**Transliteration** (`devanagariToRoman`): consonants, vowel signs, conjuncts (virama), anusvara/chandrabindu, visarga and nukta forms. Schwa deletion uses a simplified Ohala rule: final schwa, plus medial schwa in a VC_CV context, so `नमकीन`→`namkeen` and `अदरक`→`adrak`. Roman→Hindi is **not** generated: both scripts reduce to the same Roman phonetic key, which is more reliable than guessing Devanagari from ambiguous Roman spellings.

**Translation ≠ transliteration.** `kela`→Banana works only because a dictionary group says so (§4).

## 4. Alias dictionary strategy

* `backend/src/shared/search-dictionary.ts`: about 190 groups, each one thing under every name (English, plural, Hinglish spellings, Hindi). It was seeded from the **real catalogue** (read from the local V2 backup dump): vegetables and fruits sold as "Banana (केला)", dals, masalas, namkeen, the restaurants' dishes (momos, paratha, roti, paneer…), clothing and kitchenware.
* One spelling per sound is enough, because matching uses the phonetic key.
* Rules that keep unrelated products out of results:
  * one meaning per group (no `sitaphal`);
  * no generic English words (`long`, `paste`);
  * no word that appears in another product's name (`lime` would make Sweet Lime match "nimbu").
* **Product-specific aliases** come from the existing **`Product.searchKeywords`** column. Indexed as `KEYWORD` terms, they behave as exact aliases of that product, and editing them requeues the product automatically (trigger). **No current management screen edits this column**: the seller form, admin approval and bulk import all create products with `[]`. Per the brief ("where the existing UI supports it"), no new field was added. Keywords can be set by script today; a "Search keywords" field on the seller/admin product form would be the next step.
* **New products need no manual spellings**: name words, the Hindi in brackets, transliteration, phonetic keys and dictionary groups are all generated.
* **When a dictionary group matches a product's *whole* name** (e.g. "Potato (आलू)" is aloo), the group is stored as `NAME_SYNONYM` (an alias of the product itself). So `aloo` ranks Potato above "Veg Aloo Tikki Burger".
* After editing the dictionary, run the backfill (§7) so existing products pick up the new groups. Queries use the new dictionary immediately.

## 5. Ranking

Every (query word, indexed term) match falls into a tier. A better tier always wins over any amount of a worse one:

| Tier | Meaning | Example |
|---|---|---|
| 8 | exact product name as typed | `Banana (केला)` |
| 7 | whole name, normalised (brackets/punctuation ignored) | `banana` → "Banana (केला)" |
| 6 | exact alias: a word of the name, bracketed Hindi, Hindi name, keyword, brand, whole-name synonym | `केला`, `aloo` → Potato |
| 5 | dictionary synonym | `kela` → "Banana Chips" |
| 4 | phonetic / transliteration (other spelling or script) | `kelaa`, `kayla` |
| 3 | prefix | `ban` |
| 2 | partial (inside a word) · category matches · not-yet-indexed products | `anan`, `fruits` |
| 1 | fuzzy typo (trigram on the phonetic key) and typos of dictionary words | `banna` |

* Within a tier: share of the query's words matched (+0…400), then field weight (name 100 … category 40, ×4), then similarity (×100), then popularity (< 0.01).
* Results are **deduplicated by product**. Pagination is keyset on (rank, id); before, the cursor used rank alone and skipped ties at page boundaries.
* **Short-query guards**:
  * 1 letter: only names starting with it.
  * Inside longer queries: words of 1 letter are dropped, and words under 3 letters get no prefix/partial matching.
  * Inside-a-word matching starts at 4 letters.
  * Typos need 4+ letters (similarity ≥ 0.5, or ≥ 0.42 from 7 letters).
  * Dictionary typo lookup allows 1 edit up to 8 letters ("chinese" no longer reaches "cheese").
  * Multi-word queries must match at least half their significant words, or the whole phrase.

## 6. Database changes

Migration **`backend/prisma/migrations/20261106120000_v2_smart_search/migration.sql`**. It is additive only, runs in one transaction with `lock_timeout = 5s`, and adds no extension (pg_trgm is already installed by `v2_product_search`; `unaccent` isn't needed because normalisation is done in the application).

| Object | Purpose |
|---|---|
| `product_search_terms(product_id, term, key, source, weight)` | the index. PK `(product_id, term)` makes duplicates impossible; FK → `products` **ON DELETE CASCADE**; CHECKs on `source` and non-blank `term`; **RLS enabled** and Data-API roles revoked, as in `v2_lock_down_supabase_data_api` |
| `product_search_terms_term_idx`, `_key_idx` (btree) | exact word / phonetic / synonym lookups |
| `product_search_terms_term_trgm_idx`, `_key_trgm_idx` (GIN `gin_trgm_ops`) | prefix, partial and typo matches |
| `products.search_index_stale boolean NOT NULL DEFAULT true` | the indexer's work queue. Constant default = metadata-only, no table rewrite |
| `products_search_index_stale_idx` (partial, `WHERE search_index_stale`) | the queue and the live-name fallback stay cheap |
| triggers `products_search_stale_insert/_update`, `categories_search_stale`, `brands_search_stale` | mark products stale **in the same transaction** as any change to name, Hindi name, keywords, brand, category or deletion, and when a product's category (or parent) or brand is renamed |

Prisma schema: new model `ProductSearchTerm`, `Product.searchIndexStale`, `Product.searchTerms`. `prisma validate` passes. Generated DDL matches `prisma migrate diff`. The partial index, CHECKs and triggers are hand-written, the same way as the earlier V2 migrations.

**Not** a second catalogue: the table holds only derived text keyed by product id. No product, category, seller or order data is copied, changed or deleted.

## 7. Backfill (existing products)

```bash
cd backend
npm run search:backfill:v2 -- --dry-run      # count + preview, writes nothing
npm run search:backfill:v2                   # rebuild every product's terms
npm run search:backfill:v2 -- --batch-size 100
```

* `search:backfill:v2` runs `assert-v2-database` and goes through the **transaction pooler** with no payment settings (`with-env --no-payments --transaction-pooler .env.v2`), like the other live-safe maintenance scripts. `npm run search:backfill` is the same against whatever `DATABASE_URL` the shell has.
* It processes keyset-ordered batches of 200 (configurable). It never loads the catalogue into memory and prints progress per batch.
* Each batch locks its product rows, replaces exactly their terms and clears `search_index_stale` in one transaction. It is **idempotent** (tested: a second run yields the same rows) and safe alongside the live API and the app's own indexer.
* A failed batch is reported (first id, size, error), the run continues, and the exit code is 1. Re-run it.
* Even without the backfill, the app indexes stale products by itself (§8). The backfill just makes it immediate and observable.

## 8. Automatic indexing of new and changed data

1. **DB triggers** set `search_index_stale = true` inside the writing transaction. No write path can skip this: API, bulk import, scripts, psql.
2. **While stale**, search ignores the product's old terms and matches its live name, Hindi name and keywords (a PARTIAL-band fallback):
   * a new product is searchable immediately;
   * a renamed one never matches its old name;
   * a deleted one never shows (visibility filters) and loses its terms on rebuild (FK cascade on hard delete).
3. **Rebuild**:
   * A Prisma middleware on Product/Category/Brand writes requests a debounced (400 ms) single-flight rebuild.
   * The `search-index` job sweeps the queue every 30 s (`FOR NO KEY UPDATE SKIP LOCKED`, safe with several instances). This also covers raw-SQL writes.
   * A first sweep runs 5 s after boot.
   * A failure is logged and retried by the sweep. Nothing can stay silently stale.
4. **Concurrency**: the indexer locks product rows (`FOR NO KEY UPDATE`, compatible with FK checks) **before** reading them, so it always indexes the latest committed text, and a later write re-marks the product stale. Tested with parallel rebuilds plus a rename.
5. **Not re-indexed on purpose**: status, approval, stock and seller changes. Visibility is evaluated live at query time, so they take effect immediately without touching the index.

Restaurant menu items are products, so they are covered by the same table and triggers. Categories, sellers, restaurants and customers are small tables searched live (shared matcher, or `word_similarity`), so they need no index rows.

## 9. API integrations

| API | Change |
|---|---|
| `GET /products/search` | engine; same response shape; cursor now (rank, id); tampered cursor → first page |
| `GET /restaurants/search?q=&diet=&type=` **(new, public)** | `[{ sellerId, rank, matchedItems[] }]` best first; live restaurants only |
| `GET /admin/marketplace/products`, `/inventory`, `/catalogue` | `q` uses the engine (admin scope + seller filter); permissions unchanged |
| `GET /admin/orders?search=`, `GET /seller/orders?q=`, admin seller orders | `order-search.ts`; seller scope unchanged, so a seller only finds its own orders and lines |
| `GET /admin/customers?q=`, `GET /admin/sellers?search=` | normalised phone / code, typo-tolerant names |
| Home builder product options | engine narrows the set |

No endpoint was removed and no response shape changed. Admin/seller authorisation middleware and RLS are untouched.

## 10. Frontend behaviour

* **Mobile Search** (unchanged, already correct): 350 ms debounce, request cancelled via `AbortSignal` when the term moves on, previous results kept (`keepPreviousData`), skeleton on first load, "No products found" empty state.
* **Food tab**: on-device matches show instantly. After 350 ms the server's dish-aware ranking replaces them. Placeholder (stale) data is never mixed in. Layout is unchanged.
* **Admin Orders**: now debounced (350 ms), previous results kept only within the same tab.
* Seller/admin lists that already hold all rows filter in memory with the shared matcher, so there's no request per keystroke. The term → terms work is cached per row object.
* Placeholders changed: admin Orders ("Search order number, phone, name or item…") and seller Orders ("Order number, phone, customer or item…"), because those boxes now find more. No layout changes.

## 11. Performance

_Measured on local PostgreSQL 18 (Windows, same machine as the API, no network). Production adds the Railway↔Supabase round trip on top. See `backend/tests/perf/smart-search-perf.test.ts`._

Benchmark: `PERF=1 [SEARCH_PERF_PRODUCTS=20000] npx vitest run tests/perf/smart-search-perf.test.ts`. It seeds a synthetic catalogue in the real naming style ("Bikaji Moong Dal 1 kg #12 (मूंग दाल)"): 40 base items × 12 brands × 8 sizes over 4 sellers, so ~22% of products share any one base word. That is far more overlap than the real catalogue (about 150 products). Timings are the median of 9 runs after a warm-up, measured in-process through supertest (`GET /products/search?limit=20`, including hydration and DTO mapping) and for the engine alone.

**Indexing:** ~21 terms per product; ~350 products/s (5,000 in 14 s; 20,000 in 57 s, 421k rows).

| Query | 5,000 products: HTTP median / p95 | engine | 20,000 products: HTTP median / p95 | engine |
|---|---|---|---|---|
| banana | 78 / 2332¹ | 38 | 178 / 330 | 134 |
| kela | 74 / 192 | 38 | 167 / 190 | 128 |
| केला | 80 / 128 | 43 | 162 / 171 | 128 |
| banna | 70 / 86 | 24 | 116 / 197 | 76 |
| aloo | 70 / 83 | 39 | 124 / 154 | 91 |
| आलू | 81 / 232 | 38 | 127 / 160 | 93 |
| tamat ar | 116 / 127 | 96 | 387 / 538 | 333 |
| pyaaj | 77 / 104 | 48 | 213 / 245 | 165 |
| doodh | 84 / 120 | 34 | 123 / 129 | 88 |
| ban | 78 / 149 | 35 | 117 / 134 | 84 |
| tom | 68 / 86 | 34 | 84 / 94 | 54 |
| moong dal | 392 / 507 | 333 | 1254 / 1384 | 1127 |
| bikaji bhujia | 214 / 407 | 184 | 639 / 687 | 568 |
| sarson tel | 218 / 320 | 158 | 475 / 545 | 459 |
| xyzzy (no match) | 28 / 30 | 11 | 32 / 49 | 19 |

¹ One cold first request (app caches empty); the median is representative.

**Against the 200–300 ms target:**
* At 5,000 products, every single-word query and most multi-word queries are under 220 ms median, measured locally.
* Broad two-word queries are slower: "moong dal" partially matches over 1,100 products, ~390 ms.
* At 20,000 products, single-word queries are 85–215 ms. Broad multi-word queries are 390–1,250 ms: every product matching *either* word is ranked (coverage ranking), and here that is thousands.
* The production catalogue is about 150 products, two orders of magnitude below this.
* Production adds the Railway → Supabase network round trip. It is one SQL statement per search, plus the existing product hydration queries.

**Query plans (EXPLAIN ANALYZE, candidate lookup):**
* Every probe goes through `product_search_terms_term_idx`, `_key_idx`, `_key_trgm_idx` (and `_term_trgm_idx` for partials). The benchmark fails if a sequential scan of `product_search_terms` appears.
* Candidate lookup takes 4–17 ms for single-word queries at 5k–20k products, and 30–250 ms for "moong dal".

**Three plan problems were found by measuring and fixed** (engine.ts comments):
1. PostgreSQL inlined the candidate CTE and re-ran its index scan once per probe (`loops=31`; "moong dal" 700 ms → 230 ms). Fixed with `MATERIALIZED` CTEs.
2. One join with an OR of seven match conditions evaluated all 248k candidate×probe pairs (230 → 120 ms). Fixed with one join per probe kind, so equality kinds hash-join.
3. After five executions, PostgreSQL's cached **generic plan** (prepared statements) replaced the index lookups with a parallel seq scan evaluating the whole OR filter (≈800 ms). Fixed by building candidates as a UNION of single-condition index lookups (generic ≈390 ms, custom ≈300 ms) and by sending fixed code constants as SQL literals.

The fuzzy threshold doesn't depend on a session `SET` (the old `configureSearchThresholds` did, and a transaction pooler doesn't keep it). Not used: Redis, materialised result caches, external services.

## 12. Tests

All runs are against the local PostgreSQL 18 test database (`adione_test`, port 55432). No production database was touched.

| Suite | Result |
|---|---|
| Backend full suite (`npx vitest run`), after the final engine changes | **1686 passed, 0 failed**, 6 skipped (the three PERF-only benchmarks). 137 files, 41 min |
| Backend full suite, earlier run before the performance refactor | 1685 passed, 1 failed: `auth-password › rate-limits repeated signups` timed out (256 s against a 20 s limit) during a machine stall. It passed 23/23 when re-run alone, and passed in the final run above |
| `tests/unit/smart-search.test.ts` (new) | 55 passed: normalisation, transliteration table, phonetic keys, pg_trgm-compatible similarity, dictionary rules, term generation, tier ordering, the spec's example table in memory |
| `tests/integration/smart-search.test.ts` (new) | 18 passed (see below); re-run after the release-audit fix together with the food / restaurant / seller-menu suites: 67/67 |
| `tests/perf/smart-search-perf.test.ts` (new, PERF=1) | 3 passed at 5k and 20k products (§11) |
| Web `npm run test:unit` | 71 passed |
| Mobile `npm run test:unit` (incl. new `tests/smartSearch.test.ts`, 5) | 365 passed |
| Typecheck: backend `tsc`, web `tsc --noEmit`, mobile `tsc --noEmit` | clean |
| `prisma validate`; `prisma migrate status` (test DB) | valid; 34 migrations, up to date |

Integration coverage, all through the real API and DB:
* Banana via Banana / banana / banna / baanana / bananna / bananaa / केला / kela / keela / kelaa / kayla, exact product first.
* आलू, aloo, alu, टमाटर, tamatar, "tamat ar", pyaj, pyaaj, प्याज, doodh, dud, दूध, seb, saib, सेब, dahi, दही, chawal, chaal, चावल.
* Partials: ban / tom / pot ("ban" never finds "Urban").
* Ranking: exact tier 8 above fuzzy; xyzzy / qwerty / laptop / zz return nothing.
* Duplicate aliases: one row, one result.
* Customer visibility: pending, hidden, inactive-seller, hidden-category and restaurant products excluded, including by synonym.
* The in-stock filter still applies.
* Keyset pagination: every match exactly once; a tampered cursor returns the first page.
* A new product is found before it is indexed.
* A rename drops the old name immediately (stale) and indexes the new one.
* Soft and hard delete remove the product and its terms.
* Category and brand renames requeue products.
* Backfill: dry-run writes nothing, and runs are repeatable with an identical row count.
* Concurrent rebuilds plus a rename: no duplicates, not stale, final name only.
* Hindi-only names and decomposed nukta.
* Admin product search: works for admin; 403 for a customer, 401 without a token.
* Seller isolation: products and orders, by kela / केला / banana / misspelt name / spaced order number.
* Admin orders by item and by "+91 …" phone.
* Food search by name, cuisine, dish (momo, पनीर, panir), and never by a dish the seller switched off. The release audit found and fixed this: `foodSearchScope` now applies the public menu's own rules, the listing is switched on and the section belongs to that restaurant.

Not run: the mobile `npm test` (Jest) script, because Jest is not installed in `mobile/` and there are no Jest tests. Device testing of the app was not done.

## 13. Production release

Order matters: the code expects the column, table and triggers, and Railway never runs migrations.

1. **Backup** production (as for every migration) and verify it: `npm run db:verify-backup`.
2. **Apply the migration** before deploying the code:
   ```bash
   cd backend
   npm run db:migrate:deploy:v2        # applies 20261106120000_v2_smart_search
   ```
   Brief locks on `products`, `categories` and `brands`. If it waits more than 5 s it aborts and changes nothing; re-run when it's quiet. Check: `node scripts/with-env.mjs .env.v2 npx prisma migrate status --schema=prisma/schema.prisma`.
3. **Backfill** (optional but recommended, so ranking is complete at once):
   ```bash
   npm run search:backfill:v2 -- --dry-run
   npm run search:backfill:v2
   ```
   Expect `failedBatches: 0`, and `staleAfter: 0` — or a handful of products edited through the live (old) backend while it ran. Those are indexed by the new backend's sweep within ~35 s of its boot. Exit code 1 = some batch failed: re-run (idempotent).
4. **Deploy the backend** (push `main` → Railway). The sweep job indexes anything still stale within about 35 s of boot.
5. **Deploy the web panel.** It only uses the new shared files; no API dependency beyond step 4.
6. **Release the mobile app** through the normal store / OTA process. The Food search calls `GET /restaurants/search`, so the backend from step 4 must be live first. Older app versions keep working, since they never call it.

**Precautions**
* Deploying the code **before** the migration breaks every product search (`search_index_stale` / `product_search_terms` missing). Keep the order 2 → 4.
* Between the migration and the first index run, search still works, through the live-name fallback (lower-quality ranking, no synonyms).
* The migration doesn't touch product data. The backfill only writes `product_search_terms` and the stale flag.

**Rollback / recovery**
* *Migration fails* (e.g. the 5 s `lock_timeout`): the whole migration is one transaction, so nothing was applied. Prisma records it as failed and refuses further deploys until it is resolved:
  `node scripts/with-env.mjs .env.v2 npx prisma migrate resolve --rolled-back 20261106120000_v2_smart_search --schema=prisma/schema.prisma`. Then re-run step 2 when traffic is quiet. The old backend keeps serving throughout.
* *Backfill fails or stops part-way*: nothing to undo. Batches are independent transactions and finished ones stay correct. Re-run it. Products it didn't reach stay stale: still searchable by live name, and rebuilt by the new backend's sweep.
* *Backend deploy fails or misbehaves*: redeploy the previous commit on Railway. **Leave the migration in place.** The old code never references the new column, table or functions (verified: zero references at HEAD). The triggers only keep marking edited products stale, which the new backend reindexes when it is redeployed.
* *Search results look wrong*: the table is derived data. Re-run `npm run search:backfill:v2`. It rebuilds every product's terms in place without dropping anything.
* *Web deploy fails*: redeploy the previous web build. The web panel has no API or schema dependency on this change.
* *Full schema rollback* (only if Smart Search is abandoned): first confirm that no deployed backend contains `infra/search/engine.ts`, since the new code needs these objects. Then run the `ROLLBACK` block at the top of the migration file. It drops only derived search data and the stale flag; no product data.

## 14. Known limitations

* The dictionary is curated, not exhaustive. A Hindi word with no group is found only through the product's own Hindi text or keywords. Add groups as the catalogue grows, then backfill.
* Hindi→Roman uses simplified schwa rules. Rare words may transliterate unusually; the phonetic key and typo matching absorb most of this.
* Order search by customer name uses `word_similarity` without a trigram index on `orders.delivery_full_name`. That's fine at the current volume (it scans one seller's orders for seller searches). Add `CREATE INDEX … USING GIN (lower(delivery_full_name) gin_trgm_ops)` if order volume grows into the hundreds of thousands.
* `matchProductIds` callers that keep their own pagination (admin products/inventory, Home picker, order items) cap the matches at 500 / 200 products. That's far above any meaningful result list, but it is a cap.
* Admin lists order by relevance while a query is typed, and by their usual order otherwise. The seller Products page keeps an explicitly chosen sort.
* Performance is measured locally. Production latency adds the Railway → Supabase round trip (cross-region in the 2026-10-21 audit). The engine is one statement per search.
* Broad multi-word queries on very large catalogues (20,000 products) take 0.4–1.3 s locally (§11), because partial matches are ranked, not dropped. If the catalogue grows that large, require every word to match, or cap candidates per word.
* The admin Orders and seller Orders placeholder text changed. No other copy or layout changed.
