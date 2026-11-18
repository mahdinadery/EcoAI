/**
 * Podcast speech on the **AI service EcoAI already uses for analysis** — no second
 * vendor to configure.
 *
 * This module is the pure half: given the API key and base URL, it decides which
 * speech route that provider actually serves and builds the exact request body and
 * decodes the reply. It imports nothing, so `npm test` can exercise the whole
 * decision table — that table is the part a typo breaks silently, and it is the
 * answer to «سرویس فعلی برای پادکست هم می‌شود؟». The network half lives in
 * `src/lib/ai/tts.ts`, which resolves the credentials through the same helpers as
 * the analysis pipeline (`resolveAiApiKey` / `normalizeAiBaseUrl` /
 * `resolveAiProxyUrl`) so «the current service» always means the deployed config.
 *
 * Supported routes (a 404/400 from the provider is reported, never worked around):
 *   openai-compatible → `POST {base}/audio/speech` (OpenAI and gateways that proxy it)
 *   gemini-audio      → AI Studio `:generateContent` with `responseModalities: AUDIO`
 *   none              → chat-only relays (Groq, OpenRouter, xAI, a gateway that
 *                       proxies chat only) — the podcast then needs a TTS key.
 */

export type TtsRoute = "openai-compatible" | "gemini-audio" | "none";
export type TtsFormat = "mp3" | "wav";

export interface TtsInput {
  /** Raw key from the environment (`AI_API_KEY` and friends, already picked). */
  apiKey: string | null;
  /** Normalized base URL of the analysis provider; empty means «derive from key». */
  baseUrl: string;
  /** Optional `AI_TTS_MODEL`. */
  model?: string | null;
  /** Optional `AI_TTS_VOICE`. */
  voice?: string | null;
  /** Optional `AI_TTS_MAX_CHARS`; clamped to 200–4000 by `clampMaxChars`. */
  maxChars?: string | number | null;
}

export interface TtsCapability {
  configured: boolean;
  route: TtsRoute;
  /** False for `route: "none"` — the provider has no speech endpoint. */
  supported: boolean;
  model: string;
  voice: string;
  format: TtsFormat;
  maxChars: number;
  endpoint: string;
  /** Why the route was chosen / refused, for the admin UI. */
  note?: string;
}

export const TTS_LIMITS = {
  /**
   * Per-request text budget. A weekly podcast is assembled segment by segment, so
   * staying under the provider's own cap is handled by chunking, not here.
   */
  defaultMaxChars: 1200,
  minMaxChars: 200,
  maxMaxChars: 4000,
  requestTimeoutMs: 45_000,
  /** Safety net so one bad segment cannot pin a serverless function forever. */
  maxDurationSeconds: 60,
} as const;

const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
/** OpenAI voices; only the `tts-1*` family accepts them, `nova/gsap` are that model line. */
const OPENAI_VOICES = ["alloy", "nova", "shimmer", "echo", "fable"] as const;
const GEMINI_TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"] as const;
const GEMINI_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede"] as const;

/** Chat completions are all these relays serve; promising audio would be a guess. */
const CHAT_ONLY_HOSTS = [/api[.]groq[.]com/i, /openrouter[.]ai/i, /api[.]x[.]ai/i] as const;

/** Host fallbacks, mirroring `inferBaseUrlFromApiKey` in `completion.ts`. */
const GOOGLE_AI_STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_VERTEX_EXPRESS_BASE =
  "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";
const OPENAI_COMPATIBLE_BASE = "https://api.openai.com/v1";

export const TTS_MODEL_SUGGESTIONS: Record<Exclude<TtsRoute, "none">, readonly string[]> = {
  "openai-compatible": OPENAI_TTS_MODELS,
  "gemini-audio": GEMINI_TTS_MODELS,
};

export const TTS_VOICE_SUGGESTIONS: Record<Exclude<TtsRoute, "none">, readonly string[]> = {
  "openai-compatible": OPENAI_VOICES,
  "gemini-audio": GEMINI_VOICES,
};

