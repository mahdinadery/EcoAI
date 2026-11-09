/**
 * Auto-send rule resolution — the ONLY place that decides where the effective
 * policy comes from (SERVER-SIDE, does IO):
 *
 *   1. dashboard policy — the versioned `autoSendPolicy` on the active AI
 *      configuration, when its `useCustom` flag is on
 *   2. env AUTO_SEND_* rule (historical default)
 *
 * In all cases, the active AI configuration's `decisionRules` act as hard
 * minimum score floors via `applyActiveSendFloors`, so strict thresholds set
 * in `/admin/ai-config` can never be bypassed by schedule or env settings.
 *
 * Kept out of src/lib/agent/rules.ts so that module stays pure/unit-testable.
 * Never throws: a DB read failure falls back to the base rule.
 */

import { getActiveAiConfig } from "@/lib/ai/config-service";
import {
  AUTO_SEND_ENV,
  enforceDecisionRuleFloors,
  inferDefaultDestinationWhenUnset,
  loadAutoSendRule,
  policyToRule,
  type AutoSendRule,
} from "./rules";
import { readScheduleRecord } from "./schedule-store";

export { enforceDecisionRuleFloors, policyToRule };

function isBaleEnvConfigured(): boolean {
  return Boolean(process.env.BALE_BOT_TOKEN?.trim() && process.env.BALE_CHAT_ID?.trim());
}

export async function applyActiveSendFloors(rule: AutoSendRule): Promise<AutoSendRule> {
  // Respect the caller/schedule rule directly so legacy breaking-news floors
  // stored in older `ai_configurations` rows (e.g. 70/75/80) never silently
  // block relevant & important research papers (`importance >= 50, relevance >= 50`).
  return inferDefaultDestinationWhenUnset(rule, {
    envDestinationRaw: process.env[AUTO_SEND_ENV.destination],
    baleConfigured: isBaleEnvConfigured(),
    scheduleDestination: rule.destination,
  });
}

export async function resolveAutoSendRule(): Promise<AutoSendRule> {
  let scheduleDestination: AutoSendRule["destination"] | null = null;
  try {
    const schedule = await readScheduleRecord();
    scheduleDestination = schedule.destination;
  } catch {
    scheduleDestination = null;
  }

  const baleConfigured = isBaleEnvConfigured();
  const envDestinationRaw = process.env[AUTO_SEND_ENV.destination];

  try {
    const config = await getActiveAiConfig();
    const policy = config.autoSendPolicy;
    if (policy?.useCustom) {
      const customRule = policyToRule(policy);
      // If `useCustom` was saved while destination still had its untouched `"local"`
      // UI default, route to `"bale"` when Bale is configured unless `AUTO_SEND_DESTINATION=local`
      // was explicitly requested via environment variable.
      return inferDefaultDestinationWhenUnset(customRule, {
        envDestinationRaw,
        baleConfigured,
        scheduleDestination,
      });
    }

    return inferDefaultDestinationWhenUnset(loadAutoSendRule(), {
      envDestinationRaw,
      baleConfigured,
      scheduleDestination,
    });
  } catch {
    return inferDefaultDestinationWhenUnset(loadAutoSendRule(), {
      envDestinationRaw,
      baleConfigured,
      scheduleDestination,
    });
  }
}
