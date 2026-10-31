/**
 * Cookie-aware access check for admin *pages* (server components).
 *
 * Kept separate from `access.ts` so that API routes can import the pure
 * Request-based helpers without pulling in `next/headers`.
 */

import { cookies } from "next/headers";
import {
  ADMIN_KEY_COOKIE,
  isAdminAccessConfigured,
  isValidAdminKey,
  isValidAdminSession,
} from "./access";

export type AdminAuthorizedVia = "open" | "query" | "cookie" | "none";

export type AdminPageAccess = {
  /** Whether ADMIN_ACCESS_KEY is set on the server. */
  gateConfigured: boolean;
  authorized: boolean;
  /** How the visitor got in; used to decide whether to sync `?key=` to a cookie. */
  authorizedVia: AdminAuthorizedVia;
  /** Trimmed, potentially-wrong key from the query string (for prop passing). */
  queryKey: string | null;
};

export async function getAdminPageAccess(rawQueryKey?: string | string[] | null): Promise<AdminPageAccess> {
  if (!isAdminAccessConfigured()) {
    return { gateConfigured: false, authorized: true, authorizedVia: "open", queryKey: null };
  }

  const raw = Array.isArray(rawQueryKey) ? rawQueryKey[0] : rawQueryKey;
  const queryKey = raw?.trim() || null;

  if (isValidAdminKey(queryKey)) {
    return { gateConfigured: true, authorized: true, authorizedVia: "query", queryKey };
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ADMIN_KEY_COOKIE)?.value?.trim() || null;

  if (isValidAdminSession(cookieValue)) {
    return { gateConfigured: true, authorized: true, authorizedVia: "cookie", queryKey };
  }

  return { gateConfigured: true, authorized: false, authorizedVia: "none", queryKey };
}

/** The key to hand to client components; only needed until the cookie is set. */
export function adminKeyForClient(access: AdminPageAccess): string {
  return access.authorizedVia === "query" ? access.queryKey ?? "" : "";
}
