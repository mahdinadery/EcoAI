import assert from "node:assert/strict";
import test from "node:test";

import { buildPoolOptions } from "../src/db/pool-config.ts";

test("plain URLs pass through untouched (no behavior change)", () => {
  const url = "postgres://user:pass@db.example.com:5432/app?sslmode=require";
  assert.deepEqual(buildPoolOptions(url), { connectionString: url });
});

test("hostaddr connects by raw IP while TLS still verifies the hostname", () => {
  const options = buildPoolOptions(
    "postgres://user:pass@db.example.com:5432/app?sslmode=require&hostaddr=1.2.3.4",
  );
  assert.equal(options.host, "1.2.3.4");
  assert.equal(options.user, "user");
  assert.equal(options.password, "pass");
  assert.equal(options.port, 5432);
  assert.equal(options.database, "app");
  assert.equal(options.connectionString, undefined, "the driver must not re-resolve the hostname");
  assert.deepEqual(options.ssl, { servername: "db.example.com", rejectUnauthorized: true });
});

test("sslservername overrides the TLS name; sslnoverify disables verification", () => {
  const options = buildPoolOptions(
    "postgres://u:p@tenant.internal/db?hostaddr=10.0.0.9&sslservername=db.public.com&sslnoverify=1",
  );
  assert.equal(options.host, "10.0.0.9");
  assert.deepEqual(options.ssl, { servername: "db.public.com", rejectUnauthorized: false });
  // Custom params never leak into the connection string.
  assert.equal(options.connectionString, undefined);
});

test("sslnoverify alone keeps DNS but relaxes TLS (self-signed test DBs)", () => {
  const options = buildPoolOptions("postgres://u:p@db.example.com/app?sslnoverify=1");
  assert.equal(options.host, "db.example.com");
  assert.deepEqual(options.ssl, { servername: "db.example.com", rejectUnauthorized: false });
});

test("sslmode=disable is honored in hostaddr mode (no ssl block)", () => {
  const options = buildPoolOptions("postgres://u:p@db.example.com/app?sslmode=disable&hostaddr=1.2.3.4");
  assert.equal(options.host, "1.2.3.4");
  assert.equal(options.ssl, undefined);
});

test("percent-encoded credentials are decoded; default port applies", () => {
  const options = buildPoolOptions("postgres://user:p%40ss@db.example.com/app?hostaddr=1.2.3.4");
  assert.equal(options.password, "p@ss");
  assert.equal(options.port, 5432);
});
