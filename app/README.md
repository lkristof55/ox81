# Ox81 app: the site and backend of ox81.anyfee.workers.dev

This folder is the complete source of **https://ox81.anyfee.workers.dev**, which runs on Cloudflare Workers. The same code still deploys to Netlify; the Netlify copy (ox81.netlify.app) is paused. The page is a scroll-driven datasheet: its 3D parts are built from real transactions, and a live X-ray desk runs the `ox81` library (the repo root, [`../src`](../src)) on Solana mainnet. Paste a signature or raw base64 and every byte of the transaction gets its field, its lint findings and the five pre-v1 misreads. A census job samples the newest finalized block every 10 minutes (on the Workers Free plan, about every 2 hours, see below) and reports what share of transactions is already v1.

The backend is a set of Netlify Functions v2 handlers. On Netlify they run as functions; on Cloudflare, [`worker.mjs`](worker.mjs) runs the same handlers. They import the library straight from `../src/*.ts`, so the live demo runs the same code as `npm test` at the root.

## Run locally

Needs Node 22.18 or newer, because the functions import `../src/*.ts` directly and rely on Node's built-in type stripping. CI runs Node 24, and the tests and the build also pass on 22.18.

```sh
cd app
npm ci
cp .env.example .env            # set HELIUS_API_KEY (or SOLANA_RPC_URL)
npm test                        # offline unit tests (no RPC, no key)
npm run build                   # site/src -> site/dist (esbuild)
npm run dev                     # site + every function on http://localhost:8888
npm run dev -- --cron           # also runs the scheduled census-cron once a minute
npm run smoke                   # one real mainnet request per endpoint against the running server
```

`npm run watch` rebuilds the site on change and reloads the functions. `PORT=9000 npm run dev` or `node scripts/dev.mjs --port 9000` picks another port. `npm run record` re-records the library's fixtures (about 3 Helius credits) and `npm run listing` refreshes Listing 1 on the page from `../src/decode.ts`.

`scripts/dev.mjs` is a small stand-in for `netlify dev`. It serves `site/dist`, routes each `config.path` to its function, reads `app/.env`, and swaps Netlify Blobs for JSON files in `app/.data/`.

## Layout

```
app/
  netlify/functions/   xray.mjs, census.mjs, featured.mjs, health.mjs, census-cron.mjs (scheduled)
  lib/                 sources.mjs (the only upstream I/O), snapshot.mjs (census snapshots), aggregate.mjs (pure 24 h
                       aggregation), http.mjs (validation, error shape, rate limit, TTL cache), store.mjs (Blobs / D1 / files)
  worker.mjs           Cloudflare Workers entry: routes each config.path to its handler, runs census-cron on the cron
  wrangler.jsonc       Worker config (static assets, D1 binding, cron, CF_FREE_PLAN)
  migrations/          0001_kv.sql, the D1 table behind store.mjs
  test/                backend.test.mjs + cloudflare.test.mjs + shipped.test.mjs (offline), d1-fake.mjs (D1 API on
                       node:sqlite), smoke.mjs (live), record.mjs (fixtures)
  site/                index.html, 404.html, src/ (three.js + gsap + lenis), public/ (models, fonts, HDRI), tools/
  scripts/             build.mjs (esbuild), dev.mjs (local server)
```

The backend tests read the library's recorded mainnet fixtures in [`../test/fixtures/`](../test/fixtures). `test/shipped.test.mjs` scans every file the app ships, including the raw transaction bytes inside the JSON data, for API keys, social handles and profile links.

## Endpoints

| Method + path | Does | Cache |
|---|---|---|
| `GET /api/xray?sig=<base58>` | `getTransaction` (base64, `maxSupportedTransactionVersion: 1`, confirmed), then `xray(bytes, { meta, loadedAddresses, source: 'rpc' })` | 3600 s (memory + `Cache-Control`) |
| `POST /api/xray` `{ "raw": "<base64>" }` | Pure compute with no RPC: `xray(bytes, { source: 'raw' })`, 1-4096 bytes | none |
| `GET /api/census?window=latest\|24h` | Census of the newest snapshot block, or the sum over every snapshot of the last 24 h (`fallback: true` until one exists) | 120 s (`no-store` while `warming`) |
| `GET /api/featured` | Real transactions from the snapshot block (v1-largest, v1-dead-cb, v0-lookups, legacy), each with its full X-ray | 300 s |
| `GET /api/health` | Liveness, which keys are set (names only), and `tokenMint` | none |