const clampNumber = (value: string | number | null | undefined, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : value == null ? NaN : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const clampMaxChars = (value: string | number | null | undefined): number =>
  clampNumber(value, TTS_LIMITS.defaultMaxChars, TTS_LIMITS.minMaxChars, TTS_LIMITS.maxMaxChars);

/**
 * Decide the speech route from the credentials that are already configured.
 *
 * Google is recognized by the same two signals as the chat path — the `AIza` /
 * `AQ.` key prefixes and the base-URL host — because `AQ.` keys are rejected by the
 * OpenAI-compatible endpoint and `AIza` keys are rejected by Vertex.
 */
export function resolveTtsCapability(input: TtsInput): TtsCapability {
  const explicitModel = (input.model ?? "").trim() || null;
  const explicitVoice = (input.voice ?? "").trim() || null;
  const maxChars = clampMaxChars(input.maxChars);
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? "").replace(/\/+$/, "");

  if (!apiKey) {
    return {
      configured: false,
      route: "none",
      supported: false,
      model: explicitModel || OPENAI_TTS_MODELS[0],
      voice: explicitVoice || OPENAI_VOICES[0],
      format: "mp3",
      maxChars,
      endpoint: "",
      note: "هیچ کلید هوش مصنوعی‌ای تنظیم نشده؛ همان AI_API_KEY که تحلیل با آن کار می‌کند کافی است.",
    };
  }

  const isGoogleKey = /^AIza[0-9A-Za-z_-]{10,}$/.test(apiKey) || /^AQ\.[A-Za-z0-9_\-=]{20,}$/.test(apiKey);
  const hostLooksGoogle = /generativelanguage[.]googleapis[.]com|aiplatform[.]googleapis[.]com|\bmodels\//i.test(baseUrl);
  const onVertex = isGoogleKey ? /^AQ\./.test(apiKey) : /aiplatform[.]googleapis[.]com/i.test(baseUrl);

  if (isGoogleKey || hostLooksGoogle) {
    const model = explicitModel || GEMINI_TTS_MODELS[0];
    // The display endpoint is the request URL minus the credential, so the admin UI
    // and `buildTtsRequest` can never disagree about which host is being called.
    const endpoint = onVertex
      ? `${GOOGLE_VERTEX_EXPRESS_BASE}/${model}:generateContent`
      : `${GOOGLE_AI_STUDIO_BASE}/models/${model}:generateContent`;
    return {
      configured: true,
      route: "gemini-audio",
      supported: true,
      model,
      voice: explicitVoice || GEMINI_VOICES[0],
      format: "wav",
      maxChars,
      endpoint,
      note: onVertex
        ? "کلید Vertex Express؛ مسیر صوتی بومی Google با همان کلید و همان endpoint تحلیلی."
        : "کلید AI Studio (Gemini)؛ مسیر صوتی بومی Google بدون سرویس دوم.",
    };
  }

  if (CHAT_ONLY_HOSTS.some((pattern) => pattern.test(baseUrl))) {
    return {
      configured: true,
      route: "none",
      supported: false,
      model: explicitModel || OPENAI_TTS_MODELS[0],
      voice: explicitVoice || OPENAI_VOICES[0],
      format: "mp3",
      maxChars,
      endpoint: `${baseUrl || OPENAI_COMPATIBLE_BASE}/audio/speech`,
      note: "این سرویس فقط گفت‌وگو (chat completions) را سرو می‌کند و endpoint صدایی ندارد؛ برای پادکست باید کلید OpenAI یا Google کنارش گذاشته شود.",
    };
  }

  // Everything else is treated as OpenAI-compatible: that is the same assumption
  // the analysis pipeline already makes, so a gateway that proxies chat and speech
  // (Avalai and friends) works with zero new configuration. A gateway without
  // `/audio/speech` answers 404 and the diagnostics surface it verbatim.
  const base = baseUrl || OPENAI_COMPATIBLE_BASE;
  const model = explicitModel || OPENAI_TTS_MODELS[0];
  return {
    configured: true,
    route: "openai-compatible",
    supported: true,
    model,
    voice: explicitVoice || OPENAI_VOICES[0],
    format: "mp3",
    maxChars,
    endpoint: `${base}/audio/speech`,
    note:
      baseUrl && !/api[.]openai[.]com/i.test(baseUrl)
        ? "سرویس اوپن‌ای‌کمپتبل؛ اگر درگاه `/audio/speech` را سرو نکند پاسخ ۴۰۴ دقیقاً همان‌جا دیده می‌شود."
        : "سرویس اوپن‌ای‌کمپتبل؛ همان سرویس تحلیل، با مدل صوتی.",
  };
}

