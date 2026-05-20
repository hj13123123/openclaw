import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRuntimeEvent, emitEvent } from "./event-bus.js";

const STATE_REL = "runtime/main/tmp/task-scheduler-state.json";
const MARKER_REL = "runtime/main/tmp/task-scheduler-enabled.json";
const POLICY_REL = "runtime/scheduler/scheduler-policy.json";
const TASKS_REL = "runtime/tasks/tasks.jsonl";

// ---- safe defaults (used when policy file is missing or unreadable) ----
const DEFAULT_TICK_INTERVAL_MS = 5000;
const DEFAULT_MAX_TICKS_PER_APPLY = 5;
const DEFAULT_TICK_TIMEOUT_MS = 120_000;
const DEFAULT_COOLDOWN_MS = 1000;
const DEFAULT_TASK_SELECTION_RULE = "lifo";
const DEFAULT_FAIL_BEHAVIOR = "stop";
const DEFAULT_FALLBACK_TO_OLD_TRIGGER = true;

// ---- policy interface ----
interface SchedulerPolicy {
  policyVersion: string;
  tickIntervalMs: number;
  maxTicksPerApply: number;
  tickTimeoutMs: number;
  cooldownMs: number;
  taskSelectionRule: string;
  failBehavior: string;
  fallbackToOldTrigger: boolean;
}

interface LoadedPolicy {
  policy: SchedulerPolicy;
  path: string;
  warnings: string[];
}

interface ActiveTaskMaxTicks {
  taskId: string;
  maxTicks: number;
  status: string;
  updatedAt: string | null;
}

interface MaxTicksDecision {
  effectiveMaxTicks: number;
  reason: "global_max_ticks" | "per_task_max_ticks";
  globalMaxTicks: number;
  perTaskMaxTicks: number | null;
  perTaskId: string | null;
}

// ---- state interface ----
interface SchedulerState {
  schedulerId: string;
  enabled: boolean;
  mode: "observe" | "apply";
  status: "idle" | "running" | "error" | "disabled";
  intervalMs: number;
  running: boolean;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  totalTicks: number;
  totalFailures: number;
  maxTicks: number | null;
  maxTicksReached: boolean;
  maxTicksReason?: "global_max_ticks" | "per_task_max_ticks";
  globalMaxTicks?: number | null;
  perTaskMaxTicks?: number | null;
  perTaskMaxTicksTaskId?: string | null;
  skippedBecauseRunning: number;
  skippedBecauseDisabled: number;
  skippedBecauseMaxTicks: number;
  observeOnlyTicks: number;
  startedAt: string;
  updatedAt: string;
  // P1-BATCH2: policy observability
  policyLoaded: boolean;
  policyPath: string | null;
  policyWarnings: string[];
}

// ---- init state ----
function initState(): SchedulerState {
  const now = new Date().toISOString();
  return {
    schedulerId: "gateway-task-scheduler",
    enabled: false,
    mode: "observe",
    status: "idle",
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
    running: false,
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastExitCode: null,
    lastError: null,
    totalTicks: 0,
    totalFailures: 0,
    maxTicks: null,
    maxTicksReached: false,
    maxTicksReason: "global_max_ticks",
    globalMaxTicks: null,
    perTaskMaxTicks: null,
    perTaskMaxTicksTaskId: null,
    skippedBecauseRunning: 0,
    skippedBecauseDisabled: 0,
    skippedBecauseMaxTicks: 0,
    observeOnlyTicks: 0,
    startedAt: now,
    updatedAt: now,
    policyLoaded: false,
    policyPath: null,
    policyWarnings: [],
  };
}

