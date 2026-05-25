import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveMaxTicks } from "./task-scheduler.js";

export const SCHEDULER_STATE_RELATIVE_PATH = "runtime/main/tmp/task-scheduler-state.json";
export const SCHEDULER_MARKER_RELATIVE_PATH = "runtime/main/tmp/task-scheduler-enabled.json";
export const SCHEDULER_POLICY_RELATIVE_PATH = "runtime/scheduler/scheduler-policy.json";
export const SCHEDULER_TICK_SCRIPT_RELATIVE_PATH = "evolution/run-auto-progress-tick.ps1";

const DEFAULT_TICK_INTERVAL_MS = 5000;
const DEFAULT_MAX_TICKS_PER_APPLY = 5;
const DEFAULT_TICK_TIMEOUT_MS = 120_000;
const DEFAULT_COOLDOWN_MS = 1000;
const DEFAULT_TASK_SELECTION_RULE = "lifo";
const DEFAULT_FAIL_BEHAVIOR = "stop";
const DEFAULT_FALLBACK_TO_OLD_TRIGGER = true;

export type SchedulerTickPlanDecision =
  | "disabled"
  | "already_running"
  | "observe_only"
  | "max_ticks_reached"
  | "would_spawn_apply_tick";

interface SchedulerTickPolicy {
  policyVersion: string;
  tickIntervalMs: number;
  maxTicksPerApply: number;
  tickTimeoutMs: number;
  cooldownMs: number;
  taskSelectionRule: string;
  failBehavior: string;
  fallbackToOldTrigger: boolean;
}

export interface SchedulerTickPlan {
  mode: "observe-only";
  plannedAt: string;
  workspaceRoot: string;
  decision: SchedulerTickPlanDecision;
  reason: string;
  enabled: boolean;
  markerMode: "observe" | "apply";
  stateStatus: string;
  running: boolean;
  totalTicks: number;
  nextTickIndex: number | null;
  maxTicks: {
    effective: number;
    reason: "global_max_ticks" | "per_task_max_ticks";
    global: number;
    perTask: number | null;
    perTaskId: string | null;
    reached: boolean;
  };
  policy: SchedulerTickPolicy;
  sourceFiles: {
    marker: string;
    state: string;
    policy: string;
    tickScript: string;
    tickScriptExists: boolean;
  };
  warnings: string[];
  constraintsVerified: {
    readOnly: "yes";
    markerWritten: "no";
    stateWritten: "no";
    eventEmitted: "no";
    scriptInvoked: "no";
    childProcessSpawned: "no";
    autoDispatchTriggered: "no";
    applied: "no";
  };
}

interface MarkerSnapshot {
  enabled: boolean;
  mode: "observe" | "apply";
}

interface StateSnapshot {
  status: string;
  running: boolean;
  totalTicks: number;
}

export function buildSchedulerTickPlan(
  workspaceRoot: string,
  options: { plannedAt?: string } = {},
): SchedulerTickPlan {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const marker = readMarkerSnapshot(workspaceRoot, warnings);
  const state = readStateSnapshot(workspaceRoot, warnings);
  const policy = loadPolicySnapshot(workspaceRoot, warnings);
  const maxTicksDecision = resolveMaxTicks(workspaceRoot, policy.maxTicksPerApply, warnings);
  const maxTicksReached =
    marker.mode === "apply" && state.totalTicks >= maxTicksDecision.effectiveMaxTicks;
  const tickScriptPath = path.join(workspaceRoot, SCHEDULER_TICK_SCRIPT_RELATIVE_PATH);
  const decision = resolveDecision(marker.enabled, marker.mode, state.running, maxTicksReached);

  return {
    mode: "observe-only",
    plannedAt,
    workspaceRoot,
    decision,
    reason: reasonForDecision(decision, maxTicksDecision.reason),
    enabled: marker.enabled,
    markerMode: marker.mode,
    stateStatus: state.status,
    running: state.running,
    totalTicks: state.totalTicks,
    nextTickIndex: decision === "would_spawn_apply_tick" ? state.totalTicks + 1 : null,
    maxTicks: {
      effective: maxTicksDecision.effectiveMaxTicks,
      reason: maxTicksDecision.reason,
      global: maxTicksDecision.globalMaxTicks,
      perTask: maxTicksDecision.perTaskMaxTicks,
      perTaskId: maxTicksDecision.perTaskId,
      reached: maxTicksReached,
    },
    policy,
    sourceFiles: {
      marker: SCHEDULER_MARKER_RELATIVE_PATH,
      state: SCHEDULER_STATE_RELATIVE_PATH,
      policy: SCHEDULER_POLICY_RELATIVE_PATH,
      tickScript: SCHEDULER_TICK_SCRIPT_RELATIVE_PATH,
      tickScriptExists: existsSync(tickScriptPath),
    },
    warnings,
    constraintsVerified: {
      readOnly: "yes",
      markerWritten: "no",
      stateWritten: "no",
      eventEmitted: "no",
      scriptInvoked: "no",
      childProcessSpawned: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    },
  };
}

function resolveDecision(
  enabled: boolean,
  markerMode: "observe" | "apply",
  running: boolean,
  maxTicksReached: boolean,
): SchedulerTickPlanDecision {
  if (!enabled) return "disabled";
  if (running) return "already_running";
  if (markerMode === "observe") return "observe_only";
  if (maxTicksReached) return "max_ticks_reached";
  return "would_spawn_apply_tick";
}

