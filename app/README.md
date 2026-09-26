# Ox81 app: the site and backend of ox81.netlify.app

This folder is the complete source of **https://ox81.netlify.app**. The page is a scroll-driven datasheet: its 3D parts are built from real transactions, and a live X-ray desk runs the `ox81` library (the repo root, [`../src`](../src)) on Solana mainnet. Paste a signature or raw base64 and every byte of the transaction gets its field, its lint findings and the five pre-v1 misreads. A census job samples the newest finalized block every 10 minutes and reports what share of transactions is already v1.

The Netlify Functions import the library straight from `../src/*.ts`, so the live demo runs the same code as `npm test` at the root.

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
  lib/                 sources.mjs (the only upstream I/O), snapshot.mjs (Blobs snapshots), aggregate.mjs (pure 24 h
                       aggregation), http.mjs (validation, error shape, rate limit, TTL cache), store.mjs (Blobs / files)
  test/                backend.test.mjs + shipped.test.mjs (offline), smoke.mjs (live), record.mjs (fixtures)
  site/                index.html, 404.html, src/ (three.js + gsap + lenis), public/ (models, fonts, HDRI), tools/
  scripts/             build.mjs (esbuild), dev.mjs (local server)
```

The backend tests read the library's recorded mainnet fixtures in [`../test/fixtures/`](../test/fixtures). `test/shipped.test.mjs` scans every file the app ships, including the raw transaction bytes inside the JSON data, for API keys, social handles and profile links.

## Endpoints

| Method + path | Does | Cache |
|---|---|---|
| `GET /api/xray?sig=<base58>` | `getTransaction` (base64, `maxSupportedTransactionVersion: 1`, confirmed), then `xray(bytes, { meta, loadedAddresses, source: 'rpc' })` | 3600 s (memory + `Cache-Control`) |
| `POST /api/xray` `{ "raw": "<base64>" }` | Pure compute with no RPC: `xray(bytes, { source: 'raw' })`, 1-4096 bytes | none |
| `GET /api/census?window=latest\|24h` | Census of the newest snapshot block, or the sum over every snapshot of the last 24 h (`fallback: true` until one exists) | 120 s |
| `GET /api/featured` | Real transactions from the snapshot block (v1-largest, v1-dead-cb, v0-lookups, legacy), each with its full X-ray | 300 s |
| `GET /api/health` | Liveness, which keys are set (names only), and `tokenMint` | none |

Errors are `{ error, code }`. The codes are `BAD_INPUT` 400, `NOT_FOUND` 404, `DECODE_FAILED` 422, `RATE_LIMITED` 429, `UPSTREAM` 502 and `TIMEOUT` 504. `DECODE_FAILED` adds `at` (the byte offset) and `partial` (the ranges decoded before the failure). `/api/xray` allows 30 requests per minute per IP.

```sh
B=http://localhost:8888            # or https://ox81.netlify.app
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
| `LOCAL_STORE_DIR` | local only | The JSON file store that replaces Blobs. `scripts/dev.mjs` sets it to `app/.data`. Leave it unset on Netlify. |

## Deploy to Netlify

1. Connect the GitHub repo to a new Netlify site. The repo-root [`netlify.toml`](../netlify.toml) already sets base `app`, command `npm run build`, publish `site/dist`, functions `netlify/functions` and `node_bundler = "esbuild"`. Leave the UI build settings empty.
2. Set `HELIUS_API_KEY` (or `SOLANA_RPC_URL`) under Site configuration -> Environment variables, scoped to Functions. `TOKEN_MINT` is optional.
3. Deploy. Netlify runs `npm ci` and `npm run build` in `app/`, then bundles each function with esbuild, including the `../src/*.ts` files they import. The only runtime dependency is `@netlify/blobs`.
4. Blobs: the store `ox81` is created on the first write, so there is nothing to provision.
5. Webhooks: none needed.

### Scheduled functions

`census-cron` exports `config.schedule = '*/10 * * * *'`, which Netlify reads from the function itself on deploy. Each run makes 2 RPC calls (`getSlot` finalized + `getBlock`, plus 1 per skipped slot, up to 5) and writes the census, the 24 h index and the featured picks to Blobs. After the first 10 minutes, check that runs appear under Functions -> census-cron. The site also works without the schedule, because `/api/census` and `/api/featured` refresh inline when the snapshot is older than 600 s.

## Data sources and limits

- **Solana RPC only** (Helius by default): `getSlot`, `getBlock` (base64, full, no rewards, 3-4 MB and 0.6-0.9 s per block), `getTransaction` (about 80-100 ms). Every call has an 8 s timeout and retries with backoff on 429/503.
- If the tip slot was skipped, the snapshot tries tip-1 down to tip-5.
- The census is a sample: one block every 10 minutes, up to 144 blocks in the 24 h window (the index is capped at 200 entries). Every number is stamped with its slots and block time. **PLANNED:** a Geyser/Yellowstone stream so the census covers every block.

## Costs (Helius credits)

Helius bills 1 credit per standard RPC call, including `getBlock` and `getTransaction` ([docs](https://www.helius.dev/docs/billing/credits)). Some third-party pages list archival reads at 10 credits. Neither call here is archival (the calls read the finalized tip, or a signature a visitor just pasted), but the table gives that worst case too.

| Event | Calls | Credits |
|---|---|---|
| Page view (hero, census, presets) | Blobs reads only | **0** |
| Page view with a snapshot older than 600 s and the schedule off | getSlot + getBlock, shared by every view in that window | 2 (worst case 11) |
| `GET /api/xray?sig=`, uncached | getTransaction | 1 (worst case 10), then cached for 1 h per signature |
| `POST /api/xray` | none | 0 |
| census-cron run | getSlot + getBlock | 2 per run × 144 runs = 288 a day, about 8,640 a month (worst case 11 per run) |

A typical view costs 0-1 credits. Bandwidth: each `getBlock` is 3-4 MB, about 0.5 GB a day at 144 runs. Netlify: 144 scheduled invocations a day plus one invocation per API request.

## Licenses

The code is MIT (see [`../LICENSE`](../LICENSE)). The site assets are third-party files under CC0 1.0 (HDRI), SIL OFL 1.1 (fonts) and Apache-2.0 (Draco decoder), plus project-original models under MIT. Each one is listed with its source and author in [`site/public/CREDITS.md`](site/public/CREDITS.md).
