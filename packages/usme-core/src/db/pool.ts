import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface PoolOptions {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
}

export function getPool(opts?: PoolOptions): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        opts?.connectionString ??
        process.env.DATABASE_URL ??
        "postgres://usme:usme_dev@localhost:5432/usme",
      max: opts?.max ?? 10,
      idleTimeoutMillis: opts?.idleTimeoutMillis ?? 30_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