On Cloudflare the census and featured endpoints only read the store: `stale: true` means the newest block in the answer is older than `CENSUS_STALE_SEC` (20 min by default). Before the first census exists they answer 200 with the normal shape, no numbers and `warming: true` (featured: `picks: []`); the site then says it is warming up. On Netlify they refresh inline instead, as described under Scheduled functions.

Errors are `{ error, code }`. The codes are `BAD_INPUT` 400, `NOT_FOUND` 404, `DECODE_FAILED` 422, `RATE_LIMITED` 429, `UPSTREAM` 502 and `TIMEOUT` 504. `DECODE_FAILED` adds `at` (the byte offset) and `partial` (the ranges decoded before the failure). `/api/xray` allows 30 requests per minute per IP.

```sh
B=http://localhost:8888            # or https://ox81.anyfee.workers.dev
curl "$B/api/featured"
curl "$B/api/census"
curl "$B/api/census?window=24h"
SIG=$(curl -s "$B/api/featured" | node -pe 'JSON.parse(require("fs").readFileSync(0)).picks[0].signature')
curl "$B/api/xray?sig=$SIG"
RAW=$(curl -s "$B/api/featured" | node -pe 'JSON.parse(require("fs").readFileSync(0)).picks[0].xray.raw')
curl -X POST "$B/api/xray" -H 'content-type: application/json' -d "{\"raw\":\"$RAW\"}"
curl "$B/api/health"
```

## Env vars

Every variable is listed in [`.env.example`](.env.example) with a one-line comment.

| Name | Needed | Notes |
|---|---|---|
| `HELIUS_API_KEY` | yes, unless `SOLANA_RPC_URL` is set | Mainnet RPC, read-only calls only. The key never reaches the browser, a log or a response, and upstream error messages are scrubbed of URLs. |
| `SOLANA_RPC_URL` | no | Replaces the RPC URL entirely. Any provider that serves `getBlock` with `maxSupportedTransactionVersion: 1` works. |
| `TOKEN_MINT` | no | Returned as `tokenMint` by `/api/health` (null while empty or not base58). Nothing is holder-gated. |
| `BIRDEYE_API_KEY` | no | Only reported as a boolean by `/api/health`. |
| `CF_FREE_PLAN` | Cloudflare | `1` (set in `wrangler.jsonc`) runs the census cron in split mode for the Workers Free plan's 10 ms CPU limit. `0` on Workers Paid. Unset on Netlify. |
| `CENSUS_TXS_PER_RUN` | no | Transactions decoded per cron run in split mode (default 100 with `CF_FREE_PLAN=1`). `0` reads the whole block in one run. |
| `CENSUS_STALE_SEC` | no | Cloudflare only: age of the newest block after which `/api/census` and `/api/featured` say `stale: true` (default 1200). |
| `LOCAL_STORE_DIR` | local only | The JSON file store that replaces Blobs. `scripts/dev.mjs` sets it to `app/.data`. Leave it unset on Netlify and Cloudflare. |

## Deploy to Cloudflare Workers

[`wrangler.jsonc`](wrangler.jsonc) deploys the app as one Worker: `site/dist` as static assets (with `404.html` for unknown paths), [`worker.mjs`](worker.mjs) in front of `/api/*`, a D1 database as the store, and `census-cron` on the cron `*/10 * * * *`. Static files never run the Worker.

```sh
cd app
npm ci && npm run build                              # site/dist, served as static assets
npx wrangler@4 d1 create ox81-store                  # once; put the printed database_id into wrangler.jsonc
npx wrangler@4 d1 migrations apply ox81-store --remote
npx wrangler@4 secret put HELIUS_API_KEY             # or SOLANA_RPC_URL
npx wrangler@4 secret put TOKEN_MINT                 # optional
npx wrangler@4 secret put BIRDEYE_API_KEY            # optional, only reported by /api/health
npx wrangler@4 deploy
```

