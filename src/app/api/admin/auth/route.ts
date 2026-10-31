import {
  ADMIN_KEY_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  adminSessionValue,
  isAdminAccessConfigured,
  isValidAdminKey,
} from "@/lib/admin/access";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Cookies must be marked Secure when the request came in over HTTPS. */
function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function sessionCookie(request: Request, value: string, maxAgeSeconds: number): string {
  return [
    `${ADMIN_KEY_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

/**
 * POST /api/admin/auth — validate the popup-entered admin key and, on success,
 * set an HttpOnly session cookie so subsequent pages/API calls stay unlocked.
 */
export async function POST(request: Request) {
  if (!isAdminAccessConfigured()) {
    // No key configured: nothing to unlock, keep the response harmless.
    return Response.json({ success: true, required: false }, { headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400, headers: NO_STORE });
  }

  const key = typeof (body as { key?: unknown } | null)?.key === "string" ? (body as { key: string }).key.trim() : "";

  if (!isValidAdminKey(key)) {
    // Small fixed delay: makes scripted brute-forcing of the shared key slower
    // without affecting a human who mistyped it once.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Response.json(
      { success: false, message: "کلید مدیریتی نامعتبر است. دوباره تلاش کنید." },
      { status: 401, headers: NO_STORE },
    );
  }

  const sessionValue = adminSessionValue();
  if (!sessionValue) {
    return Response.json({ success: true, required: false }, { headers: NO_STORE });
  }

  const headers = new Headers(NO_STORE);
  headers.append("Set-Cookie", sessionCookie(request, sessionValue, ADMIN_SESSION_MAX_AGE_SECONDS));

  return Response.json({ success: true, required: true }, { headers });
}

/** DELETE /api/admin/auth — lock this browser again. */
export async function DELETE(request: Request) {
  const headers = new Headers(NO_STORE);
  headers.append("Set-Cookie", sessionCookie(request, "", 0));
  return Response.json({ success: true }, { headers });
}
