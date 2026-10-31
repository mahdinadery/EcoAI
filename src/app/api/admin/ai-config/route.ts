import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { isAiConfigured, resolveEffectiveModel } from "@/lib/ai/client";
import { createAiConfigVersion, getActiveAiConfig, validateAiConfigInput } from "@/lib/ai/config-service";
import type { AiConfigInput } from "@/lib/ai/config-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/ai-config
 *
 * Returns the currently active AI configuration. Creates the default
 * configuration automatically the first time this is called, so existing AI
 * analysis behavior is preserved even if nobody has opened the admin page yet.
 * Never returns API secrets (there are none in this table — only prompt/model
 * name/thresholds/schema, all non-secret operational data).
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  // If the database predates this table (typical on hosts that never run
  // `db:ensure`, e.g. Vercel), repair the schema once and retry transparently.
  const outcome = await runWithSchemaRepair(() => getActiveAiConfig());

  if (outcome.ok) {
    const config = outcome.value;
    return Response.json({
      success: true,
      config,
      // Non-secret operational status: whether AI_API_KEY is set, and which
      // model will actually be used given the config + env fallback chain.
      aiKeyConfigured: isAiConfigured(),
      effectiveModel: resolveEffectiveModel(config.model),
      // Lets the UI confirm that it self-healed on this request.
      schemaSynced: outcome.schemaSynced,
    });
  }

  console.error("[ai-config] failed to load active config:", String(outcome.error).slice(0, 200));
  return dbErrorResponse(
    outcome.error,
    outcome.repair && !outcome.repair.ok
      ? "خطا در بارگذاری پیکربندی هوش مصنوعی از پایگاه داده (همگام‌سازی خودکار اسکیما هم ناموفق بود)."
      : "خطا در بارگذاری پیکربندی هوش مصنوعی از پایگاه داده.",
    outcome.repair,
  );
}

type SaveBody = AiConfigInput & { activate?: boolean };

/**
 * POST /api/admin/ai-config
 *
 * Saves a NEW version of the configuration (append-only history — the previous
 * version is preserved, never overwritten). `activate` defaults to true
 * ("Save & Activate"); pass `activate: false` to save a draft without making it
 * live ("Save Configuration").
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  const input: AiConfigInput = {
    name: body.name,
    provider: "openai-compatible",
    model: body.model ?? "",
    systemPrompt: body.systemPrompt,
    audienceFocus: body.audienceFocus ?? "",
    temperature: body.temperature,
    maxTokens: body.maxTokens,
    features: body.features,
    decisionRules: body.decisionRules,
    outputSchema: body.outputSchema,
    publishingTemplate: body.publishingTemplate ?? "",
    topicFilter: body.topicFilter,
    autoSendPolicy: body.autoSendPolicy,
  };

  const validation = validateAiConfigInput(input);
  if (!validation.valid) {
    return Response.json({ success: false, message: "پیکربندی نامعتبر است.", errors: validation.errors }, { status: 400 });
  }

  const activate = body.activate !== false;
  const outcome = await runWithSchemaRepair(() => createAiConfigVersion(input, { activate }));

  if (outcome.ok) {
    const config = outcome.value;
    return Response.json({
      success: true,
      config,
      aiKeyConfigured: isAiConfigured(),
      effectiveModel: resolveEffectiveModel(config.model),
      schemaSynced: outcome.schemaSynced,
    });
  }

  console.error("[ai-config] failed to save config:", String(outcome.error).slice(0, 200));
  return dbErrorResponse(
    outcome.error,
    outcome.repair && !outcome.repair.ok
      ? "ذخیره پیکربندی در پایگاه داده ناموفق بود (همگام‌سازی خودکار اسکیما هم ناموفق بود)."
      : "ذخیره پیکربندی در پایگاه داده ناموفق بود.",
    outcome.repair,
  );
}
