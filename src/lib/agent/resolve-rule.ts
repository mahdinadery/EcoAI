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
  try {
    const config = await getActiveAiConfig();
    return enforceDecisionRuleFloors(rule, config.decisionRules);
  } catch {
    return rule;
  }
}

export async function resolveAutoSendRule(): Promise<AutoSendRule> {
  let scheduleDestination: AutoSendRule["destination"] | null = null;
  try {
    const schedule = await readScheduleRecord();
    scheduleDestination = schedule.destination;
  } catch {
    scheduleDestination = null;
  }

  try {
    const config = await getActiveAiConfig();
    const policy = config.autoSendPolicy;
    const baseRule = policy?.useCustom
      ? policyToRule(policy)
      : inferDefaultDestinationWhenUnset(loadAutoSendRule(), {
          envDestinationRaw: process.env[AUTO_SEND_ENV.destination],
          baleConfigured: isBaleEnvConfigured(),
          scheduleDestination,
        });
    return enforceDecisionRuleFloors(baseRule, config.decisionRules);
  } catch {
    return inferDefaultDestinationWhenUnset(loadAutoSendRule(), {
      envDestinationRaw: process.env[AUTO_SEND_ENV.destination],
      baleConfigured: isBaleEnvConfigured(),
      scheduleDestination,
    });
  }
}
