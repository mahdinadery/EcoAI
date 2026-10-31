import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_KEY_COOKIE,
  adminSessionValue,
  checkAdminAccess,
  isAdminAccessConfigured,
  isValidAdminKey,
  isValidAdminSession,
  readCookieValue,
} from "../src/lib/admin/access.ts";

const KEY = "test-admin-key-123";

function withKey(value, fn) {
  const previous = process.env.ADMIN_ACCESS_KEY;
  if (value === undefined) delete process.env.ADMIN_ACCESS_KEY;
  else process.env.ADMIN_ACCESS_KEY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_ACCESS_KEY;
    else process.env.ADMIN_ACCESS_KEY = previous;
  }
}

function makeRequest({ url = "https://example.com/api/admin/news-sources", header, cookie } = {}) {
  const headers = new Headers();
  if (header !== undefined) headers.set("x-admin-key", header);
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(url, { headers });
}

test("gate is open when ADMIN_ACCESS_KEY is not configured", () => {
  withKey(undefined, () => {
    assert.equal(isAdminAccessConfigured(), false);
    assert.equal(checkAdminAccess(makeRequest()).authorized, true);
    assert.equal(adminSessionValue(), null);
    assert.equal(isValidAdminSession("anything"), true);
  });
});

test("configured gate rejects requests without a credential", () => {
  withKey(KEY, () => {
    assert.equal(isAdminAccessConfigured(), true);
    const check = checkAdminAccess(makeRequest());
    assert.equal(check.authorized, false);
    assert.match(check.reason, /کلید مدیریتی/);
  });
});

test("header and query credentials are accepted", () => {
  withKey(KEY, () => {
    assert.equal(checkAdminAccess(makeRequest({ header: KEY })).authorized, true);
    assert.equal(checkAdminAccess(makeRequest({ url: `https://example.com/admin/news?key=${KEY}` })).authorized, true);
    assert.equal(checkAdminAccess(makeRequest({ header: `  ${KEY}  ` })).authorized, true);
  });
});

test("invalid or empty credentials are rejected", () => {
  withKey(KEY, () => {
    assert.equal(isValidAdminKey("wrong"), false);
    assert.equal(isValidAdminKey(""), false);
    assert.equal(isValidAdminKey(null), false);
    assert.equal(checkAdminAccess(makeRequest({ header: "wrong" })).authorized, false);
    assert.equal(checkAdminAccess(makeRequest({ url: "https://example.com/admin/news?key=wrong" })).authorized, false);
  });
});

test("popup session cookie is accepted, while the raw key is not a valid cookie", () => {
  withKey(KEY, () => {
    const session = adminSessionValue();
    assert.ok(session);
    assert.notEqual(session, KEY);

    const cookie = `${ADMIN_KEY_COOKIE}=${session}`;
    assert.equal(checkAdminAccess(makeRequest({ cookie })).authorized, true);

    // Storing the raw key in the cookie must NOT unlock the gate.
    assert.equal(checkAdminAccess(makeRequest({ cookie: `${ADMIN_KEY_COOKIE}=${KEY}` })).authorized, false);
  });
});

test("a stale query key does not lock out an already-authenticated browser", () => {
  withKey(KEY, () => {
    const session = adminSessionValue();
    const request = makeRequest({
      url: "https://example.com/admin/news?key=stale-wrong-value",
      cookie: `${ADMIN_KEY_COOKIE}=${session}`,
    });
    assert.equal(checkAdminAccess(request).authorized, true);
  });
});

test("rotating ADMIN_ACCESS_KEY revokes existing sessions", () => {
  const oldSession = withKey(KEY, () => adminSessionValue());
  withKey("a-different-key", () => {
    assert.equal(isValidAdminSession(oldSession), false);
  });
});

test("readCookieValue finds the cookie among others and decodes values", () => {
  const header = "theme=dark; nia_admin_key=abc123; other=1";
  assert.equal(readCookieValue(header, "nia_admin_key"), "abc123");
  assert.equal(readCookieValue(header, "missing"), undefined);
  assert.equal(readCookieValue(undefined, "nia_admin_key"), undefined);
  assert.equal(readCookieValue("x=a%20b", "x"), "a b");
});
