import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getRecentEvents } from "../runtime/event-bus.js";
import { writeHudStateSnapshot } from "../runtime/hud-state-refresh.js";
import { scanReturnInbox } from "../runtime/returns/return-inbox.js";
import {
  buildRuntimeLoopPreflight,
  tick as tickRuntimeLoop,
  writeRuntimeLoopDispatchProposal,
} from "../runtime/runtime-loop.js";
import { getTaskState } from "../runtime/task-state-machine.js";
import { sendJson } from "./http-common.js";

const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
const SCHEDULER_STATE_RELATIVE_PATH = "runtime/main/tmp/task-scheduler-state.json";
const HUD_REFRESH_SCRIPT_RELATIVE_PATH = "system/patrol/generate-hud-state.ps1";
const HUD_STATE_ROUTE = "/api/hud/state";
const HUD_REFRESH_ROUTE = "/api/hud/refresh";
const SCHEDULER_STATE_ROUTE = "/api/hud/scheduler-state";
const SCHEDULER_EVENTS_ROUTE = "/api/hud/scheduler-events";
const TASK_STATE_ROUTE = "/api/hud/task-state";
const POLICY_STATE_ROUTE = "/api/hud/policy-state";
const POLICY_ACTIONS_ROUTE = "/api/hud/policy-actions";
const RUNTIME_LOOP_ROUTE = "/api/hud/runtime-loop";
const RUNTIME_LOOP_PREFLIGHT_ROUTE = "/api/hud/runtime-loop/preflight";
const RUNTIME_LOOP_DISPATCH_PROPOSAL_ROUTE = "/api/hud/runtime-loop/dispatch-proposal";
const RUNTIME_LOOP_REFRESH_ROUTE = "/api/hud/runtime-loop/refresh";
const RETURN_INBOX_ROUTE = "/api/hud/return-inbox";
const RUNTIME_LOOP_STATE_RELATIVE_PATH = "runtime/main/tmp/runtime-loop-state.json";
const POLICY_RULES_RELATIVE_PATH = "runtime/policy/policy-rules.json";
const POLICY_ACTION_AUDIT_RELATIVE_PATH = "runtime/policy/action-audit.jsonl";
const RUNTIME_LOOP_DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const RUNTIME_LOOP_STALE_INTERVAL_MULTIPLIER = 3;

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

type RecentCompletionItem = {
  taskId: string;
  level: "L0" | "L1" | "L2";
  status: string;
  completedAt: string;
};

type RecentCompletions = {
  totalToday: number;
  lastCompletedAt: string | null;
  items: RecentCompletionItem[];
};

type RuntimeLoopFreshness = {
  status: "fresh" | "stale" | "missing" | "invalid";
  ageMs: number | null;
  staleAfterMs: number;
};

type RuntimeLoopHttpState = {
  tickId?: unknown;
  tick_at?: unknown;
  mode?: unknown;
  scheduler?: unknown;
  tasks?: unknown;
  dispatch_plan?: unknown;
  return_processor?: unknown;
  warnings?: unknown;
};

function resolveRuntimeLoopStaleAfterMs(state: { scheduler?: unknown }): number {
  const scheduler =
    state.scheduler && typeof state.scheduler === "object" && !Array.isArray(state.scheduler)
      ? (state.scheduler as Record<string, unknown>)
      : {};
  const intervalMs =
    typeof scheduler.intervalMs === "number" &&
    Number.isFinite(scheduler.intervalMs) &&
    scheduler.intervalMs > 0
      ? scheduler.intervalMs
      : null;
  return intervalMs
    ? Math.max(
        RUNTIME_LOOP_DEFAULT_STALE_AFTER_MS,
        intervalMs * RUNTIME_LOOP_STALE_INTERVAL_MULTIPLIER,
      )
    : RUNTIME_LOOP_DEFAULT_STALE_AFTER_MS;
}

