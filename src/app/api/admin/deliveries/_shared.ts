import { checkAdminAccess } from "@/lib/admin/access";
import type { DeliveryMutationResult } from "@/lib/delivery/publishing";

/**
 * Shared plumbing for the admin delivery action routes: one place that applies
 * the existing admin gate, resolves the dynamic id, runs the action and maps the
 * result to a response. Keeps every action endpoint thin and consistent.
 *
 * Actor is a constant label because the project still has no per-user auth
 * (see src/lib/admin/access.ts); it exists so the audit trail is complete and
 * can carry real identities once auth lands.
 */
export const ADMIN_ACTOR = "admin";

export type RouteContext = { params: Promise<{ id: string }> | { id: string } };

export async function resolveId(routeContext: RouteContext): Promise<string> {
  const resolved = "then" in routeContext.params ? await routeContext.params : routeContext.params;
  return resolved.id;
}

export function accessDenied(request: Request): Response | null {
  const access = checkAdminAccess(request);
  if (access.authorized) return null;
  return Response.json({ success: false, message: access.reason }, { status: 401 });
}

export function toResponse(result: DeliveryMutationResult, okText?: string): Response {
  if (result.ok) {
    return Response.json({
      success: true,
      deliveryId: result.deliveryId,
      status: result.status,
      message: result.message ?? okText ?? "عملیات با موفقیت انجام شد.",
    });
  }

  const status =
    result.code === "not_found"
      ? 404
      : result.code === "db_error" || result.code === "send_failed" || result.code === "in_flight"
        ? 502
        : 400;

  return Response.json({ success: false, code: result.code, message: result.message, detail: result.detail ?? null }, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}
