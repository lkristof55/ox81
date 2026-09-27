// In-memory stand-in for a Cloudflare D1 binding, for the offline tests: D1's prepare().bind().first()/all()/run()
// and batch() on Node's built-in SQLite (D1 is SQLite too), with migrations/0001_kv.sql applied. No dependencies.
// `stats` counts queries and rows the way the D1 limits do (per query, rows returned or changed).
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATION = readFileSync(new URL('../migrations/0001_kv.sql', import.meta.url), 'utf8');

export function fakeD1({ migrate = true } = {}) {
  const db = new DatabaseSync(':memory:');
  if (migrate) db.exec(MIGRATION);
  const stats = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const plain = (row) => (row ? { ...row } : row);
  const statement = (sql, args = []) => ({
    bind: (...a) => {
      if (a.some((v) => v === undefined)) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
      return statement(sql, a);
    },
    async first(column) {
      stats.queries++;
      const row = plain(db.prepare(sql).get(...args));
      if (row) stats.rowsRead++;
      if (!row) return null;
      return column === undefined ? row : row[column] ?? null;
    },
    async all() {
      stats.queries++;
      const results = db.prepare(sql).all(...args).map(plain);
      stats.rowsRead += results.length;
      return { success: true, results, meta: { rows_read: results.length, rows_written: 0 } };
    },
    async run() {
      stats.queries++;
      const r = db.prepare(sql).run(...args);
      stats.rowsWritten += Number(r.changes);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_written: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
    stats,
    sqlite: db,
  };
}