`CF_FREE_PLAN` is a plain var in `wrangler.jsonc` (`"1"`); set it to `"0"` on Workers Paid. `nodejs_compat` fills `process.env` from vars and secrets, which is where the functions read them.

Locally, without an account: `npx wrangler@4 d1 migrations apply ox81-store --local`, put `HELIUS_API_KEY=...` in `app/.dev.vars` (gitignored), run `npx wrangler@4 dev --local --test-scheduled`, and trigger the cron with `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"`. The older `/__scheduled` path is answered by the static assets, because only `/api/*` runs the Worker first. `npm run smoke` takes the dev URL: `node test/smoke.mjs http://localhost:8787`.

### Free-plan budgets

The Workers Free plan allows 10 ms of CPU per invocation (HTTP and cron alike), 50 external subrequests, 1,000 D1 queries, 100,000 requests a day per account (static assets are free) and 5M D1 rows read / 100k written a day per account. CPU below was measured with `process.cpuUsage()` around each handler in Node 26 (same V8) on an Apple M5, median of 3 runs on live mainnet data. Cloudflare's CPUs may be slower.

| Handler | External fetches, worst case | CPU |
|---|---|---|
| `GET /api/census`, `?window=24h` | 0 | 0.1-0.2 ms (1 D1 row) |
| `GET /api/featured` | 0 | 0.3-0.6 ms (1 D1 row, 50-80 KB) |
| `GET /api/xray?sig=` | 3 (1 + 2 retries) | 2-4 ms uncached, 0.1 ms cached |
| `POST /api/xray` | 0 | 0.4-0.5 ms |
| `GET /api/health` | 0 | under 0.1 ms |
| cron, whole block (`CF_FREE_PLAN=0`) | 21 (getSlot + getBlock of up to 6 slots, 3 attempts each) | 50-170 ms |
| cron, split: fetch step | 21 | 36-84 ms in Node (see below) |
| cron, split: scan step (100 txs) | 0 | about 5 ms, occasional GC spikes to 15 ms |
| cron, split: publish step | 0 | about 3 ms |

What that means on the free plan:

- **The endpoints never refresh.** `/api/census` and `/api/featured` read one D1 row and serve it with its age. Only the cron writes.
- **The census cron cannot decode a whole block in 10 ms.** A mainnet block is 900-1,200 transactions and 2.3-2.9 MB of JSON, and decoding + linting every transaction takes about 45 ms here. So with `CF_FREE_PLAN=1` each cron run does one step: *fetch* (getSlot + getBlock, uncompressed, parsed and stored as pages of 100 transactions with only the meta fields ox81 reads, no decoding), *scan* one page, or *publish* (census over all pages, featured picks, the 24 h aggregate). The published census and featured picks are the same ones a whole-block run gives for that block (`test/cloudflare.test.mjs` checks it); only their age changes.
- **What you see:** a new census every 12-15 runs, so about every 2-2.5 hours. The census is always of a block that is 2-5 hours old, flagged `stale` with its age on the page. The 24 h window holds about 10 blocks instead of 144, and says how many. The featured transactions come from the same block.
- **The fetch step is the one that can't shrink:** it has to parse one full getBlock response. In Node it measured 36-84 ms, but most of that is Node's HTTP client; the parse itself is about 3 ms and slicing the pages under 1 ms. The Worker asks for `Accept-Encoding: identity`, so no gzip has to be inflated. On Workers the HTTP client is native code, so the isolate's share should be much smaller, but workerd doesn't report CPU locally. Watch the deployed Worker's logs: if the cron's outcome is `exceededCpu` on most fetch steps, no new census gets published and the site keeps showing the last one with its age (or "warming up" on a fresh deploy). The isolate's burst allowance is meant for exactly this kind of occasional overrun (1 run in 13).
- A step that fails to finish twice (for example, killed for CPU) drops its block, logs `dropped slot …`, and the next run fetches a new block. Lower `CENSUS_TXS_PER_RUN` if a page keeps getting killed.
- **Subrequests:** at most 21 external fetches (fetch step), 3 for `/api/xray`, and under 60 D1 queries per cron run.
- **D1:** on the free plan the cron writes under 2,000 rows and reads under 1,000 a day, plus 1 row read per census or featured request (2 for a 24 h fallback). With `CF_FREE_PLAN=0` the 24 h aggregate reads its ~144 per-block rows every run, about 21,000 rows a day. The largest value is `featured/latest` (50-80 KB, about 0.5 MB in a constructed worst case); pages stay under 1 MB. D1's row cap is 2 MB, and the store refuses a larger value instead of cutting it.
- **Helius credits** drop to about 22 a day on the free plan (2 per block, about 11 blocks).
- On **Workers Paid** (`CF_FREE_PLAN=0`) the cron reads a whole block every 10 minutes, the same as on Netlify, well within the paid plan's 30 s CPU limit.

