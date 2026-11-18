/**
 * Speech client: turn a text segment into audio using **the AI service that is
 * already configured for analysis** (`AI_API_KEY` / `AI_API_BASE_URL`), so the
 * weekly podcast needs no second vendor.
 *
 * The decision table and the payload shapes are pure and live in `./tts-core`
 * (unit-tested). This file only does what cannot be tested offline: resolve the
 * credentials through the same helpers the analysis pipeline uses, send the request
 * with the same proxy/dispatcher plumbing, and redact whatever the provider says.
 *
 * Audio is deliberately kept out of the delivery pipeline: no DB writes, no retry
 * ladder, no destination state. A failed clip must never look like a failed send.
 */

import { fetch as undiciFetch, type Dispatcher } from "undici";
import {
  getAiDispatcher,
  resolveAiApiKey,
  resolveAiProxyUrl,
  resolveEffectiveBaseUrl,
} from "./completion";
import {
  buildGeminiPayload,
  buildOpenAiPayload,
  clampTtsText,
  classifyTtsProviderError,
  parsePcmSampleRate,
  redactTtsSecret,
  resolveTtsCapability,
  TTS_LIMITS,
  wavDurationMs,
  wrapPcm16AsWav,
  type TtsCapability,
  type TtsFormat,
  type TtsRoute,
} from "./tts-core";

export * from "./tts-core";

export interface SynthesizeOptions {
  env?: NodeJS.ProcessEnv;
  /** Override `AI_TTS_MODEL` for a one-off test from the admin UI. */
  model?: string | null;
  /** Override `AI_TTS_VOICE`. */
  voice?: string | null;
}

export type TtsResult =
  | {
      ok: true;
      bytes: Uint8Array;
      format: TtsFormat;
      route: TtsRoute;
      model: string;
      voice: string;
      sampleRate: number | null;
      chars: number;
      truncated: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      kind: "not_configured" | "unsupported_route" | "http_error" | "empty" | "network";
      status?: number;
      /** What the provider's reply actually means (see `classifyTtsProviderError`). */
      code?: import("./tts-core").TtsFailureCode;
      /** A clickable fix when the provider named one (e.g. the console enable-link). */
      actionUrl?: string | null;
      message: string;
      /** The provider's own line, HTML-stripped and secret-redacted. */
      detail?: string;
    };

/**
 * Which speech route the *deployed* analysis service resolves to. Admin pages read
 * this instead of guessing from a model name — the whole question («سرویس فعلی
 * برای پادکست هم می‌شود؟») is answered by `supported` plus `note`.
 */
export function resolveTts(env: NodeJS.ProcessEnv = process.env): TtsCapability {
  const apiKey = resolveAiApiKey(env);
  return resolveTtsCapability({
    apiKey,
    // The pipeline's own resolver, so `AI_BASE_URL` / `OPENAI_BASE_URL` /
    // `OPENAI_API_BASE` aliases and a trailing `/chat/completions` land speech on
    // exactly the provider that analysis talks to — never a second interpretation.
    baseUrl: resolveEffectiveBaseUrl(apiKey, env),
    model: env.AI_TTS_MODEL,
    voice: env.AI_TTS_VOICE,
    maxChars: env.AI_TTS_MAX_CHARS,
  });
}

/** The exact request the endpoint expects, built from the resolved capability. */
export function buildTtsRequest(
  capability: TtsCapability,
  text: string,
  apiKey: string,
): { url: string; headers: Record<string, string>; body: string; isJsonReply: boolean } {
  if (capability.route === "gemini-audio") {
    return {
      // `capability.endpoint` already picked the right host (`aiplatform…` for `AQ.`
      // Vertex Express, `generativelanguage…` for an `AIza` key). The credential is
      // sent both ways exactly as the analysis path does it in completion.ts — the
      // shipped, working shape for Google — so speech cannot disagree with analysis.
      url: `${capability.endpoint}?key=${encodeURIComponent(apiKey)}`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildGeminiPayload(capability, text)),
      isJsonReply: true,
    };
  }

  return {
    url: capability.endpoint,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildOpenAiPayload(capability, text)),
    isJsonReply: false,
  };
}

