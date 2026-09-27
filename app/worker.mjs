// Cloudflare Workers entry (wrangler.jsonc). Runs the same Netlify Functions v2 handlers as Netlify:
//   fetch()      each function's config.path -> its default export (req, context); everything else -> static assets
//   scheduled()  the scheduled function (census-cron, config.schedule = the cron in wrangler.jsonc)
// The store is D1 (env.DB) and the endpoints only read it; the cron is the only writer.
import * as censusCron from './netlify/functions/census-cron.mjs';
import * as census from './netlify/functions/census.mjs';
import * as featured from './netlify/functions/featured.mjs';
import * as health from './netlify/functions/health.mjs';
import * as xray from './netlify/functions/xray.mjs';
import { serveStoredOnly } from './lib/snapshot.mjs';
import { useD1 } from './lib/store.mjs';

/** '/api/thing/:id' or '/api/files/*' -> pathname -> params or null (a trailing slash is allowed, as in scripts/dev.mjs). */
function pathMatcher(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.split('/').map((seg) => {
    if (seg === '*') { names.push('0'); return '(.*)'; }
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/') + '/?$');
  return (p) => { const m = re.exec(p); return m ? Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) : null; };
}

export const ROUTES = [xray, census, featured, health].flatMap((mod) =>
  [].concat(mod.config.path).map((path) => ({ path, match: pathMatcher(path), handler: mod.default })));
export const SCHEDULED = [censusCron].filter((mod) => mod.config?.schedule);

function setup(env) {
  useD1(env.DB);
  serveStoredOnly();
}

/** The parts of the Netlify context the functions use. */
function context(request, ctx, params) {
  return {
    params,
    ip: request.headers.get('cf-connecting-ip') || undefined,
    site: { url: new URL(request.url).origin },
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

export default {
  async fetch(request, env, ctx) {
    setup(env);
    const { pathname } = new URL(request.url);
    for (const r of ROUTES) {
      const params = r.match(pathname);
      if (!params) continue;
      try {
        return await r.handler(request, context(request, ctx, params));
      } catch (e) {
        console.error(`${r.path}: ${e.stack || e.message}`);
        return Response.json({ error: 'function crashed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    setup(env);
    const request = new Request('https://scheduled.invalid/');
    for (const mod of SCHEDULED) await mod.default(request, context(request, ctx, {}));
  },
};
