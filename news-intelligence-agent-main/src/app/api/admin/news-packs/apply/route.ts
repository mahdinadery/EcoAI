import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import {
  createAiConfigVersion,
  getActiveAiConfig,
  validateAiConfigInput,
} from "@/lib/ai/config-service";
import type { AiConfigInput } from "@/lib/ai/config-types";
import {
  appendAudienceNote,
  getNewsPack,
  mergeBlockedKeywords,
  mergePackTopics,
  NEWS_PACKS,
} from "@/lib/news/news-packs";
import { applyPackSources } from "@/lib/news/pack-apply";
import { testFeedWithoutStoring } from "@/lib/news/source-ingest";
import { createSource, listSourcesForAdmin } from "@/lib/news/sources-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Probing up to six feeds with concurrency 3 can take ~30-45s on slow hosts.
export const maxDuration = 60;

type ApplyBody = {
  packId?: string;
  /** Defaults to true. */
  applyTopics?: boolean;
  /** Defaults to true. */
  applySources?: boolean;
  /** Appends the credit-rating audience note to the system prompt. Defaults to true. */
  applyAudienceNote?: boolean;
};

type SourceOutcome = { name: string; url: string; status: "added" | "skipped" | "failed"; message?: string };

/**
 * POST /api/admin/news-packs/apply
 *
 * Applies a ready-made domain pack (currently «اعتبارسنجی») to the installation:
 *   - merges the pack topics into the ACTIVE AI configuration (a new version is
 *     created; the previous one stays in history), enabling include mode;
 *   - appends the pack's audience note to the system prompt once;
 *   - probes every packaged domestic feed and registers only the ones that
 *     actually return items (existing URLs are skipped).
 *
 * Backend-only endpoint (ADMIN_ACCESS_KEY). The previous behaviour of the
 * analysis pipeline is untouched when no pack is applied.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: ApplyBody;
  try {
    body = (await request.json()) as ApplyBody;
  } catch {
    body = {};
  }

  const packId = (body.packId ?? "").trim();
  const pack = getNewsPack(packId);
  if (!pack) {
    return Response.json(
      {
        success: false,
        message: "بسته خبری موردنظر پیدا نشد.",
        available: NEWS_PACKS.map((item) => ({ id: item.id, title: item.title })),
      },
      { status: 400 },
    );
  }

  const applyTopics = body.applyTopics !== false;
  const applySources = body.applySources !== false;
  const applyAudienceNote = body.applyAudienceNote !== false;

  const response: {
    success: boolean;
    pack: { id: string; title: string };
    topics: Record<string, unknown> | null;
    audienceNote: { applied: boolean; alreadyPresent: boolean } | null;
    sources: { results: SourceOutcome[]; added: number; skipped: number; failed: number } | Record<string, unknown> | null;
    warnings: string[];
  } = {
    success: true,
    pack: { id: pack.id, title: pack.title },
    topics: null,
    audienceNote: null,
    sources: null,
    warnings: [],
  };

  // ── Topics + prompt context ───────────────────────────────────────────────
  if (applyTopics || applyAudienceNote) {
    try {
      const activeOutcome = await runWithSchemaRepair(() => getActiveAiConfig());
      if (!activeOutcome.ok) {
        return dbErrorResponse(
          activeOutcome.error,
          "خواندن پیکربندی هوش مصنوعی برای اعمال بسته ناموفق بود.",
          activeOutcome.repair,
          { pack: response.pack },
        );
      }
      const active = activeOutcome.value;
      const merged = applyTopics
        ? mergePackTopics(active.topicFilter?.topics ?? [], pack)
        : { topics: active.topicFilter?.topics ?? [], added: [], skipped: [], truncated: 0 };
      const mergedBlocked = applyTopics
        ? mergeBlockedKeywords(active.topicFilter?.blockedKeywords ?? [], pack)
        : {
            blockedKeywords: active.topicFilter?.blockedKeywords ?? [],
            added: [],
            skipped: [],
          };
      const audience = applyAudienceNote
        ? appendAudienceNote(active.systemPrompt, pack)
        : { prompt: active.systemPrompt, alreadyPresent: true };

      response.audienceNote = { applied: !audience.alreadyPresent, alreadyPresent: audience.alreadyPresent };

      const topicsApplied = merged.added.length > 0 || mergedBlocked.added.length > 0;
      if (!topicsApplied && audience.alreadyPresent) {
        if (applyTopics) {
          response.topics = {
            ok: true,
            applied: false,
            reason: "already_applied",
            added: [],
            skipped: merged.skipped,
            truncated: 0,
            version: active.version,
            total: merged.topics.length,
          };
        }
      } else {
        const input: AiConfigInput = {
          name: active.name,
          provider: active.provider,
          model: active.model,
          systemPrompt: audience.prompt,
          temperature: active.temperature,
          maxTokens: active.maxTokens,
          features: active.features,
          decisionRules: active.decisionRules,
          outputSchema: active.outputSchema,
          publishingTemplate: active.publishingTemplate,
          topicFilter: applyTopics
            ? {
                enabled: true,
                mode: "include",
                topics: merged.topics,
                blockedKeywords: mergedBlocked.blockedKeywords,
              }
            : active.topicFilter,
          autoSendPolicy: active.autoSendPolicy,
        };

        const validation = validateAiConfigInput(input);
        if (!validation.valid) {
          response.success = false;
          response.topics = { ok: false, message: validation.errors.join(" · ") };
        } else {
          const saved = await createAiConfigVersion(input, { activate: true });
          if (applyTopics) {
            response.topics = {
              ok: true,
              applied: true,
              added: merged.added,
              skipped: merged.skipped,
              truncated: merged.truncated,
              version: saved.version,
              total: merged.topics.length,
            };
          }
        }
      }
    } catch (error) {
      response.success = false;
      response.topics = {
        ok: false,
        message: "اعمال بسته روی پیکربندی هوش مصنوعی ناموفق بود.",
        detail: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      };
      console.error("[news-packs] topics failed:", String(error).slice(0, 240));
    }
  }

  // ── Sources ───────────────────────────────────────────────────────────────
  if (applySources) {
    try {
      const listed = await runWithSchemaRepair(() => listSourcesForAdmin());
      if (!listed.ok) {
        return dbErrorResponse(listed.error, "بارگذاری فهرست منابع برای اعمال بسته ناموفق بود.", listed.repair, {
          pack: response.pack,
          topics: response.topics,
          sources: null,
        });
      }

      const existingUrls = listed.value.map((source) => source.url);
      const applied = await applyPackSources(pack, {
        listExistingUrls: async () => existingUrls,
        probe: async (url) => {
          const result = await testFeedWithoutStoring(url, 3);
          return result.ok
            ? { ok: true, itemCount: result.itemCount }
            : { ok: false, message: result.message, detail: result.detail };
        },
        create: async (source) => {
          await createSource({ ...source });
        },
      });

      const outcomes: SourceOutcome[] = applied.results;
      response.sources = {
        results: outcomes,
        added: applied.added,
        skipped: applied.skipped,
        failed: applied.failed,
      };

      if (applied.failed > 0) {
        response.warnings.push(
          "برخی منابع از سرور شما در دسترس نبودند؛ برای منابع ایرانیِ مسدود از NEWS_FETCH_PROXY_URL یا «ورود دستی RSS» استفاده کنید.",
        );
      }
    } catch (error) {
      response.success = false;
      response.sources = {
        ok: false,
        message: "بررسی یا افزودن منابع بسته ناموفق بود.",
        detail: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      };
      console.error("[news-packs] sources failed:", String(error).slice(0, 240));
    }
  }

  return Response.json(response);
}
