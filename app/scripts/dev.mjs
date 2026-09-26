// Local server for the app: the built site plus every Netlify function, the same code that runs in production.
//
//   npm run dev                                   (= node scripts/dev.mjs --port 8888)
//   node scripts/dev.mjs [--port 8888] [--watch] [--cron]
//
// - Static files come from site/dist (run `npm run build` first; --watch rebuilds on change).
// - Each netlify/functions/*.mjs (or <name>/index.mjs) is a Netlify Functions v2 handler:
//     export default async (req, context) => Response
//     export const config = { path: '/api/thing/:id' }     (string or array; default /.netlify/functions/<name>)
//   context has { params, ip, geo, site, waitUntil, cookies }.
// - Env: app/.env (see .env.example) without overriding variables already set in the shell.
//   LOCAL_STORE_DIR=app/.data, which lib/store.mjs uses instead of Netlify Blobs.
// - --cron runs every function that exports config.schedule once at start and then once a minute.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_DIR, build } from './build.mjs';

const argv = process.argv.slice(2);
const port = Number((argv.includes('--port') && argv[argv.indexOf('--port') + 1]) || process.env.PORT || 8888);
const watch = argv.includes('--watch');
const cron = argv.includes('--cron');
const dir = APP_DIR;

/** Load KEY=VALUE lines into process.env without overriding what is already set. */
async function loadEnv(file) {
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

await loadEnv(path.join(dir, '.env'));
process.env.LOCAL_STORE_DIR ||= path.join(dir, '.data');
process.env.URL ||= `http://localhost:${port}`;

/** '/api/thing/:id' or '/api/files/*' -> matcher returning the named params, or null. */
function pathMatcher(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.split('/').map((seg) => {
    if (seg === '*') { names.push('0'); return '(.*)'; }
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/') + '/?$');
  return { pathname: pattern, exec: (p) => { const m = re.exec(p); return m ? Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) : null; } };
}

async function loadFunctions() {
  const fdir = path.join(dir, 'netlify', 'functions');
  const out = [];
  let names = [];
  try { names = await fs.readdir(fdir); } catch { return out; }
  for (const n of names) {
    let file = path.join(fdir, n);
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.mjs');
    else if (!/\.(mjs|js)$/.test(n)) continue;
    const name = path.basename(n).replace(/\.(mjs|js)$/, '');
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const cfg = mod.config || {};
      const paths = cfg.path ? [].concat(cfg.path) : [`/.netlify/functions/${name}`];
      out.push({ name, handler: mod.default, schedule: cfg.schedule, patterns: paths.map(pathMatcher) });
    } catch (e) {
      console.error(`function ${name} failed to load: ${e.stack || e.message}`);
    }
  }
  return out;
}

let fns = await loadFunctions();
if (watch) {
  await build(dir, { watch: true, log: (m) => console.log(`[build] ${m}`) });
  let t;
  fs.watch(path.join(dir, 'netlify', 'functions'), { recursive: true }, () => { clearTimeout(t); t = setTimeout(async () => { fns = await loadFunctions(); console.log('[functions] reloaded'); }, 200); });
}

// ---------------------------------------------------------------- static files (site/dist)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.ktx2': 'image/ktx2',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glsl': 'text/plain',
};
const root = path.join(dir, 'site', 'dist');

async function resolveFile(pathname) {
  const rel = decodeURIComponent(pathname);
  const f = path.resolve(root, '.' + path.sep + rel);
  if (f !== root && !f.startsWith(root + path.sep)) return null; // no ../ escapes
  const candidates = [f];
  if (pathname.endsWith('/')) candidates.unshift(path.join(f, 'index.html'));
  else if (!path.extname(f)) candidates.push(f + '.html', path.join(f, 'index.html'));
  for (const c of candidates) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch {}
  }
  return null;
}

async function readBody(req) {
  if (['GET', 'HEAD'].includes(req.method)) return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function handleFunction(req, res, url) {
  for (const f of fns) {
    for (const p of f.patterns) {
      const params = p.exec(url.pathname);
      if (!params) continue;
      const started = Date.now();
      const request = new Request(url, { method: req.method, headers: req.headers, body: await readBody(req), duplex: 'half' });
      const waits = [];
      const context = {
        params, ip: req.socket.remoteAddress, geo: {}, site: { url: process.env.URL },
        waitUntil: (w) => waits.push(w), cookies: { get: () => undefined, set() {}, delete() {} },
      };
      let r;
      try {
        r = await f.handler(request, context);
        if (!(r instanceof Response)) r = Response.json(r ?? null);
      } catch (e) {
        console.error(`[${f.name}] ${e.stack || e.message}`);
        r = Response.json({ error: 'function crashed' }, { status: 500 });
      }
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      Promise.allSettled(waits);
      console.log(`${req.method} ${url.pathname}${url.search} → ${r.status} ${Date.now() - started}ms [${f.name}]`);
      return true;
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (await handleFunction(req, res, url)) return;
    const f = await resolveFile(url.pathname);
    if (!f) {
      const fallback = await resolveFile('/404.html');
      res.writeHead(404, { 'content-type': fallback ? TYPES['.html'] : 'text/plain' });
      return res.end(fallback ? await fs.readFile(fallback) : 'not found: ' + url.pathname);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await fs.readFile(f));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error: ' + e.message);
  }
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });

try { await fs.access(path.join(root, 'index.html')); } catch { console.warn('site/dist/index.html is missing: run `npm run build` first (or use --watch)'); }

if (cron) {
  const tick = async () => {
    for (const f of fns.filter((f) => f.schedule)) {
      try { await f.handler(new Request(`${process.env.URL}/.netlify/functions/${f.name}`, { method: 'POST', body: JSON.stringify({ next_run: null }) }), {}); console.log(`[cron] ${f.name} ok`); }
      catch (e) { console.error(`[cron] ${f.name}: ${e.message}`); }
    }
  };
  tick();
  setInterval(tick, 60_000);
}

const routes = fns.flatMap((f) => f.patterns.map((p) => `${p.pathname} [${f.name}]${f.schedule ? ` schedule ${f.schedule}` : ''}`));
console.log(`ox81 app on http://localhost:${port}${routes.length ? '\n  ' + routes.join('\n  ') : ''}`);
if (!process.env.HELIUS_API_KEY && !process.env.SOLANA_RPC_URL) console.warn('no HELIUS_API_KEY or SOLANA_RPC_URL: /api/census, /api/featured and GET /api/xray will answer 502 (copy .env.example to .env)');
