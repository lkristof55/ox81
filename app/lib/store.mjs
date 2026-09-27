// Key-value JSON store: Netlify Blobs on Netlify, Cloudflare D1 on Workers, a folder of JSON files locally.
// scripts/dev.mjs sets LOCAL_STORE_DIR=app/.data; tests can call useStoreDir(tmp). Unset on Netlify -> Blobs.
// worker.mjs calls useD1(env.DB) before any handler runs, which wins over the other two.
//   const s = await getStore('scans'); await s.setJSON('k', v); await s.get('k'); await s.list({ prefix: 'a/' })
const stores = new Map();
let baseDir = process.env.LOCAL_STORE_DIR || null;
let d1 = null;

export function useStoreDir(dir) { baseDir = dir; stores.clear(); }

/** Cloudflare: back every store with this D1 database (table kv, see migrations/0001_kv.sql). */
export function useD1(db) {
  if (db === d1) return;
  d1 = db || null;
  stores.clear();
}

/** D1 caps a row at 2,000,000 bytes; 1 KB of that is left for the store name, the key and the timestamp. */
export const D1_MAX_VALUE_BYTES = 2_000_000 - 1024;
const utf8 = new TextEncoder();

function d1Store(db, name) {
  return {
    async get(k) {
      const row = await db.prepare('SELECT value FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).first();
      return row ? JSON.parse(row.value) : null;
    },
    async setJSON(k, v) {
      const value = JSON.stringify(v);
      // Checked on the string first so the byte count only runs for values that could be near the cap.
      if (value.length * 3 > D1_MAX_VALUE_BYTES && utf8.encode(value).length > D1_MAX_VALUE_BYTES) {
        throw new Error(`store ${name}: value for ${k} is over the 2 MB D1 row limit`);
      }
      await db.prepare('INSERT INTO kv (store, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(name, k, value, Date.now()).run();
    },
    async delete(k) {
      await db.prepare('DELETE FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).run();
    },
    // Prefix match without LIKE, so % and _ in a prefix are plain characters. The range bound lets the primary key
    // index stop the scan; the substr check alone decides membership.
    async list({ prefix = '' } = {}) {
      let res;
      if (!prefix) {
        res = await db.prepare('SELECT key FROM kv WHERE store = ?1 ORDER BY key').bind(name).all();
      } else {
        const last = prefix.charCodeAt(prefix.length - 1);
        const upper = last < 0xd7ff ? prefix.slice(0, -1) + String.fromCharCode(last + 1) : null;
        res = upper
          ? await db.prepare('SELECT key FROM kv WHERE store = ?1 AND key >= ?2 AND key < ?3 AND substr(key, 1, length(?2)) = ?2 ORDER BY key').bind(name, prefix, upper).all()
          : await db.prepare('SELECT key FROM kv WHERE store = ?1 AND substr(key, 1, length(?2)) = ?2 ORDER BY key').bind(name, prefix).all();
      }
      return { blobs: (res.results || []).map((r) => ({ key: r.key })) };
    },
  };
}

function fileStore(dir) {
  const ready = (async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(dir, { recursive: true });
    return { fs, path };
  })();
  const file = async (k) => { const { path } = await ready; return path.join(dir, encodeURIComponent(k) + '.json'); };
  return {
    async get(k) { const { fs } = await ready; try { return JSON.parse(await fs.readFile(await file(k), 'utf8')); } catch { return null; } },
    async setJSON(k, v) { const { fs } = await ready; const f = await file(k); await fs.writeFile(f + '.tmp', JSON.stringify(v)); await fs.rename(f + '.tmp', f); },
    async delete(k) { const { fs } = await ready; await fs.rm(await file(k), { force: true }); },
    async list({ prefix = '' } = {}) {
      const { fs } = await ready;
      const names = await fs.readdir(dir);
      return { blobs: names.filter((n) => n.endsWith('.json')).map((n) => ({ key: decodeURIComponent(n.slice(0, -5)) })).filter((b) => b.key.startsWith(prefix)) };
    },
  };
}

export async function getStore(name) {
  if (stores.has(name)) return stores.get(name);
  let s;
  if (d1) {
    s = d1Store(d1, name);
  } else if (baseDir) {
    const path = await import('node:path');
    s = fileStore(path.join(baseDir, name));
  } else {
    const { getStore: blobs } = await import('@netlify/blobs');
    const b = blobs({ name, consistency: 'strong' });
    s = { get: (k) => b.get(k, { type: 'json' }), setJSON: (k, v) => b.setJSON(k, v), delete: (k) => b.delete(k), list: (o) => b.list(o) };
  }
  stores.set(name, s);
  return s;
}
