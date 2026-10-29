/**
 * Pool/connection options builder — PURE (no imports; test-importable by the
 * node runner AND importable from scripts/db-ensure.mjs).
 *
 * Solves the Iran-hosted deployment failure mode: the app server cannot
 * RESOLVE the foreign Postgres hostname (`getaddrinfo ENOTFOUND`), so every
 * DB-backed section of the UI dies. libpq has always supported connecting by
 * raw IP while keeping TLS verification against the hostname (`hostaddr`);
 * node-postgres does not parse that parameter — this module does.
 *
 * Supported URL query parameters (stripped before the driver sees them):
 *   hostaddr=1.2.3.4         connect to this IP — no DNS lookup at all
 *   sslservername=db.host    TLS/SNI name to verify (default: the URL hostname)
 *   sslnoverify=1            accept unverifiable certs (self-signed test DBs)
 *
 * When none of these are present the URL is passed through untouched, so
 * existing deployments behave exactly as before.
 */

export type DbPoolOptions = {
  connectionString?: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  database?: string;
  ssl?: { servername: string; rejectUnauthorized: boolean };
};

function isTruthyFlag(value: string | null): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function buildPoolOptions(databaseUrl: string): DbPoolOptions {
  const parsed = new URL(databaseUrl);
  const hostaddr = parsed.searchParams.get("hostaddr")?.trim() ?? "";
  const sslServername = parsed.searchParams.get("sslservername")?.trim() || parsed.hostname;
  const sslNoVerify = isTruthyFlag(parsed.searchParams.get("sslnoverify"));
  const custom = Boolean(hostaddr) || parsed.searchParams.has("sslservername") || parsed.searchParams.has("sslnoverify");

  if (!custom) {
    // No workaround requested — pass the original URL through untouched.
    return { connectionString: databaseUrl };
  }

  parsed.searchParams.delete("hostaddr");
  parsed.searchParams.delete("sslservername");
  parsed.searchParams.delete("sslnoverify");

  const sslmode = (parsed.searchParams.get("sslmode") ?? "").trim().toLowerCase();
  const options: DbPoolOptions = {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: hostaddr || parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
  if (sslmode !== "disable") {
    options.ssl = { servername: sslServername, rejectUnauthorized: !sslNoVerify };
  }
  return options;
}
