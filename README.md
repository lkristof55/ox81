# ox81

**Byte-exact X-ray for Solana transactions: legacy, v0 and v1 (0x81). Every byte labelled, linted and censused, with zero dependencies.**

Since epoch 1035 (2026-09-15) Solana blocks carry a third wire format. A v1 transaction starts with the byte `0x81`, can be 4,096 B instead of 1,232, keeps its signatures at the tail, has no lookup tables, and takes its compute budget from a config mask in its own header instead of ComputeBudget instructions. Readers that aren't ready fail loudly (`-32015` for the whole block) or quietly: a parser that reads a compact-u16 signature count at byte 0 reads `0x81 0x01` as **129 signatures**.

`ox81` takes the raw wire bytes of any transaction and returns:

- **a byte map**: `[start, end)` ranges with field names that cover the transaction exactly, with no gaps and no overlaps, down to the u32 config mask at offset 4;
- **lint findings**: ComputeBudget instructions that are dead on v1 (they cost 150 CU each and set nothing), a priority fee set only in a dead instruction (so the tx bids 0), a missing CU or loaded-data limit, a maxed 64 MiB loaded-data request, and CU over-ask;
- **misread profiles**: what five kinds of pre-v1 reader do with the same bytes;
- **the v1 port size**: the exact size a legacy/v0 transaction would have as v1;
- **a census**: the share of a block that is already v1, and how many v1 txs still pay for no-op instructions.

It is TypeScript with erasable syntax only, so Node >= 23.6 runs `src/*.ts` directly, and it has no runtime dependencies. It reads bytes from a plain `Uint8Array` (no `Buffer`), so the same code runs in the browser (11.5 KB gzip).

```
          0    1    2    3    4        8                          40   41   42
 v1:    ┌────┬────┬────┬────┬────────┬───────────────────────────┬────┬────┬─────────────────┐
        │0x81│ S  │ RS │ RU │  MASK  │ lifetime (blockhash, 32 B)│ #IX│#ADR│ addresses 32·N  │
        └────┴────┴────┴────┴──u32───┴───────────────────────────┴────┴────┴─────────────────┘
          then: ConfigValues 4·popcount(MASK)  (bits 0+1 = one u64 fee in lamports, 2 = CU limit,
                                                3 = loaded-data limit, 4 = heap, 5-31 must be 0)
                instruction headers 4·#IX      (u8 program, u8 nAccounts, u16 LE dataLen)
                instruction payloads           (account indexes, then data, per ix)
                signatures 64·S                (at the tail, no length prefix)

 v0:    [compact-u16 n][64·n signatures][0x80][S RS RU][compact-u16 N][32·N][blockhash 32]
        [compact-u16 #IX]{u8 prog, cu16 a, a idx, cu16 d, d data}*[compact-u16 L]{32 key, cu16 w, w, cu16 r, r}*
 legacy: the same without 0x80 and without the lookup section.

 A pre-v1 reader sees 0x81 0x01 as compact-u16 = (0x81 & 0x7f) + 0x01·128 = 129 signatures,
 and needs 2 + 64·129 = 8,258 bytes before it even reaches the message.
```

## Install

```sh
npm i ox81          # not published yet (planned); for now: clone this repo
```

Node >= 20 for the built package (`dist/`); Node >= 23.6 to run `src/*.ts`, the tests and the examples directly from a clone.

The package exports only built JavaScript: `ox81` resolves to `dist/index.js` (types in `dist/index.d.ts`) and the `ox81` bin to `dist/cli.js`. `src/` is shipped for reading only and is not an export, because Node refuses to strip types from files under `node_modules`.

## Usage

```ts
import { xray, fetchTransaction } from 'ox81';

const t = await fetchTransaction(process.env.OX81_RPC_URL!, signature);   // getTransaction, base64, maxSupportedTransactionVersion 1
const x = xray(t!.bytes, { meta: t!.meta, loadedAddresses: t!.loadedAddresses, source: 'rpc' });

x.version;            // 'v1'
x.ranges[4];          // { start: 4, end: 8, field: 'configMask', group: 'config', value: '0x0000000f', ... }
x.config;             // { bits: [0,1,2,3], priorityFeeLamports: '28488', computeUnitLimit: 77597, ... }
x.lint.map(f => f.id) // ['V1_DEAD_COMPUTE_BUDGET', 'SIZE_OVER_1232', 'CU_OVERASK']
x.misread[0].result;  // 'Reads 0x81 0x01 as a compact-u16 signature count of 129: needs 8,258 B, ...'
```

