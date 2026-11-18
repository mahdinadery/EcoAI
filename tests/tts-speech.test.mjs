import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  buildGeminiPayload,
  classifyTtsProviderError as m_classify,
  cleanProviderBody as m_clean,
  extractActionUrl as m_extract,
  buildOpenAiPayload,
  clampMaxChars,
  clampTtsText,
  parsePcmSampleRate,
  redactTtsSecret,
  resolveTtsCapability,
  TTS_LIMITS,
  wavDurationMs,
  wrapPcm16AsWav,
} from "../src/lib/ai/tts-core.ts";

/**
 * The podcast must be speakable by the AI service that is already configured for
 * analysis. This table is what the admin sees as «سرویس فعلی supports speech or
 * not», so every branch is asserted — including the ones that must answer *no*
 * instead of inventing a reason.
 */
test("resolveTtsCapability: routes by the key the analysis pipeline already uses", () => {
  const openAi = resolveTtsCapability({ apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz", baseUrl: "" });
  assert.equal(openAi.route, "openai-compatible");
  assert.equal(openAi.supported, true);
  assert.equal(openAi.format, "mp3");
  assert.equal(openAi.endpoint, "https://api.openai.com/v1/audio/speech");
  assert.equal(openAi.model, "gpt-4o-mini-tts");
  assert.equal(openAi.voice, "alloy");

  const aiStudio = resolveTtsCapability({ apiKey: "AIzaSyDabcdefghij1234567890ABCDEFGH", baseUrl: "" });
  assert.equal(aiStudio.route, "gemini-audio");
  assert.equal(aiStudio.supported, true);
  // PCM comes back raw; it is wrapped into WAV so no encoder enters the image.
  assert.equal(aiStudio.format, "wav");
  assert.equal(
    aiStudio.endpoint,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
  );

  const vertex = resolveTtsCapability({ apiKey: "AQ.abcdEFGH-ijklmnopQRST12345uvwxyz", baseUrl: "" });
  assert.equal(vertex.route, "gemini-audio");
  assert.equal(vertex.supported, true);
  assert.match(vertex.note ?? "", /Vertex/);

  const gateway = resolveTtsCapability({ apiKey: "sk-abcdefghij1234", baseUrl: "https://api.avalai.ir/v1" });
  assert.equal(gateway.route, "openai-compatible");
  assert.equal(gateway.endpoint, "https://api.avalai.ir/v1/audio/speech");
  assert.match(gateway.note ?? "", /۴۰۴/, "a gateway must be told the 404 is the proof, not a silent fallback");

  const noKey = resolveTtsCapability({ apiKey: "", baseUrl: "" });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.supported, false);
  assert.match(noKey.note ?? "", /AI_API_KEY/);
});

test("resolveTtsCapability: chat-only relays are reported as unsupported, never faked", () => {
  for (const [label, baseUrl] of [
    ["groq", "https://api.groq.com/openai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["xai", "https://api.x.ai/v1"],
  ]) {
    const capability = resolveTtsCapability({ apiKey: "sk-abcdefghij1234", baseUrl });
    assert.equal(capability.route, "none", label);
    assert.equal(capability.supported, false, label);
    assert.match(capability.note ?? "", /پادکست/, label);
  }
});

test("resolveTtsCapability: explicit AI_TTS_MODEL / AI_TTS_VOICE win over defaults", () => {
  const capability = resolveTtsCapability({
    apiKey: "sk-abcdefghij1234",
    baseUrl: "",
    model: "tts-1-hd",
    voice: "nova",
    maxChars: "3000",
  });
  assert.equal(capability.model, "tts-1-hd");
  assert.equal(capability.voice, "nova");
  assert.equal(capability.maxChars, 3000);
  assert.equal(clampMaxChars("99999"), TTS_LIMITS.maxMaxChars);
  assert.equal(clampMaxChars("5"), TTS_LIMITS.minMaxChars);
  assert.equal(clampMaxChars(undefined), TTS_LIMITS.defaultMaxChars);
});

test("clampTtsText: cuts on a sentence boundary and flags the truncation", () => {
  const long = "اولین جملهٔ کوتاه. دومین جمله کمی بلندتر است تا از سقف رد شود. سومین جمله.";
  const clamped = clampTtsText(long, 45);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.text.endsWith("."), `expected a sentence end, got «${clamped.text}»`);
  assert.ok(clamped.text.length <= 45);
  assert.equal(clamped.text, "اولین جملهٔ کوتاه.");

  const short = clampTtsText("متن کوتاه است", 45);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "متن کوتاه است");

  // No sentence end inside the window → drop the partial word, never cut inside it.
  const noBoundary = "کلمه ".repeat(40).trim();
  const wordCut = clampTtsText(noBoundary, 20);
  assert.equal(wordCut.text, "کلمه کلمه کلمه کلمه");
  assert.equal(wordCut.truncated, true);
});

