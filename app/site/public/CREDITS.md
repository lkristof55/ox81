# Credits

Every third-party asset used by the Ox81 site and brand kit. Everything else (the package, sockets, die, wafer and mark) is built in code from real transaction data by the builders in `site/src/scene/chip.js` (`buildPackage`, `buildSocket`, `buildMark`). The `.glb` files below were exported from those builders in the project's design pipeline, which is not part of this repo.

## Environment

| Asset | File | Source | Author | License |
|---|---|---|---|---|
| Monochrome Studio 02 (HDRI, 1k) | `tex/monochrome_studio_02_1k.hdr` | https://polyhaven.com/a/monochrome_studio_02 | Grzegorz Wronkowski | CC0 1.0 |

## Models (built, not sourced)

| Asset | File | How it was made | License |
|---|---|---|---|
| OX81-V1 package, TQFP-77 | `models/ox81-chip-v1-largest.glb` | `buildPackage()` in `site/src/scene/chip.js`. The input is the real v1 tx `42mQS8aG…YPd7` from slot 450,355,468: 77 byte ranges give 77 leads, and 2,401 B sets the body area. Exported with GLTFExporter and optimized with gltf-transform (draco, webp). | project original, MIT |
| OX80-V0 package, TQFP-42 | `models/ox81-chip-v0-lookups.glb` | The same builder, run on the real v0 tx from the same slot (584 B, 42 ranges). | project original, MIT |
| OX00-LGC package, SOIC-27 | `models/ox81-chip-legacy.glb` | The same builder, run on the real legacy tx from the same slot (331 B, 27 ranges). | project original, MIT |
| Reader socket (v1) | `models/ox81-socket-v1.glb` | `buildSocket()`: a machined frame with a pocket cut to the v1 package's lead span, and one gold pad per lead. | project original, MIT |
| Ox81 mark, extruded | `models/ox81-mark.glb` | `buildMark()`: an extrusion of `brand/logo.svg` on the 8×8 bit grid (rows 81 81 ff db 7e 3c 3c 18). | project original, MIT |

## Decoder

| Asset | Files | Source | License |
|---|---|---|---|
| Draco decoder | `draco/draco_decoder.js`, `draco/draco_decoder.wasm`, `draco/draco_wasm_wrapper.js` | three.js r186, `examples/jsm/libs/draco/` (Google Draco) | Apache-2.0 |

## Fonts (vendored woff2 in `site/public/fonts/`)

| Family | File | Source | Designer | License |
|---|---|---|---|---|
| Archivo (variable, wdth 62–125, wght 100–900) | `archivo-var-latin.woff2` | https://fonts.google.com/specimen/Archivo | Omnibus-Type | SIL OFL 1.1 |
| Atkinson Hyperlegible Next (variable, wght 200–800) | `atkinson-next-var-latin.woff2` | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Next | Braille Institute of America / Applied Design Works | SIL OFL 1.1 |
| Atkinson Hyperlegible Mono (variable, wght 200–800) | `atkinson-mono-var-latin.woff2` | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Mono | Braille Institute of America / Applied Design Works | SIL OFL 1.1 |