/** Decode either reply shape into bytes. Throws a short, redacted, actionable error. */
async function readAudio(
  route: TtsRoute,
  response: { arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> },
): Promise<{ bytes: Uint8Array; format: TtsFormat; sampleRate: number | null }> {
  if (route === "gemini-audio") {
    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            inline_data?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
      error?: { message?: string };
    };
    if (payload?.error?.message) throw new Error(redactTtsSecret(payload.error.message));
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts
      .map((part) => part.inlineData ?? part.inline_data)
      .find((entry) => entry?.data);
    if (!inline?.data) {
      throw new Error("پاسخ Google هیچ قطعهٔ صوتی‌ای نداشت؛ مدل باید پسوند `preview-tts` داشته باشد.");
    }
    const pcm = Uint8Array.from(Buffer.from(inline.data, "base64"));
    const sampleRate = parsePcmSampleRate(inline.mimeType);
    // Gemini answers with raw PCM; the WAV header is written by hand so no encoder
    // has to enter the runtime image, and Bale/Telegram accept WAV audio directly.
    return { bytes: wrapPcm16AsWav(pcm, sampleRate), format: "wav", sampleRate };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error("سرویس صوتی پاسخ خالی داد.");
  }
  const bytes = new Uint8Array(buffer);
  // A gateway that does not implement the route usually answers with JSON instead
  // of a file — say so, and keep the provider's line visible.
  if (bytes[0] === 0x7b /* { */ || bytes[0] === 0x5b /* [ */) {
    const text = new TextDecoder().decode(bytes).slice(0, 200);
    throw new Error(redactTtsSecret(`سرویس به‌جای فایل صوتی JSON برگرداند: ${text}`));
  }
  return { bytes, format: "mp3", sampleRate: null };
}

/** Speak one segment. Longer copy is the caller's job to split (see `maxChars`). */
export async function synthesizeSpeech(text: string, options: SynthesizeOptions = {}): Promise<TtsResult> {
  const env = options.env ?? process.env;
  const apiKey = resolveAiApiKey(env) ?? "";
  const capability =
    options.model || options.voice
      ? resolveTtsCapability({
          apiKey,
          baseUrl: resolveEffectiveBaseUrl(apiKey, env),
          model: options.model ?? env.AI_TTS_MODEL,
          voice: options.voice ?? env.AI_TTS_VOICE,
          maxChars: env.AI_TTS_MAX_CHARS,
        })
      : resolveTts(env);

  if (!capability.configured) {
    return { ok: false, kind: "not_configured", message: capability.note ?? "کلید هوش مصنوعی تنظیم نشده است." };
  }
  if (!capability.supported) {
    return { ok: false, kind: "unsupported_route", message: capability.note ?? "سرویس فعلی endpoint صوتی ندارد." };
  }

  const { text: clipped, truncated } = clampTtsText(text, capability.maxChars);
  if (!clipped) {
    return { ok: false, kind: "empty", message: "متنی برای تبدیل به صوت داده نشد." };
  }

  const request = buildTtsRequest(capability, clipped, apiKey);
  const proxyUrl = resolveAiProxyUrl(env);
  const dispatcher: Dispatcher | undefined = proxyUrl ? getAiDispatcher(proxyUrl) : undefined;

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    // `undiciFetch`, not global fetch: global fetch silently ignores `dispatcher`.
    response = await undiciFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      dispatcher,
      signal: AbortSignal.timeout(TTS_LIMITS.requestTimeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Timeouts and DNS failures never carry the key, but redact anyway: one line
    // from a proxy error log can.
    return {
      ok: false,
      kind: "network",
      message: redactTtsSecret(/timeout|abort/i.test(message) ? "سرویس صوتی در مهلت مقرر پاسخ نداد." : `خطای شبکه: ${message}`),
    };
  }

  if (!response.ok) {
    const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    const failure = classifyTtsProviderError(response.status, body);
    return {
      ok: false,
      kind: "http_error",
      status: response.status,
      code: failure.code,
      actionUrl: failure.actionUrl,
      message: failure.messageFa,
      detail: failure.providerMessage || `${response.status} ${String(response.statusText ?? "")}`.trim(),
    };
  }

  try {
    const audio = await readAudio(capability.route, response);
    if (audio.bytes.byteLength === 0) {
      return { ok: false, kind: "empty", message: "سرویس صوتی فایل خالی برگرداند." };
    }
    return {
      ok: true,
      bytes: audio.bytes,
      format: audio.format,
      route: capability.route,
      model: capability.model,
      voice: capability.voice,
      sampleRate: audio.sampleRate,
      chars: clipped.length,
      truncated,
      durationMs:
        audio.format === "wav" && audio.sampleRate
          ? wavDurationMs(audio.bytes.byteLength, audio.sampleRate)
          : 0,
    };
  } catch (error) {
    // A gateway can also answer 200 with an error object inside; classify it the
    // same way so the operator still gets a fix instead of a pasted JSON body.
    const raw = error instanceof Error ? error.message : String(error);
    const failure = classifyTtsProviderError(200, raw);
    return {
      ok: false,
      kind: "http_error",
      code: failure.code,
      actionUrl: failure.actionUrl,
      message: failure.code === "unknown" ? redactTtsSecret(raw) : failure.messageFa,
      detail: failure.providerMessage || redactTtsSecret(raw),
    };
  }
}
