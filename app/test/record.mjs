// Records the offline fixtures once from mainnet (read-only; ~3 Helius credits):
//   node test/record.mjs          (from app/; needs HELIUS_API_KEY or SOLANA_RPC_URL in the env or app/.env)
// Delegates to the library's own recorder (scripts/record.ts at the repo root), which writes test/fixtures/*.json
// at the repo root. The backend tests in app/test/*.test.mjs read those same fixtures.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(app, '..');
if (!process.env.HELIUS_API_KEY && !process.env.SOLANA_RPC_URL) {
  try {
    for (const line of readFileSync(join(app, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
const url = process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
if (!url) { console.error('set HELIUS_API_KEY or SOLANA_RPC_URL (env or app/.env)'); process.exit(1); }
const r = spawnSync(process.execPath, ['scripts/record.ts'], { cwd: repo, stdio: 'inherit', env: { ...process.env, OX81_RPC_URL: url } });
process.exit(r.status ?? 1);
