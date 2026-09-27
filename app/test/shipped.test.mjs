// Guard for everything the app ships: the site data, the site sources and public files, the backend code and the
// recorded fixtures the tests read. Fails on social handles, profile links, keys or key-shaped query strings.
// Base64 strings (raw transaction bytes) are decoded and their printable runs are checked too, because memo and
// instruction data can carry text.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Read before any other module can touch the env; values are only compared, never printed.
const SECRETS = ['HELIUS_API_KEY', 'BIRDEYE_API_KEY'].map((k) => process.env[k]).filter((v) => v && v.length >= 12);

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(APP, '..');
const TEXT = new Set(['.mjs', '.js', '.json', '.html', '.css', '.md', '.svg', '.glsl', '.example', '']);
const SKIP = new Set(['node_modules', 'dist', '.data', '.git', '.netlify', '.wrangler']);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (TEXT.has(extname(n)) && n !== 'package-lock.json') out.push(f);
  }
  return out;
}

const files = [...walk(APP), ...readdirSync(join(REPO, 'test', 'fixtures')).map((n) => join(REPO, 'test', 'fixtures', n))];

// Handles that may appear: package scopes and CSS at-rules, never people.
const AT_OK = /^@(solana|netlify|esbuild|types|media|font-face|keyframes|import|supports|layer|property|container|page|charset|vercel|wallet-standard)(?![A-Za-z0-9_-])/i;
const HANDLE = /(?:^|[\s"'`(>])(@[A-Za-z0-9_][A-Za-z0-9_-]{2,38})(?![A-Za-z0-9_-])/g;
const PROFILE = /\b(?:x\.com|twitter\.com|t\.me|discord\.gg|instagram\.com|tiktok\.com|youtube\.com)\/@?[A-Za-z0-9_]{2,}/gi;
const GITHUB = /github\.com\/([A-Za-z0-9-]+)/gi;
const KEYISH = /api[-_]?key=(?!\$\{|<redacted>|\.\.\.)[A-Za-z0-9-]{8,}/gi;

function printableRuns(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const runs = [];
  let cur = '';
  for (const c of bytes) {
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else { if (cur.length >= 6) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 6) runs.push(cur);
  return runs;
}

function base64Strings(v, out = []) {
  if (typeof v === 'string') { if (v.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)) out.push(v); }
  else if (Array.isArray(v)) for (const x of v) base64Strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) base64Strings(x, out);
  return out;
}

test('shipped files carry no handles, profile links or keys', () => {
  const hits = [];
  for (const f of files) {
    const rel = relative(REPO, f);
    const text = readFileSync(f, 'utf8');
    for (const s of SECRETS) if (text.includes(s)) hits.push(`${rel}: contains the value of an API key from the env`);
    for (const m of text.matchAll(KEYISH)) hits.push(`${rel}: key-shaped query ${m[0].slice(0, 12)}…`);
    for (const m of text.matchAll(PROFILE)) hits.push(`${rel}: profile link ${m[0]}`);
    for (const m of text.matchAll(GITHUB)) if (m[1].toLowerCase() !== 'lkristof55') hits.push(`${rel}: github account ${m[1]}`);
    if (!rel.includes('fixtures')) for (const m of text.matchAll(HANDLE)) if (!AT_OK.test(m[1])) hits.push(`${rel}: handle ${m[1]}`);
    if (f.endsWith('.json')) {
      for (const b64 of base64Strings(JSON.parse(text))) {
        for (const run of printableRuns(b64)) {
          if (/https?:|www\.|x\.com\/|t\.me\/|twitter|discord/i.test(run)) hits.push(`${rel}: link inside base64 bytes: ${run.slice(0, 40)}`);
          for (const s of SECRETS) if (run.includes(s)) hits.push(`${rel}: an API key inside base64 bytes`);
        }
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('the scan actually covers the site data and the recorded transactions', () => {
  const rels = files.map((f) => relative(REPO, f));
  for (const must of ['app/site/src/data/recorded.json', 'app/lib/sources.mjs', 'app/netlify/functions/xray.mjs', 'test/fixtures/block-450355468.json']) {
    assert.ok(rels.includes(must), `${must} not scanned`);
  }
  const recorded = JSON.parse(readFileSync(join(APP, 'site/src/data/recorded.json'), 'utf8'));
  assert.ok(base64Strings(recorded).length >= 4, 'recorded.json raw transactions not decoded');
});