/**
 * Fit text into the provider's per-request budget on a sentence boundary. Persian
 * uses `۔` and also ends sentences with `.` / `!` / `؟`, so all of them are
 * candidates; when the window holds no sentence end, the last partial word is
 * dropped whole rather than read half-way.
 */
export function clampTtsText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };

  const window = trimmed.slice(0, maxChars);
  const boundary = Math.max(
    window.lastIndexOf("\u06D4"), // Persian full stop «۔»
    window.lastIndexOf("."),
    window.lastIndexOf("!"),
    window.lastIndexOf("\u061F"), // «؟»
    window.lastIndexOf("?"),
  );
  // A finished sentence always wins: a half word is read aloud as a half word, and
  // no amount of threshold tuning makes that sound better than an early cut.
  const space = window.lastIndexOf(" ");
  const cut = boundary > 0 ? boundary + 1 : space > 0 ? space : maxChars;
  return { text: window.slice(0, cut).trim(), truncated: true };
}

/** Split the segment into read-aloud instructions + text (Gemini's style prompt). */
export function buildOpenAiPayload(
  capability: Pick<TtsCapability, "model" | "voice">,
  text: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: capability.model,
    input: text,
    response_format: "mp3",
    speed: 1,
  };
  // `gpt-4o-mini-tts` takes the `nova`/`shimmer` voice family; `tts-1` shares the
  // names but rejects none of ours. Keep the voice for both and let `alloy` be the
  // universal fallback, which is also OpenAI's default.
  payload.voice = capability.model.startsWith("tts-1") || capability.model.startsWith("gpt-4o-mini-tts")
    ? capability.voice || "alloy"
    : capability.voice || "alloy";
  return payload;
}

/** Gemini native audio request: one modality (AUDIO), PCM out, wrapped into WAV. */
export function buildGeminiPayload(
  capability: Pick<TtsCapability, "model" | "voice">,
  text: string,
): Record<string, unknown> {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "متن زیر را به فارسی روان، گرم و با لحن پادکستی بخوان؛ اعداد را به فارسی ادا کن و علائم نگارشی را نخوان.\n\nمتن:\n" +
              text,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: capability.voice || GEMINI_VOICES[0],
          },
        },
      },
      temperature: 0.4,
    },
  };
}

/** `audio/L16;codec=pcm;rate=24000` → 24000; defaults to Gemini's 24 kHz. */
export function parsePcmSampleRate(mimeType: string | undefined | null): number {
  const match = /rate=(\d{3,7})/i.exec(mimeType ?? "");
  if (match) {
    const rate = Number(match[1]);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return 24_000;
}

/**
 * 44-byte canonical RIFF/WAVE header + PCM16 mono data. WAV is only needed because
 * Gemini returns raw PCM and the runtime image has no encoder — a hand-written
 * header keeps ffmpeg out of the deployment.
 */
export function wrapPcm16AsWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

/** Duration in seconds from a WAV byte length — no decoder needed for a report line. */
export function wavDurationMs(bytes: number, sampleRate = 24_000, channels = 1, bitsPerSample = 16): number {
  const payload = Math.max(0, bytes - 44);
  const frames = payload / (sampleRate * channels * (bitsPerSample / 8));
  return Math.round(frames * 1000);
}

/**
 * Providers echo the full request URL back in their `error.message`, and the Google
 * URL carries `?key=…`. Anything printed from this feature goes through here first.
 */
export function redactTtsSecret(text: string): string {
  return String(text ?? "")
    .replace(/key=[0-9A-Za-z_\-=]{6,}/gi, "key=[redacted]")
    .replace(/AIza[0-9A-Za-z_\-=]{20,}/g, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|gsk_|aa-|AQ\.|ya29\.)[0-9A-Za-z_\-=]{6,}/g, "[redacted-key]")
    .slice(0, 400);
}
