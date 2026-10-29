import { checkAdminAccess } from "@/lib/admin/access";
import { diagnoseDbError } from "@/lib/admin/db-errors";
import { getBaleConfigStatus } from "@/lib/bale/client";
import {
  computeDueBulletinSlot,
  computeDueSlot,
  computeNextBulletinRun,
  computeNextRun,
  coerceScheduleConfig,
  describeSchedule,
  validateScheduleInput,
  type AgentScheduleConfig,
} from "@/lib/agent/schedule";
import { readScheduleRecord, recordRunResult, saveScheduleConfig } from "@/lib/agent/schedule-store";
import { isScheduledRunInProgress, runScheduledPass } from "@/lib/agent/scheduled-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function nextRunInfo(config: AgentScheduleConfig) {
  const next = computeNextRun({ now: new Date(), config });
  return next
    ? {
        nextRunAt: next.at.toISOString(),
        nextRunSlot: next.slotKey,
        nextRunTime: next.time,
      }
    : { nextRunAt: null, nextRunSlot: null, nextRunTime: null };
}

/**
 * GET /api/agent/scheduler
 *
 * Current schedule + derived status for the dashboard. Read-only and exposes
 * no credentials (Bale readiness is a boolean + missing variable names).
 */
export async function GET() {
  const record = await readScheduleRecord();
  const bale = getBaleConfigStatus();
  const due = computeDueSlot({ now: new Date(), config: record, lastRunSlot: record.lastRunSlot });
  const next = nextRunInfo(record);

  return Response.json({
    success: true,
    config: {
      enabled: record.enabled,
      timezone: record.timezone,
      times: record.times,
      destination: record.destination,
      minImportance: record.minImportance,
      minRelevance: record.minRelevance,
      minNovelty: record.minNovelty,
      requireAiRecommendation: record.requireAiRecommendation,
      maxAnalyze: record.maxAnalyze,
      maxSend: record.maxSend,
      gapSearchEnabled: record.gapSearchEnabled,
      gapSearchQueries: record.gapSearchQueries,
      publishMode: record.publishMode,
      bulletinTimes: record.bulletinTimes,
    },
    status: {
      persisted: Boolean(record.id),
      enabled: record.enabled,
      nextRunAt: next.nextRunAt,
      nextRunSlot: next.nextRunSlot,
      lastRunAt: record.lastRunAt ? record.lastRunAt.toISOString() : null,
      lastRunSlot: record.lastRunSlot,
      lastResult: record.lastResult,
      lastBulletinAt: record.lastBulletinAt ? record.lastBulletinAt.toISOString() : null,
      lastBulletinSlot: record.lastBulletinSlot,
      lastTickAt: record.lastTickAt ? record.lastTickAt.toISOString() : null,
      // No tick for 15+ minutes => the GitHub Actions cron is not firing.
      cronStale: !record.lastTickAt || Date.now() - record.lastTickAt.getTime() > 15 * 60 * 1000,
      nextBulletinAt: (() => {
        const bulletinNext = computeNextBulletinRun({ now: new Date(), config: record });
        return bulletinNext ? bulletinNext.at.toISOString() : null;
      })(),
      dueReason: due.due ? "due" : due.reason,
      running: isScheduledRunInProgress(),
    },
    destinationsReady: { local: true, bale: bale.configured },
    baleMissing: bale.missing,
    description: describeSchedule(record),
  });
}

/**
 * PUT /api/agent/scheduler — save the schedule.
 * Requires admin access (cookie from the login popup, x-admin-key header, or
 * ?key= when ADMIN_ACCESS_KEY is configured on the host).
 */
export async function PUT(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  const validation = validateScheduleInput(body);
  if (!validation.ok) {
    return Response.json(
      { success: false, message: "زمان‌بندی نامعتبر است.", errors: validation.errors },
      { status: 400 },
    );
  }

  try {
    const saved = await saveScheduleConfig(validation.config);
    const bale = getBaleConfigStatus();
    const next = nextRunInfo(saved);

    return Response.json({
      success: true,
      message: "زمان‌بندی ذخیره شد.",
      config: validation.config,
      status: {
        persisted: Boolean(saved.id),
        enabled: saved.enabled,
        nextRunAt: next.nextRunAt,
        nextRunSlot: next.nextRunSlot,
        lastRunAt: saved.lastRunAt ? saved.lastRunAt.toISOString() : null,
        lastRunSlot: saved.lastRunSlot,
        lastResult: saved.lastResult,
      },
      destinationsReady: { local: true, bale: bale.configured },
      baleMissing: bale.missing,
      description: describeSchedule(saved),
    });
  } catch (error) {
    console.error("[scheduler] save failed:", String(error).slice(0, 200));
    // Classify the failure so the operator sees the actionable cause (e.g. the
    // DNS/hostaddr recipe) instead of a bare "save failed".
    const diagnosis = diagnoseDbError(error);
    return Response.json(
      {
        success: false,
        message: "ذخیره زمان‌بندی ناموفق بود.",
        hint: diagnosis.hint,
        code: diagnosis.code ?? null,
        detail: diagnosis.detail.slice(0, 300),
      },
      { status: diagnosis.status },
    );
  }
}

/**
 * POST /api/agent/scheduler — run a pass right now (manual catch-up).
 * Body `{ "kind": "bulletin" }` builds/sends the digest immediately (the
 * dashboard's «ارسال فوری بولتن» button); anything else runs the regular
 * fetch→analyze→send pass. The scheduled slots are left untouched.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  if (isScheduledRunInProgress()) {
    return Response.json(
      { success: false, message: "یک اجرای زمان‌بندی‌شده در حال انجام است؛ چند لحظه بعد دوباره تلاش کنید." },
      { status: 409 },
    );
  }

  let passKind: "regular" | "bulletin" = "regular";
  try {
    const body = (await request.json()) as { kind?: string } | null;
    if (body?.kind === "bulletin") passKind = "bulletin";
  } catch {
    // Empty/non-JSON body => regular pass (the common manual button).
  }

  const record = await readScheduleRecord();
  const config = coerceScheduleConfig(record);
  const summary = await runScheduledPass({ config, trigger: "manual", slotKey: null, passKind });

  await recordRunResult(record.id, summary);

  return Response.json({ success: true, summary });
}
