import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://faxbridge:faxbridge@localhost:5433/faxbridge';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Connects to PostgreSQL. If `schema` is given it is created and used as search_path (test isolation). */
export async function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, schema?: string): Promise<Db> {
  if (schema) {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await admin.end();
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await c.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      if (schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

export async function migrate(db: Db): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.tx(async (q) => {
      await q.exec(readFileSync(join(dir, f), 'utf8'));
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
  }
}