// ---- load policy ----
function loadPolicy(workspaceRoot: string): LoadedPolicy {
  const policyPath = path.join(workspaceRoot, POLICY_REL);
  const warnings: string[] = [];

  // policy file missing → safe defaults + warning
  if (!existsSync(policyPath)) {
    warnings.push("policy file not found, using safe defaults");
    return {
      policy: {
        policyVersion: "fallback",
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
        maxTicksPerApply: DEFAULT_MAX_TICKS_PER_APPLY,
        tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        taskSelectionRule: DEFAULT_TASK_SELECTION_RULE,
        failBehavior: DEFAULT_FAIL_BEHAVIOR,
        fallbackToOldTrigger: DEFAULT_FALLBACK_TO_OLD_TRIGGER,
      },
      path: policyPath,
      warnings,
    };
  }

  try {
    const raw = JSON.parse(readFileSync(policyPath, "utf8"));
    const policy: SchedulerPolicy = {
      policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : "unknown",
      tickIntervalMs: safeNumber(raw.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS, 1000, 300_000, "tickIntervalMs", warnings),
      maxTicksPerApply: safeInt(raw.maxTicksPerApply, DEFAULT_MAX_TICKS_PER_APPLY, 1, 1000, "maxTicksPerApply", warnings),
      tickTimeoutMs: safeNumber(raw.tickTimeoutMs, DEFAULT_TICK_TIMEOUT_MS, 5000, 600_000, "tickTimeoutMs", warnings),
      cooldownMs: safeNumber(raw.cooldownMs, DEFAULT_COOLDOWN_MS, 0, 60_000, "cooldownMs", warnings),
      taskSelectionRule: safeEnum(raw.taskSelectionRule, ["lifo", "fifo", "priority"], DEFAULT_TASK_SELECTION_RULE, "taskSelectionRule", warnings),
      failBehavior: safeEnum(raw.failBehavior, ["stop", "skip", "retry-once"], DEFAULT_FAIL_BEHAVIOR, "failBehavior", warnings),
      fallbackToOldTrigger: typeof raw.fallbackToOldTrigger === "boolean" ? raw.fallbackToOldTrigger : DEFAULT_FALLBACK_TO_OLD_TRIGGER,
    };
    warnings.push("taskSelectionRule is reserved/no-op in this scheduler version");
    warnings.push("failBehavior is reserved/no-op in this scheduler version");
    warnings.push("fallbackToOldTrigger is reserved/no-op in this scheduler version");
    return { policy, path: policyPath, warnings };
  } catch (err) {
    warnings.push(`policy file parse error: ${String(err)}, using safe defaults`);
    return {
      policy: {
        policyVersion: "fallback",
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
        maxTicksPerApply: DEFAULT_MAX_TICKS_PER_APPLY,
        tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        taskSelectionRule: DEFAULT_TASK_SELECTION_RULE,
        failBehavior: DEFAULT_FAIL_BEHAVIOR,
        fallbackToOldTrigger: DEFAULT_FALLBACK_TO_OLD_TRIGGER,
      },
      path: policyPath,
      warnings,
    };
  }
}

function safeNumber(raw: unknown, def: number, min: number, max: number, name: string, warnings: string[]): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push(`${name} invalid/missing, using default ${def}`);
    return def;
  }
  if (raw < min || raw > max) {
    warnings.push(`${name} out of range (${raw}), clamped`);
    return Math.max(min, Math.min(max, raw));
  }
  return raw;
}

function safeInt(raw: unknown, def: number, min: number, max: number, name: string, warnings: string[]): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    warnings.push(`${name} invalid/missing, using default ${def}`);
    return def;
  }
  return safeNumber(raw, def, min, max, name, warnings);
}

function safeEnum(raw: unknown, allowed: string[], def: string, name: string, warnings: string[]): string {
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    warnings.push(`${name} invalid/missing (got: ${JSON.stringify(raw)}), using default ${def}`);
    return def;
  }
  return raw;
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isActiveTaskStatus(status: unknown): status is string {
  return typeof status === "string" && ["queued", "dispatched", "running", "return_received", "processing_return"].includes(status);
}

