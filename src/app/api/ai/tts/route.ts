import { checkAdminAccess } from "@/lib/admin/access";
import {
  resolveTts,
  synthesizeSpeech,
  TTS_LIMITS,
  TTS_MODEL_SUGGESTIONS,
  TTS_VOICE_SUGGESTIONS,
} from "@/lib/ai/tts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The synthesis call bounds itself to ~55s; the host cut-off stays above it. */
export const maxDuration = 60;

/**
 * GET  /api/ai/tts — can the *already configured* AI service speak?
 * POST /api/ai/tts — synthesize a sample and (with `?format=audio`) get the file.
 *
 * This is the answer to "do I need a second vendor for the podcast?": it reports
 * which speech route the current key resolves to, and the POST proves it against
 * the provider. The API key is never read out — only the endpoint host, the
 * model/voice and a redacted provider message come back. Both methods sit behind
 * the same admin gate as /api/bale/diagnostics.
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const capability = resolveTts();
  return Response.json({
    success: true,
    ...capability,
    // The endpoint host only — the key never appears here.
    endpoint: capability.endpoint.replace(/key=[^&\s]+/g, "key=[redacted]"),
    suggestedModels: capability.route === "none" ? [] : TTS_MODEL_SUGGESTIONS[capability.route],
    suggestedVoices: capability.route === "none" ? [] : TTS_VOICE_SUGGESTIONS[capability.route],
    envKeys: {
      model: "AI_TTS_MODEL",
      voice: "AI_TTS_VOICE",
      maxChars: "AI_TTS_MAX_CHARS",
    },
    limits: { defaultMaxChars: TTS_LIMITS.defaultMaxChars, maxChars: TTS_LIMITS.maxMaxChars },
  });
}

export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: { text?: string; model?: string; voice?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is a valid "speak the default sample" request.
  }

  const capability = resolveTts();
  // What we actually asked for, not what the env defaults to: a diagnostic that
  // names the wrong model is worse than no diagnostic.
  const requestedModel = (body.model ?? "").trim() || capability.model;
  const requestedVoice = (body.voice ?? "").trim() || capability.voice;
  const text =
    (body.text ?? "").trim() ||
    "این یک نمونهٔ صوتی است تا بفهمیم سرویس هوش مصنوعی فعلی می‌تواند پادکست خلاصهٔ هفته را بخواند یا نه.";

  const result = await synthesizeSpeech(text, { env: process.env, model: body.model, voice: body.voice });

  if (!result.ok) {
    return Response.json(
      {
        success: false,
        route: capability.route,
        model: requestedModel,
        voice: requestedVoice,
        errorKind: result.kind,
        // `code` + `message` come from `classifyTtsProviderError`: what the reply
        // means and what to do about it. `detail` keeps the provider's own words so
        // nothing is taken on trust. `actionUrl` only exists when the provider
        // itself pointed at a console page.
        code: result.code ?? null,
        message: result.message,
        detail: result.detail ?? null,
        actionUrl: result.actionUrl ?? null,
      },
      { status: result.kind === "not_configured" || result.kind === "unsupported_route" ? 409 : 502 },
    );
  }

  const wantsFile = new URL(request.url).searchParams.get("format") === "audio";
  if (wantsFile) {
    return new Response(result.bytes as unknown as BodyInit, {
      headers: {
        "content-type": result.format === "mp3" ? "audio/mpeg" : "audio/wav",
        "content-disposition": `inline; filename="ecoai-tts-sample.${result.format}"`,
        "x-tts-model": result.model,
        "x-tts-voice": result.voice,
      },
    });
  }

  // ~24 kHz mono speech is roughly 2.6 minutes per 10 KB of mp3; the byte count
  // is the honest number, so report it instead of guessing a duration.
  return Response.json({
    success: true,
    route: result.route,
    format: result.format,
    model: result.model,
    voice: result.voice,
    chars: result.chars,
    truncated: result.truncated,
    bytes: result.bytes.byteLength,
    message:
      `نمونهٔ صوتی با ${result.route === "gemini-audio" ? "همان سرویس Google" : "همان سرویس اوپن‌ای‌کمپتبل"} ساخته شد ` +
      `(${result.format.toUpperCase()}، ${result.bytes.byteLength.toLocaleString("fa-IR")} بایت). ` +
      `برای شنیدنش: curl -sS -X POST -o sample.${result.format} ` +
      `"https://<app-url>/api/ai/tts?key=<ADMIN_ACCESS_KEY>&format=audio" -d '{}'.` +
      (result.truncated ? " متن بلند بود و به سقف نویسه‌ها بریده شد (AI_TTS_MAX_CHARS)." : ""),
  });
}
