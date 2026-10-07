// Minimal database interface shared by the core service.
//
// Two adapters implement it: Cloudflare D1 in production and node:sqlite for
// local tests. D1 has no interactive transactions — `batch()` is its only
// atomic unit — so the core expresses every mutation as a list of statements
// executed in one batch, and reads happen separately. Keep SQL portable
// (no D1- or SQLite-only syntax beyond what both accept).

export type Param = string | number | null;

export interface Stmt {
  sql: string;
  params?: Param[];
}

export interface Db {
  /** Run a read query; returns all rows. */
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  /** Run a read query; returns the first row or null. */
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
  /** Run one write statement. */
  run(sql: string, params?: Param[]): Promise<void>;
  /** Run several write statements atomically. */
  batch(stmts: Stmt[]): Promise<void>;
  /** Execute a multi-statement SQL script (migrations). */
  exec(script: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cloudflare D1
// ---------------------------------------------------------------------------

export function d1Db(d1: D1Database): Db {
  return {
    async all<T>(sql: string, params: Param[] = []) {
      const { results } = await d1.prepare(sql).bind(...params).all<T>();
      return results;
    },
    async get<T>(sql: string, params: Param[] = []) {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? null;
    },
    async run(sql, params = []) {
      await d1.prepare(sql).bind(...params).run();
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))));
    },
    async exec(script) {
      await d1.exec(script);
    },
  };
}

// ---------------------------------------------------------------------------
// node:sqlite (tests, local scripts)
// ---------------------------------------------------------------------------

/** Build a Db over a node:sqlite DatabaseSync. Imported lazily so the Worker bundle never sees node:sqlite. */
export async function sqliteDb(path = ":memory:"): Promise<Db & { close(): void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return {
    async all<T>(sql: string, params: Param[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: Param[] = []) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      db.exec("BEGIN");
      try {
        for (const s of stmts) db.prepare(s.sql).run(...(s.params ?? []));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(script) {
      db.exec(script);
    },
    close() {
      db.close();
    },
  };
}
