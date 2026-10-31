/**
 * Admin access gate — SERVER-SIDE ONLY.
 *
 * IMPORTANT / KNOWN LIMITATION: this codebase has no full authentication
 * system (no users table, no password login). Building one is out of scope for
 * this milestone, so the admin area is gated by a shared `ADMIN_ACCESS_KEY`
 * environment variable:
 *
 *   - If ADMIN_ACCESS_KEY is NOT set, the admin area stays open (so the app is
 *     usable out of the box) but admin pages show a visible warning banner.
 *   - If ADMIN_ACCESS_KEY IS set, access can be granted in three ways:
 *       1. `x-admin-key` header (scripts / GitHub Actions),
 *       2. `?key=` query parameter (bookmarkable links),
 *       3. a `nia_admin_key` HttpOnly cookie set by the admin-key popup at
 *          `/api/admin/auth`. The cookie holds an HMAC derived from the key —
 *          never the key itself — so rotating ADMIN_ACCESS_KEY also revokes
 *          every existing browser session.
 *
 * Cookie sessions keep the key out of the address bar after the popup login,
 * and let admin links / API calls keep working without re-entering the key on
 * every page. When real authentication is added, replace this module's checks
 * with the real session/role check — every call site goes through here.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_KEY_HEADER = "x-admin-key";
export const ADMIN_KEY_QUERY_PARAM = "key";
export const ADMIN_KEY_COOKIE = "nia_admin_key";

/** How long a browser stays unlocked after entering the key in the popup. */
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const ADMIN_SESSION_CONTEXT = "news-intelligence-agent:admin-session:v1";

export type AdminAccessCheck = { authorized: true } | { authorized: false; reason: string };

export function isAdminAccessConfigured(): boolean {
  return Boolean(process.env.ADMIN_ACCESS_KEY?.trim());
}

function requiredAdminKey(): string | undefined {
  return process.env.ADMIN_ACCESS_KEY?.trim() || undefined;
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the
 * comparison never leaks the expected key's length.
 */
function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** True when `candidate` is the configured ADMIN_ACCESS_KEY. */
export function isValidAdminKey(candidate: string | null | undefined): boolean {
  const requiredKey = requiredAdminKey();
  if (!requiredKey) return true; // Gate disabled.
  const value = candidate?.trim();
  if (!value) return false;
  return safeEqual(value, requiredKey);
}

/**
 * Opaque value stored in the session cookie. It is an HMAC of a fixed string
 * keyed by ADMIN_ACCESS_KEY: verifiable by the server, useless to anyone who
 * only sees the cookie, and invalidated automatically when the key rotates.
 */
export function adminSessionValue(): string | null {
  const key = requiredAdminKey();
  if (!key) return null;
  return createHmac("sha256", key).update(ADMIN_SESSION_CONTEXT).digest("base64url");
}

/** True when `candidate` is a valid session cookie value for the current key. */
export function isValidAdminSession(candidate: string | null | undefined): boolean {
  const expected = adminSessionValue();
  if (!expected) return true; // Gate disabled.
  const value = candidate?.trim();
  if (!value) return false;
  return safeEqual(value, expected);
}

/** Minimal cookie-header parser (avoids pulling a dependency for one lookup). */
export function readCookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return undefined;
}

function readCredential(request: Request): { headerKey?: string; queryKey?: string; cookieValue?: string } {
  const url = new URL(request.url);
  return {
    headerKey: request.headers.get(ADMIN_KEY_HEADER)?.trim() || undefined,
    queryKey: url.searchParams.get(ADMIN_KEY_QUERY_PARAM)?.trim() || undefined,
    cookieValue: readCookieValue(request.headers.get("cookie"), ADMIN_KEY_COOKIE)?.trim() || undefined,
  };
}

export function checkAdminAccess(request: Request): AdminAccessCheck {
  if (!isAdminAccessConfigured()) {
    // No key configured: open access (documented limitation, see module docstring).
    return { authorized: true };
  }

  const { headerKey, queryKey, cookieValue } = readCredential(request);

  // Any one valid credential is enough. In particular, a stale/wrong `?key=`
  // in the URL must not lock out a browser that already has a valid cookie.
  if (isValidAdminKey(headerKey) || isValidAdminKey(queryKey) || isValidAdminSession(cookieValue)) {
    return { authorized: true };
  }

  return { authorized: false, reason: "دسترسی غیرمجاز: کلید مدیریتی نامعتبر یا وارد نشده است." };
}
