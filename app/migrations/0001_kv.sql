-- The key-value table behind lib/store.mjs on Cloudflare (one row per key; value is the JSON text, at most 2 MB).
CREATE TABLE IF NOT EXISTS kv (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store, key)
);