## Deploy to Netlify

1. Connect the GitHub repo to a new Netlify site. The repo-root [`netlify.toml`](../netlify.toml) already sets base `app`, command `npm run build`, publish `site/dist`, functions `netlify/functions` and `node_bundler = "esbuild"`. Leave the UI build settings empty.
2. Set `HELIUS_API_KEY` (or `SOLANA_RPC_URL`) under Site configuration -> Environment variables, scoped to Functions. `TOKEN_MINT` is optional.
3. Deploy. Netlify runs `npm ci` and `npm run build` in `app/`, then bundles each function with esbuild, including the `../src/*.ts` files they import. The only runtime dependency is `@netlify/blobs`.
4. Blobs: the store `ox81` is created on the first write, so there is nothing to provision.
5. Webhooks: none needed.

### Scheduled functions

`census-cron` exports `config.schedule = '*/10 * * * *'`, which Netlify reads from the function itself on deploy. Each run makes 2 RPC calls (`getSlot` finalized + `getBlock`, plus 1 per skipped slot, up to 5) and writes the census, the 24 h index and the featured picks to Blobs. After the first 10 minutes, check that runs appear under Functions -> census-cron. The site also works without the schedule, because `/api/census` and `/api/featured` refresh inline when the snapshot is older than 600 s.

On Cloudflare the same function runs from `scheduled()` in `worker.mjs` on the one cron in `wrangler.jsonc`, and the endpoints never refresh inline (see Free-plan budgets above).

## Data sources and limits

- **Solana RPC only** (Helius by default): `getSlot`, `getBlock` (base64, full, no rewards, 3-4 MB and 0.6-0.9 s per block), `getTransaction` (about 80-100 ms). Every call has an 8 s timeout and retries with backoff on 429/503.
- If the tip slot was skipped, the snapshot tries tip-1 down to tip-5.
- The census is a sample: one block every 10 minutes (about one every 2 hours on the Workers Free plan), up to 144 blocks in the 24 h window (the index is capped at 200 entries). Every number is stamped with its slots and block time. **PLANNED:** a Geyser/Yellowstone stream so the census covers every block.

## Costs (Helius credits)

Helius bills 1 credit per standard RPC call, including `getBlock` and `getTransaction` ([docs](https://www.helius.dev/docs/billing/credits)). Some third-party pages list archival reads at 10 credits. Neither call here is archival (the calls read the finalized tip, or a signature a visitor just pasted), but the table gives that worst case too.

| Event | Calls | Credits |
|---|---|---|
| Page view (hero, census, presets) | store reads only (Blobs or D1) | **0** |
| Page view with a snapshot older than 600 s and the schedule off | getSlot + getBlock, shared by every view in that window | 2 (worst case 11) |
| `GET /api/xray?sig=`, uncached | getTransaction | 1 (worst case 10), then cached for 1 h per signature |
| `POST /api/xray` | none | 0 |
| census-cron run | getSlot + getBlock | 2 per run × 144 runs = 288 a day, about 8,640 a month (worst case 11 per run) |
| census-cron on the Workers Free plan | getSlot + getBlock once per block (1 run in 12-15) | about 22 a day |

A typical view costs 0-1 credits. Bandwidth: each `getBlock` is 3-4 MB, about 0.5 GB a day at 144 runs. Netlify: 144 scheduled invocations a day plus one invocation per API request.

## Licenses

The code is MIT (see [`../LICENSE`](../LICENSE)). The site assets are third-party files under CC0 1.0 (HDRI), SIL OFL 1.1 (fonts) and Apache-2.0 (Draco decoder), plus project-original models under MIT. Each one is listed with its source and author in [`site/public/CREDITS.md`](site/public/CREDITS.md).
