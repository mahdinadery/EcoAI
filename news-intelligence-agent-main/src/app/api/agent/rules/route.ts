import { getBaleConfigStatus } from "@/lib/bale/client";
import { describeRule, resolveAutoSendRule } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/rules
 *
 * Exposes the *policy* only: thresholds, destination and whether the rule is on
 * (dashboard policy when configured, otherwise the AUTO_SEND_* env rule).
 * No API keys, tokens, connection strings or env values are ever returned —
 * `baleConfigured` is a boolean, not a credential.
 */
export async function GET() {
  const rule = await resolveAutoSendRule();
  const bale = getBaleConfigStatus();

  return Response.json({
    success: true,
    enabled: rule.enabled,
    destination: rule.destination,
    thresholds: {
      minImportance: rule.minImportance,
      minRelevance: rule.minRelevance,
      minNovelty: rule.minNovelty,
    },
    requireAiRecommendation: rule.requireAiRecommendation,
    categories: rule.categories,
    maxItemsPerPass: rule.maxItemsPerPass,
    description: describeRule(rule),
    destinationsReady: {
      local: true,
      bale: bale.configured,
    },
    baleMissing: bale.missing,
  });
}