function readActiveTaskMaxTicks(workspaceRoot: string, warnings: string[]): ActiveTaskMaxTicks | null {
  const tasksPath = path.join(workspaceRoot, TASKS_REL);
  if (!existsSync(tasksPath)) return null;

  try {
    const recordsByTaskId = new Map<string, Record<string, unknown>>();
    for (const line of readFileSync(tasksPath, "utf8").split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        const taskId = typeof record.taskId === "string" && record.taskId.trim().length > 0 ? record.taskId : null;
        if (!taskId) continue;
        recordsByTaskId.set(taskId, record);
      } catch {
        warnings.push("tasks.jsonl contains an unparsable line, ignored for per-task maxTicks");
      }
    }

    let selected: ActiveTaskMaxTicks | null = null;
    for (const [taskId, record] of recordsByTaskId) {
      if (!isActiveTaskStatus(record.status)) continue;
      const rawMaxTicks = record.maxTicks;
      if (rawMaxTicks === undefined || rawMaxTicks === null) continue;
      if (typeof rawMaxTicks !== "number" || !Number.isInteger(rawMaxTicks) || rawMaxTicks < 1 || rawMaxTicks > 1000) {
        warnings.push(`task ${taskId} maxTicks invalid (${JSON.stringify(rawMaxTicks)}), ignoring per-task maxTicks`);
        continue;
      }
      const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : (typeof record.createdAt === "string" ? record.createdAt : null);
      const candidate: ActiveTaskMaxTicks = {
        taskId,
        maxTicks: rawMaxTicks,
        status: record.status,
        updatedAt,
      };
      if (!selected || parseTimestampMs(candidate.updatedAt) >= parseTimestampMs(selected.updatedAt)) {
        selected = candidate;
      }
    }
    return selected;
  } catch (err) {
    warnings.push(`tasks.jsonl read error: ${String(err)}, using global maxTicksPerApply`);
    return null;
  }
}

export function resolveMaxTicks(workspaceRoot: string, globalMaxTicks: number, warnings: string[]): MaxTicksDecision {
  const activeTask = readActiveTaskMaxTicks(workspaceRoot, warnings);
  if (activeTask && activeTask.maxTicks <= globalMaxTicks) {
    return {
      effectiveMaxTicks: activeTask.maxTicks,
      reason: "per_task_max_ticks",
      globalMaxTicks,
      perTaskMaxTicks: activeTask.maxTicks,
      perTaskId: activeTask.taskId,
    };
  }
  return {
    effectiveMaxTicks: globalMaxTicks,
    reason: "global_max_ticks",
    globalMaxTicks,
    perTaskMaxTicks: activeTask?.maxTicks ?? null,
    perTaskId: activeTask?.taskId ?? null,
  };
}

// ---- state persistence ----
function readState(workspaceRoot: string): SchedulerState {
  const p = path.join(workspaceRoot, STATE_REL);
  if (!existsSync(p)) return initState();
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SchedulerState;
  } catch {
    return initState();
  }
}

function writeState(workspaceRoot: string, state: SchedulerState): void {
  const p = path.join(workspaceRoot, STATE_REL);
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

// ---- marker (开关 only) ----
function readMarker(workspaceRoot: string): { mode: string; enabled: boolean } {
  const p = path.join(workspaceRoot, MARKER_REL);
  if (!existsSync(p)) {
    return { mode: "observe", enabled: false };
  }
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as { mode?: string; enabled?: boolean };
    return { mode: m.mode ?? "observe", enabled: m.enabled === true };
  } catch {
    return { mode: "observe", enabled: false };
  }
}

