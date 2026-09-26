// Snapshot the real v1 walk from the library's src/decode.ts (repo root) into the site bundle (Listing 1).
// Re-run after library changes: node site/tools/listing.mjs (from app/).
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../../src/decode.ts', import.meta.url), 'utf8').split('\n');
const a = src.findIndex((l) => l.includes('if (bytes[0] === V1_VERSION_BYTE) {') && !l.includes('return'));
let b = src.findIndex((l, i) => i > a && l.includes('readAddresses(nAddr);'));
if (a < 0 || b < 0) throw new Error('anchor lines not found');
const out = { file: 'src/decode.ts', start: a + 1, end: b + 1, hot: a + 1, lines: src.slice(a, b + 1) };
fs.writeFileSync(new URL('../src/data/listing.json', import.meta.url), JSON.stringify(out));
console.log(`listing: ${out.file} lines ${out.start}-${out.end}`);
