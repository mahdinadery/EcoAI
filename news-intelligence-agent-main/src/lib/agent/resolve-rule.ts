/**
 * Auto-send rule resolution — the ONLY place that decides where the effective
 * policy comes from (SERVER-SIDE, does IO):
 *
 *   1. dashboard policy — the versioned `autoSendPolicy` on the active AI
 *      configuration, when its `useCustom` flag is on
 *   2. env AUTO_SEND_* rule (historical default, unchanged behavior)
 *
 * Kept out of src/lib/agent/rules.ts so that module stays pure/unit-testable.
 * Never throws: a DB read failure falls back to the env rule.
 */

import { readActiveOperationalSettings } from "@/lib/ai/config-service";
import { loadAutoSendRule, policyToRule, type AutoSendRule } from "./rules";

export { policyToRule };

export async function resolveAutoSendRule(): Promise<AutoSendRule> {
  try {
    const settings = await readActiveOperationalSettings();
    const policy = settings?.autoSendPolicy;
    if (policy?.useCustom) {
      return policyToRule(policy);
    }
  } catch {
    // fall through to env
  }
  return loadAutoSendRule();
}