export function summarizeRuntimeLoopFreshness(
  state: { tick_at?: unknown; scheduler?: unknown },
  nowMs = Date.now(),
): RuntimeLoopFreshness {
  const staleAfterMs = resolveRuntimeLoopStaleAfterMs(state);
  if (typeof state.tick_at !== "string" || !state.tick_at.trim()) {
    return { status: "missing", ageMs: null, staleAfterMs };
  }
  const tickMs = Date.parse(state.tick_at);
  if (!Number.isFinite(tickMs)) {
    return { status: "invalid", ageMs: null, staleAfterMs };
  }
  const ageMs = Math.max(0, nowMs - tickMs);
  return {
    status: ageMs > staleAfterMs ? "stale" : "fresh",
    ageMs,
    staleAfterMs,
  };
}

function buildRuntimeLoopHttpPayload(state: RuntimeLoopHttpState): Record<string, unknown> {
  const tasks =
    state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks)
      ? (state.tasks as Record<string, unknown>)
      : {};
  const returnProcessor =
    state.return_processor &&
    typeof state.return_processor === "object" &&
    !Array.isArray(state.return_processor)
      ? (state.return_processor as Record<string, unknown>)
      : {};
  const freshness = summarizeRuntimeLoopFreshness(state);
  const warnings = Array.isArray(state.warnings)
    ? state.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const freshnessWarnings =
    freshness.status === "stale"
      ? [
          `runtime loop snapshot is stale (${Math.floor((freshness.ageMs ?? 0) / 60_000)} minutes old)`,
        ]
      : freshness.status === "missing" || freshness.status === "invalid"
        ? [`runtime loop snapshot timestamp is ${freshness.status}`]
        : [];
  return {
    latest_tick_id: typeof state.tickId === "string" ? state.tickId : null,
    latest_tick_at: typeof state.tick_at === "string" ? state.tick_at : null,
    freshness,
    mode: state.mode === "observe" ? "observe" : "observe",
    task_summary: tasks,
    dispatch_plan_count: Array.isArray(state.dispatch_plan) ? state.dispatch_plan.length : 0,
    inbox_count: typeof returnProcessor.inbox_count === "number" ? returnProcessor.inbox_count : 0,
    warnings: [...warnings, ...freshnessWarnings],
  };
}

function getLocalDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCompletionNotice(filePath: string): RecentCompletionItem | null {
  try {
    const notice = JSON.parse(readFileSync(filePath, "utf8")) as {
      taskId?: unknown;
      summary?: unknown;
      createdAt?: unknown;
    };
    const summary = typeof notice.summary === "string" ? notice.summary : "";
    const levelMatch = summary.match(/\b(L0|L1|L2)\b/u);
    if (!levelMatch) return null;
    const statusMatch2 = summary.match(/\b(completed(?:_with_warn)?|PASS|failed)\b/u);
    const status = statusMatch2?.[1] ?? "unknown";
    const taskIdFromSummary = summary.trim().split(/\s+/u)[0] ?? "";
    const taskId =
      typeof notice.taskId === "string" && notice.taskId.trim() ? notice.taskId : taskIdFromSummary;
    const completedAt =
      typeof notice.createdAt === "string" && notice.createdAt.trim()
        ? notice.createdAt
        : statSync(filePath).mtime.toISOString();
    return {
      taskId,
      level: levelMatch[1] as "L0" | "L1" | "L2",
      status,
      completedAt,
    };
  } catch {
    return null;
  }
}