// ---- scheduler entry point ----
export function startTaskScheduler(workspaceRoot: string): void {
  const tickScript = path.join(workspaceRoot, "evolution/run-auto-progress-tick.ps1");
  const markerDir = path.dirname(path.join(workspaceRoot, MARKER_REL));
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });

  // Initialize marker file (observe-only, disabled)
  const markerPath = path.join(workspaceRoot, MARKER_REL);
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, JSON.stringify({
      mode: "observe",
      enabled: false,
      updatedAt: new Date().toISOString(),
      updatedBy: "P1-BATCH1-install",
    }, null, 2), "utf8");
  }

  // Load policy
  const loaded = loadPolicy(workspaceRoot);
  const policy = loaded.policy;

  // Initialize state with policy observability
  const state = initState();
  state.intervalMs = policy.tickIntervalMs;
  state.maxTicks = policy.maxTicksPerApply;
  state.policyLoaded = true;
  state.policyPath = loaded.path;
  state.policyWarnings = loaded.warnings;
  writeState(workspaceRoot, state);

  console.log(`[task-scheduler] started (observe-only, disabled, interval=${policy.tickIntervalMs}ms, maxTicks=${policy.maxTicksPerApply}, policy=${loaded.path})`);
  emitEvent(workspaceRoot, createRuntimeEvent("scheduler_started", {
    enabled: state.enabled,
    mode: state.mode,
    intervalMs: state.intervalMs,
    maxTicks: state.maxTicks,
    policyPath: state.policyPath,
    policyWarnings: state.policyWarnings,
  }));

  setInterval(() => {
    try {
      const marker = readMarker(workspaceRoot);
      const s = readState(workspaceRoot);

      // P1-BATCH2: policy is re-read on each tick for runtime behavior values.
      // tickIntervalMs is startup-only because this interval timer is not rebuilt until restart.
      const livePolicy = loadPolicy(workspaceRoot);
      const policyWarnings = [...livePolicy.warnings];
      if (livePolicy.policy.tickIntervalMs !== policy.tickIntervalMs) {
        policyWarnings.push(`tickIntervalMs is startup-only (${policy.tickIntervalMs}ms active); restart required to apply ${livePolicy.policy.tickIntervalMs}ms`);
      }
      const previousMarker = { enabled: s.enabled, mode: s.mode };
      const nextMode = marker.mode === "apply" ? "apply" : "observe";
      s.enabled = marker.enabled;
      s.mode = nextMode;
      const maxTicksDecision = resolveMaxTicks(workspaceRoot, livePolicy.policy.maxTicksPerApply, policyWarnings);
      s.intervalMs = policy.tickIntervalMs;
      s.maxTicks = maxTicksDecision.effectiveMaxTicks;
      s.maxTicksReason = maxTicksDecision.reason;
      s.globalMaxTicks = maxTicksDecision.globalMaxTicks;
      s.perTaskMaxTicks = maxTicksDecision.perTaskMaxTicks;
      s.perTaskMaxTicksTaskId = maxTicksDecision.perTaskId;
      s.policyLoaded = true;
      s.policyPath = livePolicy.path;
      s.policyWarnings = policyWarnings;

      if (previousMarker.enabled !== s.enabled || previousMarker.mode !== s.mode) {
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_state_changed", {
          oldState: previousMarker,
          newState: { enabled: s.enabled, mode: s.mode },
        }));
      }

      if (!marker.enabled) {
        s.skippedBecauseDisabled++;
        s.status = "disabled";
        s.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s);
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_skipped", {
          reason: "disabled",
          enabled: s.enabled,
          mode: s.mode,
          skippedBecauseDisabled: s.skippedBecauseDisabled,
        }));
        return;
      }

      if (s.running) {
        s.skippedBecauseRunning++;
        s.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s);
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_skipped", {
          reason: "running",
          enabled: s.enabled,
          mode: s.mode,
          skippedBecauseRunning: s.skippedBecauseRunning,
        }));
        return;
      }

      if (marker.mode === "observe") {
        s.observeOnlyTicks++;
        s.status = "idle";
        s.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s);
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_skipped", {
          reason: "observe_only",
          enabled: s.enabled,
          mode: s.mode,
          observeOnlyTicks: s.observeOnlyTicks,
        }));
        return;
      }

      if (marker.mode === "apply" && s.maxTicks !== null && s.totalTicks >= s.maxTicks) {
        const wasMaxTicksReached = s.maxTicksReached;
        s.maxTicksReached = true;
        s.skippedBecauseMaxTicks++;
        s.status = "idle";
        s.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s);
        if (!wasMaxTicksReached) {
          emitEvent(workspaceRoot, createRuntimeEvent("scheduler_max_ticks_reached", {
            totalTicks: s.totalTicks,
            maxTicks: s.maxTicks,
            reason: s.maxTicksReason ?? "global_max_ticks",
            globalMaxTicks: s.globalMaxTicks ?? null,
            perTaskMaxTicks: s.perTaskMaxTicks ?? null,
            perTaskMaxTicksTaskId: s.perTaskMaxTicksTaskId ?? null,
          }));
        }
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_skipped", {
          reason: s.maxTicksReason ?? "global_max_ticks",
          enabled: s.enabled,
          mode: s.mode,
          totalTicks: s.totalTicks,
          maxTicks: s.maxTicks,
          globalMaxTicks: s.globalMaxTicks ?? null,
          perTaskMaxTicks: s.perTaskMaxTicks ?? null,
          perTaskMaxTicksTaskId: s.perTaskMaxTicksTaskId ?? null,
          skippedBecauseMaxTicks: s.skippedBecauseMaxTicks,
        }));
        return;
      }

      // APPLY mode: spawn tick (asynchronous, non-blocking)
      const tickIndex = s.totalTicks + 1;
      const tickStartedAtMs = Date.now();
      s.running = true;
      s.status = "running";
      s.lastTickStartedAt = new Date(tickStartedAtMs).toISOString();
      writeState(workspaceRoot, s);
      emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_started", {
        tickIndex,
        totalTicks: s.totalTicks,
        maxTicks: s.maxTicks,
        maxTicksReason: s.maxTicksReason ?? "global_max_ticks",
        globalMaxTicks: s.globalMaxTicks ?? null,
        perTaskMaxTicks: s.perTaskMaxTicks ?? null,
        perTaskMaxTicksTaskId: s.perTaskMaxTicksTaskId ?? null,
        startedAt: s.lastTickStartedAt,
      }));

      const child = spawn("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", tickScript, "-Apply",
        "-MaxRuns", "5", "-MaxDurationSec", String(Math.floor(livePolicy.policy.tickTimeoutMs / 1000)),
        "-CooldownSec", String(Math.floor(livePolicy.policy.cooldownMs / 1000)),
      ], { cwd: workspaceRoot, stdio: "pipe" });

      child.on("close", (code) => {
        const s2 = readState(workspaceRoot);
        s2.running = false;
        s2.status = code === 0 ? "idle" : "error";
        s2.lastTickFinishedAt = new Date().toISOString();
        s2.lastExitCode = code;
        s2.totalTicks++;
        s2.maxTicksReached = s2.maxTicks !== null && s2.totalTicks >= s2.maxTicks;
        if (code !== 0) s2.totalFailures++;
        s2.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s2);
        const durationMs = Date.now() - tickStartedAtMs;
        if (code === 0) {
          emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_completed", {
            tickIndex,
            durationMs,
            exitCode: code,
            totalTicks: s2.totalTicks,
          }));
        } else {
          emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_failed", {
            tickIndex,
            durationMs,
            exitCode: code,
            error: `scheduler tick exited with code ${code}`,
            totalFailures: s2.totalFailures,
          }));
        }
      });

      child.on("error", (err) => {
        const s3 = readState(workspaceRoot);
        s3.running = false;
        s3.status = "error";
        s3.lastError = err.message;
        s3.totalTicks++;
        s3.totalFailures++;
        s3.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s3);
        emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_failed", {
          tickIndex,
          durationMs: Date.now() - tickStartedAtMs,
          errorMessage: err.message,
          totalFailures: s3.totalFailures,
        }));
      });
    } catch (err) {
      try {
        const s = readState(workspaceRoot);
        s.lastError = String(err);
        s.updatedAt = new Date().toISOString();
        writeState(workspaceRoot, s);
      } catch { /* silent */ }
    }
  }, policy.tickIntervalMs);
}
