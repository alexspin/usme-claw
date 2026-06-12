/**
 * Database connection resolution for the CLI.
 *
 * Precedence: --database-url flag > DATABASE_URL env > dev default
 * (the same default used by @usme/core's getPool and the OpenClaw plugin).
 *
 * Read-only: the CLI only ever issues SELECT queries (and reuses the core
 * assemble pipeline, which never writes). No command mutates the database.
 */

import type pg from "pg";
import { getPool } from "@usme/core";

const DEV_DEFAULT = "postgres://usme:usme_dev@localhost:5432/usme";

export interface ResolvedDb {
  pool: pg.Pool;
  connectionString: string;
  source: "flag" | "env" | "default";
}

export function resolveDb(databaseUrlFlag?: string): ResolvedDb {
  let connectionString: string;
  let source: ResolvedDb["source"];

  if (databaseUrlFlag) {
    connectionString = databaseUrlFlag;
    source = "flag";
  } else if (process.env.DATABASE_URL) {
    connectionString = process.env.DATABASE_URL;
    source = "env";
  } else {
    connectionString = DEV_DEFAULT;
    source = "default";
  }

  const pool = getPool({ connectionString });
  return { pool, connectionString, source };
}

/** Redact credentials from a connection string for safe display. */
export function redactConnString(conn: string): string {
  return conn.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
}
