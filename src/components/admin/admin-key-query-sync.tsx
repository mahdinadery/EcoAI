"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * When an admin page was opened with a valid `?key=...`, exchange it for the
 * HttpOnly session cookie and strip it from the address bar. This keeps
 * bookmarked links working while preventing the key from lingering in history,
 * screenshots and shared URLs.
 */
export function AdminKeyQuerySync({ adminKey }: { adminKey: string }) {
  const router = useRouter();
  const syncedRef = useRef(false);

  useEffect(() => {
    if (!adminKey || syncedRef.current) return;
    syncedRef.current = true;

    fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: adminKey }),
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) {
          syncedRef.current = false;
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("key");
        router.replace(`${url.pathname}${url.search}${url.hash}`);
      })
      .catch(() => {
        syncedRef.current = false;
      });
  }, [adminKey, router]);

  return null;
}
