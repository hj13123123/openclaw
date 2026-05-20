import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeEvent, emitEvent } from "./event-bus.js";
import type { TaskRecord } from "./task-state-machine.js";

const TASKS_REL = "runtime/tasks/tasks.jsonl";
const POLICY_RULES_REL = "runtime/policy/policy-rules.json";
const ACTION_AUDIT_REL = "runtime/policy/action-audit.jsonl";
const DISPATCH_PLAN_REL = "runtime/dispatch/dispatch-plan.jsonl";
const DEFAULT_LIMIT = 3;

type DispatchBlockedReason =
  | "stale_queued_batch_completed"
  | "status_completed"
  | "status_blocked_by_policy"
  | "status_deferred"
  | "status_quarantined"
  | "missing_source_role"
  | "missing_policy_decision"
  | "missing_risk_level"
  | "risk_L3_block"
  | "risk_L2_defer"
  | "already_executed";

export interface DispatchPlanItem {
  taskId: string;
  targetRole: string;
  wouldDispatch: boolean;
  blockedReason?: DispatchBlockedReason;
  riskLevel: string;
  policyAction: string;
}

export interface DispatchInputStats {
  totalTasks: number;
  completed: number;
  blockedByPolicy: number;
  deferred: number;
  quarantined: number;
  queued: number;
}

export interface DispatchPlan {
  runId: string;
  generatedAt: string;
  mode: "dry_run";
  limit: number;
  inputStats: DispatchInputStats;
  hardBlocked: string[];
  candidates: {
    total: number;
    eligible: number;
    skipped: number;
    wouldDispatch: number;
  };
  items: DispatchPlanItem[];
}

type LooseTaskRecord = Partial<TaskRecord> & Record<string, unknown>;

function workspacePath(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, rel);
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readJsonlTasks(workspaceRoot: string): LooseTaskRecord[] {
  const filePath = workspacePath(workspaceRoot, TASKS_REL);
  if (!existsSync(filePath)) return [];

  const tasks: LooseTaskRecord[] = [];
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) tasks.push(parsed as LooseTaskRecord);
    } catch {
      const taskId = /"taskId"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      const status = /"status"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      const sourceRole = /"sourceRole"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      const riskLevel = /"riskLevel"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      const action = /"action"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      if (taskId && status) {
        tasks.push({
          taskId,
          status: status as TaskRecord["status"],
          ...(sourceRole ? { sourceRole } : {}),
          ...(riskLevel || action ? { policyDecision: { riskLevel, action } } : {}),
        } as LooseTaskRecord);
      }
    }
  }
  return tasks;
}

function readExecutedTaskIds(workspaceRoot: string): Set<string> {
  const filePath = workspacePath(workspaceRoot, ACTION_AUDIT_REL);
  const executed = new Set<string>();
  if (!existsSync(filePath)) return executed;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { taskId?: unknown; mode?: unknown };
      if (typeof parsed.taskId === "string" && parsed.mode !== "dry_run") executed.add(parsed.taskId);
    } catch {
      const taskId = /"taskId"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      const mode = /"mode"\s*:\s*"([^"\r\n]+)"/u.exec(line)?.[1];
      if (taskId && mode && mode !== "dry_run") executed.add(taskId);
    }
  }
  return executed;
}

function inputStats(tasks: LooseTaskRecord[]): DispatchInputStats {
  return {
    totalTasks: tasks.length,
    completed: tasks.filter((task) => task.status === "completed").length,
    blockedByPolicy: tasks.filter((task) => task.status === "blocked_by_policy").length,
    deferred: tasks.filter((task) => task.status === "deferred").length,
    quarantined: tasks.filter((task) => task.status === "quarantined").length,
    queued: tasks.filter((task) => task.status === "queued").length,
  };
}

function sourceText(task: LooseTaskRecord): string {
  return [
    task.taskId,
    task.summary,
    task.sourceRole,
    normalizeText(task.metadata),
    normalizeText(task.policyDecision),
  ].join("\n").toLowerCase();
}

function isHardBlocked(task: LooseTaskRecord): boolean {
  const taskId = typeof task.taskId === "string" ? task.taskId : "";
  if (/^(EP-8|EP-9|A1.*)$/u.test(taskId)) return true;
  const text = sourceText(task);
  return text.includes("src/")
    || text.includes("src\\")
    || text.includes("build")
    || text.includes("restart")
    || text.includes("config")
    || text.includes("provider")
    || text.includes("engineering_rules");
}

function targetRole(task: LooseTaskRecord): string {
  return typeof task.sourceRole === "string" && task.sourceRole.trim() ? task.sourceRole : "unknown";
}