test("wrapPcm16AsWav: canonical 44-byte header with sizes matching the payload", () => {
  const pcm = new Uint8Array(2 * 24_000); // exactly one second of 24 kHz mono 16-bit
  const wav = wrapPcm16AsWav(pcm, 24_000);
  assert.equal(wav.byteLength, 44 + pcm.byteLength);

  const view = new DataView(wav.buffer);
  const tag = (offset) => String.fromCharCode(wav[offset], wav[offset + 1], wav[offset + 2], wav[offset + 3]);
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt ");
  assert.equal(tag(36), "data");
  assert.equal(view.getUint32(4, true), 36 + pcm.byteLength);
  assert.equal(view.getUint16(20, true), 1, "PCM format tag");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 24_000);
  assert.equal(view.getUint32(28, true), 48_000, "byte rate");
  assert.equal(view.getUint32(40, true), pcm.byteLength);
  // The payload must survive untouched.
  assert.equal(wav.subarray(44).byteLength, pcm.byteLength);

  assert.equal(wavDurationMs(wav.byteLength, 24_000), 1000);
});

test("parsePcmSampleRate: reads the mimeType the provider sends, else 24 kHz", () => {
  assert.equal(parsePcmSampleRate("audio/L16;codec=pcm;rate=24000"), 24_000);
  assert.equal(parsePcmSampleRate("audio/L16;rate=16000"), 16_000);
  assert.equal(parsePcmSampleRate("audio/L16"), 24_000);
  assert.equal(parsePcmSampleRate(undefined), 24_000);
});

