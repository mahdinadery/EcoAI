import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { buildPoolOptions } from "./pool-config";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    // Supports the libpq-style `hostaddr=` workaround (connect by raw IP when
    // the server cannot resolve the DB hostname — see src/db/pool-config.ts).
    ...buildPoolOptions(databaseUrl),
    max: 5,
    // Fail fast instead of hanging the build/healthcheck if Postgres is slow or unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);

export const isNextProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
