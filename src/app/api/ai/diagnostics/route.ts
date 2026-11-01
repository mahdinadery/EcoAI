import { checkAdminAccess } from "@/lib/admin/access";
import {
  callAiChatCompletion,
  resolveAiApiKey,
  resolveEffectiveBaseUrl,
  resolveEffectiveModel,
} from "@/lib/ai/completion";
import { getActiveAiConfig } from "@/lib/ai/config-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function maskApiKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const prefix = trimmed.slice(0, Math.min(5, trimmed.length));
  return `${prefix}… (${trimmed.length} chars)`;
}

/**
 * POST /api/ai/diagnostics
 *
 * Runs a lightweight live ping against the resolved AI provider/model so
 * operators on `/dashboard` can verify API key, base URL, model routing, and
 * latency in one click without running a full RSS + DB pass.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json(
      { success: false, ok: false, message: access.reason },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  const apiKey = resolveAiApiKey();
  const baseUrl = resolveEffectiveBaseUrl(apiKey);
  const config = await getActiveAiConfig();
  const effectiveModel = resolveEffectiveModel(config.model, { baseUrl, apiKey });

  if (!apiKey) {
    return Response.json({
      success: true,
      ok: false,
      hasKey: false,
      keyHint: null,
      baseUrl,
      configuredModel: config.model,
      effectiveModel,
      latencyMs: Date.now() - startedAt,
      message:
        "هیچ کلید API هوش مصنوعی در محیط سرور یافت نشد (`AI_API_KEY` یا `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`).",
      detail: null,
    });
  }

  const completion = await callAiChatCompletion(
    {
      systemPrompt: 'Return strictly valid JSON: {"ok": true}',
      userPrompt: "Health check ping for Economics of AI news analyzer.",
      model: effectiveModel,
      temperature: 0,
      maxTokens: 48,
    },
    { timeoutMs: 20_000 },
  );

  const latencyMs = Date.now() - startedAt;

  if (!completion.ok) {
    return Response.json({
      success: true,
      ok: false,
      hasKey: true,
      keyHint: maskApiKey(apiKey),
      baseUrl,
      configuredModel: config.model,
      effectiveModel,
      latencyMs,
      kind: completion.kind,
      message: completion.message,
      detail: completion.detail ?? null,
    });
  }

  return Response.json({
    success: true,
    ok: true,
    hasKey: true,
    keyHint: maskApiKey(apiKey),
    baseUrl,
    configuredModel: config.model,
    effectiveModel: completion.model || effectiveModel,
    latencyMs,
    message: `اتصال هوش مصنوعی برقرار و سالم است (${latencyMs}ms).`,
    detail: completion.rawText.slice(0, 120),
  });
}