export function scanRecentCompletions(workspaceRoot: string): RecentCompletions {
  const inboxDir = path.join(workspaceRoot, "runtime", "notifications", "inbox");
  if (!existsSync(inboxDir)) {
    return { totalToday: 0, lastCompletedAt: null, items: [] };
  }

  const files = readdirSync(inboxDir)
    .filter((name) => /^notice-task_completed-.*\.json$/u.test(name))
    .map((name) => path.join(inboxDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const parsed = files
    .map(parseCompletionNotice)
    .filter((item): item is RecentCompletionItem => item !== null);
  const todayKey = getLocalDateKey(new Date());
  const totalToday = parsed.filter((item) => getLocalDateKey(item.completedAt) === todayKey).length;
  const items = parsed.slice(0, 5);
  return {
    totalToday,
    lastCompletedAt: items[0]?.completedAt ?? null,
    items,
  };
}

export async function handleHudStateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const hudStatePath = path.join(workspaceRoot, HUD_STATE_RELATIVE_PATH);
  const schedulerStatePath = path.join(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH);
  const hudRefreshScriptPath = path.join(workspaceRoot, HUD_REFRESH_SCRIPT_RELATIVE_PATH);
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const requestPath = requestUrl.pathname;
  if (
    requestPath !== HUD_STATE_ROUTE &&
    requestPath !== HUD_REFRESH_ROUTE &&
    requestPath !== SCHEDULER_STATE_ROUTE &&
    requestPath !== SCHEDULER_EVENTS_ROUTE &&
    requestPath !== TASK_STATE_ROUTE &&
    requestPath !== POLICY_STATE_ROUTE &&
    requestPath !== POLICY_ACTIONS_ROUTE &&
    requestPath !== RUNTIME_LOOP_ROUTE &&
    requestPath !== RUNTIME_LOOP_PREFLIGHT_ROUTE &&
    requestPath !== RUNTIME_LOOP_DISPATCH_PROPOSAL_ROUTE &&
    requestPath !== RUNTIME_LOOP_REFRESH_ROUTE &&
    requestPath !== RETURN_INBOX_ROUTE
  ) {
    return false;
  }

  if (requestPath === RETURN_INBOX_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      data: scanReturnInbox(workspaceRoot),
    });
    return true;
  }

  if (requestPath === RUNTIME_LOOP_PREFLIGHT_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      data: buildRuntimeLoopPreflight(workspaceRoot),
    });
    return true;
  }

  if (requestPath === RUNTIME_LOOP_DISPATCH_PROPOSAL_ROUTE) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      created: true,
      mode: "proposal-only",
      data: writeRuntimeLoopDispatchProposal(workspaceRoot),
    });
    return true;
  }

  if (requestPath === RUNTIME_LOOP_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      const state = JSON.parse(
        await readFile(path.join(workspaceRoot, RUNTIME_LOOP_STATE_RELATIVE_PATH), "utf8"),
      ) as RuntimeLoopHttpState;
      sendJson(res, 200, {
        ok: true,
        data: buildRuntimeLoopHttpPayload(state),
      });
    } catch {
      sendJson(res, 200, { ok: true, data: null });
    }
    return true;
  }
  if (requestPath === SCHEDULER_STATE_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      const state = JSON.parse(await readFile(schedulerStatePath, "utf8")) as Record<
        string,
        unknown
      >;
      sendJson(res, 200, {
        enabled: state.enabled ?? false,
        mode: state.mode ?? "observe",
        status: state.status ?? "disabled",
        totalTicks: state.totalTicks ?? 0,
        maxTicks: state.maxTicks ?? null,
        maxTicksReached: state.maxTicksReached ?? false,
        lastExitCode: state.lastExitCode ?? null,
        lastTickFinishedAt: state.lastTickFinishedAt ?? null,
        lastTickStartedAt: state.lastTickStartedAt ?? null,
        skippedBecauseRunning: state.skippedBecauseRunning ?? 0,
        skippedBecauseDisabled: state.skippedBecauseDisabled ?? 0,
        skippedBecauseMaxTicks: state.skippedBecauseMaxTicks ?? 0,
        running: state.running ?? false,
        policyWarnings: Array.isArray(state.policyWarnings) ? state.policyWarnings : [],
      });
    } catch {
      sendJson(res, 200, {
        enabled: false,
        mode: "observe",
        status: "disabled",
        totalTicks: 0,
        maxTicks: null,
        maxTicksReached: false,
        lastExitCode: null,
        lastTickFinishedAt: null,
        lastTickStartedAt: null,
        skippedBecauseRunning: 0,
        skippedBecauseDisabled: 0,
        skippedBecauseMaxTicks: 0,
        running: false,
        policyWarnings: [],
      });
    }
    return true;
  }

  if (requestPath === SCHEDULER_EVENTS_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const rawLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "10", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(0, rawLimit)) : 10;
    sendJson(res, 200, getRecentEvents(workspaceRoot, limit));
    return true;
  }

  if (requestPath === POLICY_STATE_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    let policyVersion: string | null = null;
    let rulesCount = 0;
    let enabledCount = 0;
    try {
      const rulesFile = JSON.parse(
        await readFile(path.join(workspaceRoot, POLICY_RULES_RELATIVE_PATH), "utf8"),
      ) as {
        policyVersion?: unknown;
        rules?: unknown;
      };
      policyVersion = typeof rulesFile.policyVersion === "string" ? rulesFile.policyVersion : null;
      const rules = Array.isArray(rulesFile.rules) ? rulesFile.rules : [];
      rulesCount = rules.length;
      enabledCount = rules.filter(
        (rule) =>
          !!(rule && typeof rule === "object" && (rule as { enabled?: unknown }).enabled === true),
      ).length;
    } catch {
      policyVersion = null;
      rulesCount = 0;
      enabledCount = 0;
    }

    const events = getRecentEvents(workspaceRoot, 5000);
    const policyDecisionEvents = events.filter(
      (event) => event.source === "gateway-policy-engine" && event.eventType === "policy_decision",
    );
    const lastEvaluation =
      [...events]
        .reverse()
        .find(
          (event) =>
            event.source === "gateway-policy-engine" &&
            event.eventType === "policy_evaluation_completed",
        )?.timestamp ?? null;
    sendJson(res, 200, {
      policyVersion,
      rulesCount,
      enabledCount,
      lastEvaluation,
      recentDecisions: policyDecisionEvents
        .slice(-20)
        .reverse()
        .map((event) => event.payload),
    });
    return true;
  }

  if (requestPath === POLICY_ACTIONS_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      const auditPath = path.join(workspaceRoot, POLICY_ACTION_AUDIT_RELATIVE_PATH);
      const lines = (await readFile(auditPath, "utf8"))
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0);
      const recentItems = lines
        .slice(-50)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { malformed: true, raw: line };
          }
        })
        .reverse();
      sendJson(res, 200, {
        totalRecords: lines.length,
        recentItems,
      });
    } catch {
      sendJson(res, 200, {
        totalRecords: 0,
        recentItems: [],
      });
    }
    return true;
  }

  if (requestPath === TASK_STATE_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    sendJson(res, 200, getTaskState(workspaceRoot));
    return true;
  }

  if (requestPath === RUNTIME_LOOP_REFRESH_ROUTE) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      const state = tickRuntimeLoop(workspaceRoot);
      sendJson(res, 200, {
        refreshed: true,
        refreshMode: "observe-only",
        wouldDispatch: false,
        applied: false,
        data: buildRuntimeLoopHttpPayload(state),
      });
    } catch (error) {
      sendJson(res, 500, {
        refreshed: false,
        refreshMode: "observe-only",
        wouldDispatch: false,
        applied: false,
        error: `runtime loop observe refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return true;
  }

  if (requestPath === HUD_STATE_ROUTE) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      const body = await readFile(hudStatePath, "utf8");
      const recentCompletions = scanRecentCompletions(workspaceRoot);
      const enriched = { ...(JSON.parse(body) as Record<string, unknown>), recentCompletions };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(enriched));
    } catch {
      sendJson(res, 200, {
        available: false,
        message: "task-hud-state.json 尚未生成",
      });
    }
    return true;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  try {
    const result = writeHudStateSnapshot(workspaceRoot);
    sendJson(res, 200, {
      refreshed: true,
      generatedAt: result.generatedAt,
      statePath: result.statePath,
      warnings: result.warnings,
      refreshMode: "runtime",
    });
  } catch (runtimeError) {
    if (!existsSync(hudRefreshScriptPath)) {
      sendJson(res, 500, {
        refreshed: false,
        error: `任务看板刷新失败：${runtimeError instanceof Error ? runtimeError.message : String(runtimeError)}`,
      });
      return true;
    }

    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${hudRefreshScriptPath}"`, {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
      const state = JSON.parse(await readFile(hudStatePath, "utf8")) as {
        generatedAt?: string;
        warnings?: unknown;
      };
      const warnings = Array.isArray(state.warnings) ? state.warnings : [];
      sendJson(res, 200, {
        refreshed: true,
        generatedAt: state.generatedAt ?? null,
        statePath: HUD_STATE_RELATIVE_PATH,
        warnings,
        refreshMode: "powershell_fallback",
      });
    } catch (fallbackError) {
      sendJson(res, 500, {
        refreshed: false,
        error: `任务看板刷新失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        runtimeError: runtimeError instanceof Error ? runtimeError.message : String(runtimeError),
      });
    }
  }
  return true;
}
