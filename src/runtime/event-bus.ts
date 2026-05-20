import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EVENTS_REL = "runtime/events/events.jsonl";

export const RUNTIME_EVENT_SOURCE_REGISTRY = {
  "gateway-task-scheduler": [
    "scheduler_started",
    "scheduler_state_changed",
    "scheduler_tick",
    "scheduler_tick_started",
    "scheduler_tick_skipped",
    "scheduler_tick_completed",
    "scheduler_tick_failed",
    "scheduler_max_ticks_reached",
  ],
  "gateway-task-state-machine": ["task_reconciled", "task_state_reconcile_completed"],
  "gateway-policy-engine": ["policy_decision", "policy_evaluation_completed"],
  "gateway-policy-action-executor": ["policy_action_planned", "policy_action_skipped", "policy_action_dry_run_completed", "policy_action_executed_shadow", "policy_action_apply_shadow_completed", "policy_action_executed_copy", "policy_action_apply_copy_completed"],
  "gateway-auto-dispatcher": ["dispatch_plan_created", "dispatch_plan_skipped", "dispatch_plan_completed"],
  "gateway-runtime-loop": ["runtime_loop_tick_started", "runtime_loop_tick_completed", "runtime_loop_tick_skipped", "runtime_loop_tick_failed", "runtime_loop_apply_smoke_started", "runtime_loop_dispatch_request_planned", "runtime_loop_apply_smoke_blocked", "runtime_loop_apply_smoke_dispatched", "runtime_loop_apply_smoke_completed", "runtime_loop_apply_smoke_return_processed", "smoke_task_registered", "smoke_task_registration_skipped", "task_dispatch_executed", "task_dispatch_failed", "runtime_loop_gateway_precheck_ok", "runtime_loop_gateway_precheck_failed", "runtime_loop_dispatch_aborted_before_spawn", "runtime_loop_continuous_apply_stop"],
} as const;

export type RuntimeEventSource = keyof typeof RUNTIME_EVENT_SOURCE_REGISTRY;

export interface RuntimeEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: RuntimeEventSource;
  payload: Record<string, unknown>;
}
export function createRuntimeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  source: RuntimeEventSource = "gateway-task-scheduler",
): RuntimeEvent {
  return {
    eventId: `${Date.now()}-${randomBytes(3).toString("hex")}`,
    eventType,
    timestamp: new Date().toISOString(),
    source,
    payload,
  };
}

export function emitEvent(workspaceRoot: string, event: RuntimeEvent): void {
  try {
    const eventsPath = path.join(workspaceRoot, EVENTS_REL);
    const eventsDir = path.dirname(eventsPath);
    if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Event emission must never block scheduler progress.
  }
}

export function getRecentEvents(workspaceRoot: string, limit: number): RuntimeEvent[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  try {
    const eventsPath = path.join(workspaceRoot, EVENTS_REL);
    if (!existsSync(eventsPath)) return [];

    const lines = readFileSync(eventsPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    const recentLines = lines.slice(-safeLimit);
    const events: RuntimeEvent[] = [];
    for (const line of recentLines) {
      try {
        const parsed = JSON.parse(line) as RuntimeEvent;
        events.push(parsed);
      } catch {
        // Skip corrupt JSONL records and keep returning remaining valid events.
      }
    }
    return events.slice(-safeLimit);
  } catch {
    return [];
  }
}