function policyRisk(task: LooseTaskRecord): string | undefined {
  const decision = task.policyDecision;
  if (decision && typeof decision === "object" && "riskLevel" in decision) {
    const value = (decision as { riskLevel?: unknown }).riskLevel;
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  return undefined;
}

function policyAction(task: LooseTaskRecord): string | undefined {
  const decision = task.policyDecision;
  if (decision && typeof decision === "object" && "action" in decision) {
    const value = (decision as { action?: unknown }).action;
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  return undefined;
}

function isStaleQueuedBatch6(task: LooseTaskRecord): boolean {
  return typeof task.taskId === "string" && task.status === "queued" && task.taskId.startsWith("P1-BATCH6-");
}

function planTask(task: LooseTaskRecord, executedTaskIds: Set<string>): DispatchPlanItem | null {
  if (!task.taskId || typeof task.taskId !== "string") return null;
  const base = {
    taskId: task.taskId,
    targetRole: targetRole(task),
    riskLevel: policyRisk(task) ?? "N/A",
    policyAction: policyAction(task) ?? "N/A",
  };

  if (isStaleQueuedBatch6(task)) {
    return { ...base, wouldDispatch: false, blockedReason: "stale_queued_batch_completed" };
  }

  if (isHardBlocked(task)) return null;

  switch (task.status) {
    case "completed":
      return { ...base, wouldDispatch: false, blockedReason: "status_completed" };
    case "blocked_by_policy":
      return { ...base, wouldDispatch: false, blockedReason: "status_blocked_by_policy" };
    case "deferred":
      return { ...base, wouldDispatch: false, blockedReason: "status_deferred" };
    case "quarantined":
      return { ...base, wouldDispatch: false, blockedReason: "status_quarantined" };
    default:
      break;
  }

  if (!task.sourceRole) return { ...base, wouldDispatch: false, blockedReason: "missing_source_role" };
  if (!task.policyDecision) return { ...base, wouldDispatch: false, blockedReason: "missing_policy_decision" };

  const riskLevel = policyRisk(task);
  if (!riskLevel) return { ...base, wouldDispatch: false, blockedReason: "missing_risk_level" };
  if (riskLevel === "L3") return { ...base, riskLevel, wouldDispatch: false, blockedReason: "risk_L3_block" };
  if (riskLevel === "L2") return { ...base, riskLevel, wouldDispatch: false, blockedReason: "risk_L2_defer" };
  if (executedTaskIds.has(task.taskId)) return { ...base, wouldDispatch: false, blockedReason: "already_executed" };

  return { ...base, wouldDispatch: true };
}

function readPolicyRulesForPresence(workspaceRoot: string): void {
  const filePath = workspacePath(workspaceRoot, POLICY_RULES_REL);
  if (existsSync(filePath)) readFileSync(filePath, "utf8");
}

export function generateDispatchPlan(workspaceRoot: string, limit = DEFAULT_LIMIT): DispatchPlan {
  readPolicyRulesForPresence(workspaceRoot);
  const tasks = readJsonlTasks(workspaceRoot);
  const executedTaskIds = readExecutedTaskIds(workspaceRoot);
  const hardBlocked = tasks
    .filter((task) => typeof task.taskId === "string" && /^(EP-8|EP-9|A1.*)$/u.test(task.taskId))
    .map((task) => task.taskId as string)
    .filter((taskId, index, all) => all.indexOf(taskId) === index);

  const staleQueued = tasks.filter(isStaleQueuedBatch6).slice(0, Math.max(0, Math.floor(limit)));
  const items = staleQueued
    .map((task) => planTask(task, executedTaskIds))
    .filter((item): item is DispatchPlanItem => item !== null);

  const wouldDispatch = items.filter((item) => item.wouldDispatch).length;
  const skipped = items.length - wouldDispatch;

  return {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    mode: "dry_run",
    limit,
    inputStats: inputStats(tasks),
    hardBlocked,
    candidates: {
      total: items.length,
      eligible: wouldDispatch,
      skipped,
      wouldDispatch,
    },
    items,
  };
}

export function writeDispatchPlan(workspaceRoot: string, plan: DispatchPlan): void {
  const planPath = workspacePath(workspaceRoot, DISPATCH_PLAN_REL);
  const planDir = path.dirname(planPath);
  if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");

  for (const item of plan.items) {
    const eventType = item.wouldDispatch ? "dispatch_plan_created" : "dispatch_plan_skipped";
    emitEvent(workspaceRoot, createRuntimeEvent(eventType, {
      runId: plan.runId,
      mode: plan.mode,
      ...item,
    }, "gateway-auto-dispatcher"));
  }

  emitEvent(workspaceRoot, createRuntimeEvent("dispatch_plan_completed", {
    runId: plan.runId,
    mode: plan.mode,
    totalCandidates: plan.candidates.total,
    eligible: plan.candidates.eligible,
    skipped: plan.candidates.skipped,
    wouldDispatch: plan.candidates.wouldDispatch,
  }, "gateway-auto-dispatcher"));
}

export function runAutoDispatcherDryRun(workspaceRoot: string, limit = DEFAULT_LIMIT): DispatchPlan {
  const plan = generateDispatchPlan(workspaceRoot, limit);
  writeDispatchPlan(workspaceRoot, plan);
  return plan;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === thisPath) {
  const workspaceRoot = process.argv[2] ?? process.cwd();
  const limitArg = process.argv[3] ? Number.parseInt(process.argv[3], 10) : DEFAULT_LIMIT;
  const plan = runAutoDispatcherDryRun(workspaceRoot, Number.isFinite(limitArg) ? limitArg : DEFAULT_LIMIT);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