test("payload builders: the shapes the two providers demand", () => {
  const openAi = buildOpenAiPayload({ model: "gpt-4o-mini-tts", voice: "nova" }, "بخوان");
  assert.deepEqual(openAi, { model: "gpt-4o-mini-tts", input: "بخوان", response_format: "mp3", speed: 1, voice: "nova" });

  const gemini = buildGeminiPayload({ model: "gemini-2.5-flash-preview-tts", voice: "Kore" }, "بخوان");
  assert.deepEqual(gemini.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(gemini.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  assert.match(gemini.contents[0].parts[0].text, /بخوان$/);
  assert.match(gemini.contents[0].parts[0].text, /پادکستی/, "the read-aloud style instruction must travel with the text");
});

test("redactTtsSecret: no key or query secret ever leaves the feature", () => {
  const leaked =
    "call to https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyDabcdefghij1234567890 failed with Bearer sk-proj-abcdefghijklmnopqrstuvwxyz";
  const safe = redactTtsSecret(leaked);
  for (const needle of ["AIzaSyDabcdefghij", "sk-proj-abcdefghijklmnopqrstuvwxyz", "key=AIza", "Bearer sk"]) {
    assert.ok(!safe.includes(needle), `leaked «${needle}»: ${safe}`);
  }
  assert.match(safe, /key=\[redacted\]/);
  assert.match(safe, /Bearer \[redacted\]/);
  assert.ok(safe.length <= 400);
});

test("wiring: the client sends through undici + the shared proxy dispatcher", () => {
  const client = readFileSync("src/lib/ai/tts.ts", "utf8");
  assert.match(client, /from "undici"/, "must use undiciFetch, which honors the dispatcher option");
  assert.match(client, /dispatcher,/);
  assert.match(client, /getAiDispatcher/);
  assert.match(client, /AbortSignal\.timeout\(TTS_LIMITS\.requestTimeoutMs\)/);
  assert.match(client, /redactTtsSecret/, "provider replies must pass through the redactor");
  // Google credentials go the same way the analysis path sends them.
  assert.match(client, /x-goog-api-key/);
  assert.match(client, /\?key=\$\{encodeURIComponent\(apiKey\)\}/);
  // The whole point: same key + base resolution as the analysis pipeline, including
  // the `AI_BASE_URL` / `OPENAI_BASE_URL` aliases a deployment may use instead.
  assert.match(client, /resolveAiApiKey\(env\)/);
  assert.match(client, /resolveEffectiveBaseUrl\(apiKey, env\)/);
  assert.ok(!/normalizeAiBaseUrl\(/.test(client), "must not re-interpret the base URL locally");
  assert.ok(!/env\.AI_API_BASE_URL/.test(client), "must read every alias through the pipeline resolver");
  // No DB, no delivery state in this module.
  assert.ok(!/@\/db/.test(client), "speech must not touch the database");
  assert.ok(!/@\/lib\/bale\/client|@\/lib\/telegram\/client/.test(client), "speech must not send messages");
});

test("wiring: the probe and the test button share one admin-gated route", () => {
  const route = readFileSync("src/app/api/ai/tts/route.ts", "utf8");
  assert.match(route, /checkAdminAccess/);
  assert.equal((route.match(/checkAdminAccess\(request\)/g) ?? []).length, 2, "GET and POST both gated");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /force-dynamic/);
  assert.match(route, /synthesizeSpeech\(/);
  assert.match(route, /model: requestedModel/, "an error must name the model actually requested");
  // The GET is the answer to the user's question; it must not call the provider.
  const body = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.ok(!/synthesizeSpeech\(/.test(body), "GET is a pure probe — no provider call, no cost");
  assert.ok(!/API_KEY/.test(body), "never echo env values");
});


/**
 * The failure an operator actually hits («Agent Platform API has not been used in
 * project …») must come back as a fix, not as a pasted HTTP body.
 */
test("classifyTtsProviderError: a disabled Google service is reported as an enable step", () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      message:
        "Agent Platform API has not been used in project 132831068496 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=132831068496 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    },
  });
  const failure = m_classify(403, body);
  assert.equal(failure.code, "service_not_enabled");
  assert.match(failure.messageFa, /فعال/);
  assert.match(failure.messageFa, /تحلیل/, "the shared blast radius has to be said out loud");
  assert.equal(
    failure.actionUrl,
    "https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=132831068496",
  );
  // The provider's own words stay available as evidence.
  assert.match(failure.providerMessage, /has not been used in project/);
});

test("classifyTtsProviderError: each class gets its own fix", () => {
  assert.equal(m_classify(429, JSON.stringify({ error: { message: "Quota exceeded for metric: …, limit: 0" } })).code, "quota_exhausted");
  assert.equal(
    m_classify(404, JSON.stringify({ error: { message: "This model models/gemini-x-tts is no longer available." } })).code,
    "model_unavailable",
  );
  const badRequest = m_classify(400, JSON.stringify({ error: { message: "Unsupported voice: Kore" } }));
  assert.equal(badRequest.code, "model_unavailable", "the body, not the status, carries the meaning");
  assert.match(badRequest.messageFa, /AI_TTS_MODEL/);
  assert.equal(m_classify(401, JSON.stringify({ error: { message: "Invalid API key provided" } })).code, "permission_denied");
  const boom = m_classify(500, "<html><head><title>500 Bad Gateway</title></head><body>upstream blew up</body></html>");
  assert.equal(boom.code, "unknown");
  assert.match(boom.providerMessage, /upstream blew up/);
  assert.ok(!boom.providerMessage.includes("<"), "HTML must be stripped");
  assert.equal(m_classify(502, "").code, "unknown");
});

test("classifyTtsProviderError: the key never rides along into the report", () => {
  const leaky =
    'Request failed for https://aiplatform.googleapis.com/v1beta1/publishers/google/models/x:generateContent?key=AIzaSyDabcdefghij1234567890ABCDEF with Bearer AQ.someSecretValueHere-123';
  const failure = m_classify(403, leaky);
  const all = `${failure.messageFa} ${failure.providerMessage} ${failure.actionUrl ?? ""}`;
  for (const needle of ["AIzaSyDabcdefghij", "AQ.someSecretValueHere", "key=AIza", "Bearer AQ"]) {
    assert.ok(!all.includes(needle), `leaked «${needle}»`);
  }
});

test("cleanProviderBody + extractActionUrl helpers", () => {
  assert.equal(m_clean(JSON.stringify({ error: { message: "  bad voice  " } })), "bad voice");
  assert.equal(m_clean('{"not json'), '{"not json');
  assert.equal(m_clean(null), "");
  assert.equal(m_extract("see https://console.example/enable?x=1 for details"), "https://console.example/enable?x=1");
  assert.equal(m_extract("visit https://x.example/a."), "https://x.example/a");
  assert.equal(m_extract("no link here"), null);
});

test("route + card: the classified failure reaches the UI as code/detail/actionUrl", () => {
  const route = readFileSync("src/app/api/ai/tts/route.ts", "utf8");
  assert.match(route, /code: result\.code/);
  assert.match(route, /detail: result\.detail/);
  assert.match(route, /actionUrl: result\.actionUrl/);
  const card = readFileSync("src/components/admin/podcast-voice-card.tsx", "utf8");
  assert.match(card, /meta\?\.actionUrl/);
  assert.match(card, /target="_blank"/);
  assert.match(card, /rel="noreferrer noopener"/);
  assert.match(card, /meta\?\.detail/);
});