function reasonForDecision(
  decision: SchedulerTickPlanDecision,
  maxTicksReason: "global_max_ticks" | "per_task_max_ticks",
): string {
  if (decision === "disabled") return "scheduler marker is disabled";
  if (decision === "already_running") return "scheduler state is already running";
  if (decision === "observe_only") return "scheduler marker is enabled in observe mode";
  if (decision === "max_ticks_reached")
    return `scheduler apply max ticks reached (${maxTicksReason})`;
  return "scheduler would spawn the apply tick script in current legacy runtime";
}

function readMarkerSnapshot(workspaceRoot: string, warnings: string[]): MarkerSnapshot {
  const markerPath = path.join(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH);
  if (!existsSync(markerPath)) {
    warnings.push("scheduler marker file not found, treating scheduler as disabled");
    return { enabled: false, mode: "observe" };
  }

  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    if (raw.mode !== undefined && raw.mode !== "apply" && raw.mode !== "observe") {
      warnings.push(`scheduler marker mode invalid (${JSON.stringify(raw.mode)}), using observe`);
    }
    return {
      enabled: raw.enabled === true,
      mode: raw.mode === "apply" ? "apply" : "observe",
    };
  } catch (err) {
    warnings.push(`scheduler marker parse error: ${String(err)}, treating scheduler as disabled`);
    return { enabled: false, mode: "observe" };
  }
}

function readStateSnapshot(workspaceRoot: string, warnings: string[]): StateSnapshot {
  const statePath = path.join(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH);
  if (!existsSync(statePath)) {
    warnings.push("scheduler state file not found, using empty state");
    return { status: "idle", running: false, totalTicks: 0 };
  }

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    return {
      status: typeof raw.status === "string" ? raw.status : "idle",
      running: raw.running === true,
      totalTicks:
        typeof raw.totalTicks === "number" && Number.isFinite(raw.totalTicks) && raw.totalTicks >= 0
          ? Math.floor(raw.totalTicks)
          : 0,
    };
  } catch (err) {
    warnings.push(`scheduler state parse error: ${String(err)}, using empty state`);
    return { status: "idle", running: false, totalTicks: 0 };
  }
}

function loadPolicySnapshot(workspaceRoot: string, warnings: string[]): SchedulerTickPolicy {
  const policyPath = path.join(workspaceRoot, SCHEDULER_POLICY_RELATIVE_PATH);
  if (!existsSync(policyPath)) {
    warnings.push("scheduler policy file not found, using safe defaults");
    return defaultPolicy("fallback");
  }

  try {
    const raw = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
    const policy: SchedulerTickPolicy = {
      policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : "unknown",
      tickIntervalMs: safeNumber(
        raw.tickIntervalMs,
        DEFAULT_TICK_INTERVAL_MS,
        1000,
        300_000,
        "tickIntervalMs",
        warnings,
      ),
      maxTicksPerApply: safeInt(
        raw.maxTicksPerApply,
        DEFAULT_MAX_TICKS_PER_APPLY,
        1,
        1000,
        "maxTicksPerApply",
        warnings,
      ),
      tickTimeoutMs: safeNumber(
        raw.tickTimeoutMs,
        DEFAULT_TICK_TIMEOUT_MS,
        5000,
        600_000,
        "tickTimeoutMs",
        warnings,
      ),
      cooldownMs: safeNumber(
        raw.cooldownMs,
        DEFAULT_COOLDOWN_MS,
        0,
        60_000,
        "cooldownMs",
        warnings,
      ),
      taskSelectionRule: safeEnum(
        raw.taskSelectionRule,
        ["lifo", "fifo", "priority"],
        DEFAULT_TASK_SELECTION_RULE,
        "taskSelectionRule",
        warnings,
      ),
      failBehavior: safeEnum(
        raw.failBehavior,
        ["stop", "skip", "retry-once"],
        DEFAULT_FAIL_BEHAVIOR,
        "failBehavior",
        warnings,
      ),
      fallbackToOldTrigger:
        typeof raw.fallbackToOldTrigger === "boolean"
          ? raw.fallbackToOldTrigger
          : DEFAULT_FALLBACK_TO_OLD_TRIGGER,
    };
    warnings.push("taskSelectionRule is reserved/no-op in this scheduler version");
    warnings.push("failBehavior is reserved/no-op in this scheduler version");
    warnings.push("fallbackToOldTrigger is reserved/no-op in this scheduler version");
    return policy;
  } catch (err) {
    warnings.push(`scheduler policy parse error: ${String(err)}, using safe defaults`);
    return defaultPolicy("fallback");
  }
}

function defaultPolicy(policyVersion: string): SchedulerTickPolicy {
  return {
    policyVersion,
    tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
    maxTicksPerApply: DEFAULT_MAX_TICKS_PER_APPLY,
    tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    taskSelectionRule: DEFAULT_TASK_SELECTION_RULE,
    failBehavior: DEFAULT_FAIL_BEHAVIOR,
    fallbackToOldTrigger: DEFAULT_FALLBACK_TO_OLD_TRIGGER,
  };
}

function safeNumber(
  raw: unknown,
  def: number,
  min: number,
  max: number,
  name: string,
  warnings: string[],
): number {
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

function safeInt(
  raw: unknown,
  def: number,
  min: number,
  max: number,
  name: string,
  warnings: string[],
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    warnings.push(`${name} invalid/missing, using default ${def}`);
    return def;
  }
  return safeNumber(raw, def, min, max, name, warnings);
}

function safeEnum(
  raw: unknown,
  allowed: string[],
  def: string,
  name: string,
  warnings: string[],
): string {
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    warnings.push(`${name} invalid/missing (got: ${JSON.stringify(raw)}), using default ${def}`);
    return def;
  }
  return raw;
}