Raw bytes need no RPC at all: `xray(bytes)`. Lookup-loaded accounts then have `pubkey: null`, because only the table and index are on the wire.

## CLI

```sh
npx ox81 xray <signature|base64> [--rpc URL] [--json]
npx ox81 lint <signature|base64> [--rpc URL] [--json]
npx ox81 census --slots 100 [--rpc URL] [--json]
```

The RPC comes from `--rpc`, else `OX81_RPC_URL`, else `https://api.mainnet-beta.solana.com` (public and rate-limited; the CLI prints a warning). `census --slots N` fetches the last N finalized slots (`getBlock` is 3-4 MB per block, so use your own RPC for large N).

```
$ node src/cli.ts census --slots 3
ox81 census · slots 450367690..450367692 · 3 blocks (0 skipped) · 4,423 txs · 2026-09-25T13:35:06.000Z
versions     legacy 2,532 · v0 892 · v1 999   (non-vote: legacy 541 · v0 892 · v1 999)
v1 share     22.6% of all txs · 41.1% of non-vote
dead CB      48 v1 txs carry 109 ComputeBudget ixs = 16,350 CU of no-ops (4.8% of v1; 47 of those txs failed, for their own reasons)
...
```

(One run, 2026-09-25 13:35 UTC. The share moves block to block: the same day's samples ranged from 8% to 23%.)

## API

| Function | Returns |
|---|---|
| `sniff(bytes)` | `{ version: 'legacy' \| 'v0' \| 'v1', discriminatorOffset }`. O(1) for v1. |
| `decode(bytes)` | `DecodedTx`: header, config, addresses, instructions, lookups, signatures, `ranges`. Throws `DecodeError { at, partial }` only on structural failure: truncation, trailing bytes, a malformed compact-u16, or an unknown version byte. |
| `byteMap(tx)` | `ByteRange[]`: sorted and contiguous, covering `[0, size)`. |
| `lint(tx, meta?)` | `LintFinding[]` with `id`, `severity`, `ranges` (byte spans), `cu`, `bytes`. |
| `misread(tx)` | `MisreadProfile[]`: always 5 readers, in a fixed order. |
| `v1Port(tx, loaded?)` | `V1Port` for legacy/v0, `null` for v1. |
| `xray(bytes, { meta?, loadedAddresses?, source? })` | All of the above as one JSON-ready object. |
| `census(blocks)` | `CensusResult` over `getBlock` responses (base64, `maxSupportedTransactionVersion: 1`) plus their slot. |
| `featured(block)` | The largest v1, the first v1 with a dead ComputeBudget ix, the first non-vote v0 with lookups, and the first non-vote legacy tx, each with its X-ray. |
| `fetchTransaction`, `fetchBlock`, `fetchLatestBlock`, `fetchSlot` | Thin `fetch` helpers: base64, `maxSupportedTransactionVersion: 1`, 8 s timeout, retry on 429/503. No keys inside. |

Every constant (4,096 B, 12/64/64, heap bounds, 150 CU, 8 CU per 32 KiB) is pinned in [`src/constants.ts`](src/constants.ts) with its source.

## Lint rules

| id | severity | when |
|---|---|---|
| `V1_DEAD_COMPUTE_BUDGET` | warn | v1 tx with ComputeBudget ixs. `cu` = 150 per ix; `bytes` = each ix's header + accounts + data, plus 32 B for the ComputeBudget address if nothing else uses it. |
| `V1_PRIORITY_ONLY_IN_IX` | warn | v1 tx with `SetComputeUnitPrice` while config bits 0+1 are unset or 0: it bids 0 priority. |
| `V1_CU_LIMIT_ABSENT` / `V1_CU_LIMIT_ZERO` | error | bit 2 unset, or set to 0: the requested CU limit is 0. |
| `V1_LOADED_LIMIT_ABSENT` | error | bit 3 unset: the loaded-accounts data limit is 0. |
| `V1_PRIORITY_HALF_MASK` / `V1_UNKNOWN_CONFIG_BITS` / `V1_HEAP_INVALID` | error | exactly one of bits 0/1; any of bits 5-31; heap not a 1 KiB multiple in [32 KiB, 256 KiB]. |
| `V1_SANITIZE` | error | the other SIMD-0385 rules: > 4,096 B, > 12 signatures, > 64 addresses or ixs, header counts, program index 0 or out of range, account index out of range. |
| `SIZE_OVER_1232` | info | a v1 tx larger than 1,232 B (possible only as v1; submit as base64). |
| `LOADED_LIMIT_MAX` | info | loaded-data limit at 64 MiB. `cu` = ceil(limit / 32 KiB) x 8, the pre-execution charge in the Agave cost model. |
| `CU_OVERASK` | info | with RPC meta: an explicit CU limit >= 4x the CU consumed. |
| `LEGACY_BUDGET_IXS` / `V0_LOOKUPS` | info | what a v1 port changes: ComputeBudget ixs become config values; each lookup address is inlined (+31 B). |
| `DUPLICATE_ADDRESS` / `SIZE_OVER_LIMIT` | error or info | duplicates (rejected by v1, allowed before); legacy/v0 over 1,232 B. |

## Benchmarks

Measured on this machine: Apple M5, 10 cores, 16 GB, Node v26.8.1, 2026-09-25. Fixture: the recorded mainnet block 450355468 (974 txs: 671 legacy, 203 v0, 100 v1; 560,865 B of wire bytes). Reproduce with `npm run bench`.

| What | Result |
|---|---|
| `sniff()` | 5.6 ns/tx |
| `decode()` + byte map, all 974 txs | 42,837-43,181 txs/s (24.7-24.9 MB/s) |
| `decode()`, the 100 v1 txs only | 17,422-17,666 txs/s (they are larger: p50 1,415 B) |
| `xray()` full (decode + accounts + lint + misread + v1Port + base64) | 29,551-29,736 txs/s |
| `census()` of the whole block, base64 decode included, network excluded | 37.3 ms (median of 25) |
| Browser bundle (`esbuild src/index.ts --bundle --minify --format=esm`) | 29,231 B minified, 11,537 B gzip |
| Reference: `@solana/web3.js` 1.99.0 `VersionedTransaction.deserialize`, same 974 txs | 22,928-22,966 txs/s (all 974 parsed; returns objects, no byte map or lint) |

Ranges are from two runs. Most of `decode()`'s time goes to base58-encoding the addresses and signatures for the labels. The web3.js line is there as a reference point, not a race: the two libraries produce different outputs.

## How it works

**sniff.** Byte 0 decides v1 in O(1): `0x81`. Otherwise byte 0 is a compact-u16 signature count `n`; skip `64n` bytes and read the message's first byte: `0x80` is v0, a clear high bit is legacy, anything else with the high bit set is an unknown version.

**decode.** One O(size) pass. Every read pushes a `ByteRange { start, end, field, group }` before moving the cursor, so the output is a partition of `[0, size)`. A final check throws on trailing bytes. For v1 the offsets are fixed up to the addresses (`version@0, header@1-3, configMask u32 LE @4-7, lifetime@8-39, numInstructions@40, numAddresses@41, addresses@42`). ConfigValues start at `42 + 32N` and take 4 B per set mask bit in ascending order; bits 0 and 1 together are one u64 (the priority fee in lamports, not micro-lamports per CU). Instruction headers follow at `42 + 32N + 4·popcount(mask)`, then the payloads, then `numRequiredSignatures x 64` bytes of signatures. Compact-u16 reads reject truncation, lengths over 3 bytes, values over `0xffff` and non-canonical (alias) encodings.

**Checked against the chain.** In the test block, for all 100 v1 txs, `meta.fee` equals `5000 x signatures + the priority fee decoded from the config bytes`, and every one of the 974 txs decodes to a partition that matches the node's own version label. The 150 CU per no-op ComputeBudget ix is measured on-chain: in tx `W81fNLque…` the config CU limit is 77,597 and the next instruction logs `consumed 1281 of 77447`.

**lint** is a list of pure predicates over the decoded tx plus optional RPC meta, and every finding carries the byte spans it is about. **misread** is closed form: a sig-count-first parser reads `0x81 0xNN` as `1 + 128·NN` signatures and needs `2 + 64·(1 + 128·NN)` bytes. **v1Port** is closed form too:

```
size = 1 + 3 + 4 + 32 + 1 + 1 + 32·A + 4·P + Σ(4 + nAccounts + dataLen over non-ComputeBudget ixs) + 64·S
A = static + lookup-loaded addresses (minus the ComputeBudget address if only ComputeBudget ixs use it)
P = |{2, 3} ∪ bits implied by the ComputeBudget ixs|, S = numRequiredSignatures
```

A test builds the actual v1 encoding of a synthetic legacy message and checks that its length equals `v1Port().size`. **census** folds decode + lint over every transaction of a block.

## Tests

```sh
npm test      # node --test, offline: 26 tests on a recorded mainnet block + synthetic edge cases
```

The fixtures in `test/fixtures/` were recorded once with `OX81_RPC_URL=… npm run record`. The `*.expected.json` files come from an independent Python reference decoder written from the SIMD-0385 text; the tests require the structural fields to match exactly.

## Limits and PLANNED

- The config parse follows SIMD-0385 as of 2026-09-25, with the field names of SIMD PR #666 (`ConfigValues`). Offsets are byte-based, so renames don't change them.
- `writable` follows the header and the lookup sections; runtime demotions (reserved account keys, invoked programs) are not applied.
- Re-signing is not modelled in `v1Port`, and duplicate checks across lookup-loaded addresses need `loadedAddresses` (RPC meta).
- `census` samples the blocks you give it. **PLANNED:** a Yellowstone/Geyser stream mode for every block; a per-program leaderboard of dead-ComputeBudget senders; a loaded-accounts right-sizer that measures what a tx really loads; a WASM build for Geyser plugins.

## Prior art

- **@solana/kit** (anza-xyz/kit, `transaction-messages/src/decompile/v1`) and **@solana/web3.js 1.99** (`VersionedTransaction.deserialize` parses v1): codecs that decode into objects.
- **okxlabs/sonar**: a Rust CLI with strict v1 parsing, decoding and local simulation.
- **solana-go** `message_v1.go` and anza **solana-sdk** `message/src/versions/v1`: SDK implementations.

These all decode v1 into objects. ox81 maps every byte to its field as ranges that cover the transaction exactly. It also models how pre-v1 readers misread the same bytes, lints v1 resource-request mistakes, computes the exact v1 port size, and censuses live blocks, in one zero-dependency TypeScript package.

## The live app

[`app/`](app/) is the complete source of the live demo at **https://ox81.netlify.app**: the site (a scroll-driven datasheet whose 3D parts are built from real transactions) and the Netlify Functions that run this library on Solana mainnet (`/api/xray`, `/api/census`, `/api/featured`, `/api/health`, plus a census job every 10 minutes). The functions import the library straight from `src/`, so the demo runs the code in this repo. The library does not import anything from `app/`, and `app/` is not part of the npm package.

```sh
cd app && npm ci
cp .env.example .env                        # HELIUS_API_KEY (or SOLANA_RPC_URL)
npm test && npm run build && npm run dev    # http://localhost:8888
```

To deploy your own copy, connect this repo to a Netlify site and set `HELIUS_API_KEY` in its environment variables. The root [`netlify.toml`](netlify.toml) builds `app/`. [`app/README.md`](app/README.md) covers the endpoints, env vars, the scheduled function, the RPC credit budget and the asset licenses.

## License

MIT, see [LICENSE](LICENSE). Exception: the third-party site assets in `app/site/public/` (HDRI CC0 1.0, fonts SIL OFL 1.1, Draco decoder Apache-2.0) keep their own licenses, listed in [`app/site/public/CREDITS.md`](app/site/public/CREDITS.md).

---
Live demo site: [ox81.netlify.app](https://ox81.netlify.app) (source in [`app/`](app/)).
