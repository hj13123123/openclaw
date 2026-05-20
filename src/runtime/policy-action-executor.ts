import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRuntimeEvent, emitEvent } from "./event-bus.js";
import type { PolicyAction, RiskLevel } from "./policy-engine.js";
import type { TaskRecord } from "./task-state-machine.js";

const TASKS_REL = "runtime/tasks/tasks.jsonl";
const ACTION_AUDIT_REL = "runtime/policy/action-audit.jsonl";

export type ExecutableAction = "auto_close" | "auto_defer";
export type ActionPlanResult = "would_execute" | "would_skip" | "blocked";

export interface ActionPlanItem {
  taskId: string;
  policyAction: string;
  riskLevel: string;
  result: ActionPlanResult;
  skipReason?: string;
  sourcePath: string | null;
  intendedTargetPath: string | null;
}

export interface DryRunReport {
  generatedAt: string;
  mode: "dry_run";
  totalCandidates: number;
  wouldExecute: number;
  wouldSkip: number;
  blocked: number;
  items: ActionPlanItem[];
}

type TaskWithPolicyDecision = TaskRecord & {
  policyDecision: {
    decisionId: string;
    ruleId: string;
    riskLevel: RiskLevel;
    action: PolicyAction;
    reason: string;
    timestamp: string;
  };
};

function tasksPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, TASKS_REL);
}

function actionAuditPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ACTION_AUDIT_REL);
}

function normalizePathForPolicy(value: string | null | undefined): string {
  return (value ?? "").replaceAll("\\", "/");
}

function sourcePathFromTask(task: TaskRecord): string | null {
  const value = task.metadata?.sourcePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function absoluteSourcePath(workspaceRoot: string, sourcePath: string | null): string | null {
  if (!sourcePath) return null;
  return path.isAbsolute(sourcePath) ? sourcePath : path.join(workspaceRoot, sourcePath);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function intendedTargetPathForAction(task: TaskWithPolicyDecision, sourcePath: string | null): string | null {
  if (!sourcePath) return null;
  const fileName = path.basename(sourcePath);
  if (task.policyDecision.action === "auto_close") {
    return normalizePathForPolicy(path.join("system", "returns", "archive", "consumed-returns", localDateKey(new Date()), fileName));
  }
  if (task.policyDecision.action === "auto_defer") {
    return normalizePathForPolicy(path.join("runtime", "human-gate", "deferred", fileName));
  }
  return null;
}

function isTaskWithPolicyDecision(value: unknown): value is TaskWithPolicyDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<TaskRecord>;
  const decision = task.policyDecision;
  return typeof task.taskId === "string"
    && !!decision
    && typeof decision === "object"
    && typeof decision.action === "string"
    && typeof decision.riskLevel === "string";
}

function readTasksWithPolicyDecision(workspaceRoot: string): TaskWithPolicyDecision[] {
  const filePath = tasksPath(workspaceRoot);
  if (!existsSync(filePath)) return [];

  const byTaskId = new Map<string, TaskWithPolicyDecision>();
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTaskWithPolicyDecision(parsed)) byTaskId.set(parsed.taskId, parsed);
    } catch {
      // Ignore corrupt JSONL records and keep planning from remaining valid tasks.
    }
  }
  return [...byTaskId.values()];
}

function actionSortRank(task: TaskWithPolicyDecision): number {
  if (task.policyDecision.riskLevel === "L0" && task.policyDecision.action === "auto_close") return 0;
  if (task.policyDecision.action === "auto_close") return 1;
  if (task.policyDecision.action === "auto_defer") return 2;
  return 3;
}

export function isHardBlocked(taskId: string, sourcePath: string | null): { blocked: boolean; reason?: string } {
  const normalizedTaskId = taskId.toUpperCase();
  const normalizedSourcePath = normalizePathForPolicy(sourcePath).toLowerCase();

  if (normalizedTaskId.includes("A1") || normalizedTaskId.includes("EP-9")) {
    return { blocked: true, reason: "blocked_by_policy: frozen task" };
  }
  if (normalizedSourcePath.includes("src/")) {
    return { blocked: true, reason: "blocked_by_policy: system source" };
  }
  if (normalizedSourcePath.includes("engineering_rules")) {
    return { blocked: true, reason: "blocked_by_policy: system rules" };
  }
  if (normalizedSourcePath.includes("continuity")) {
    return { blocked: true, reason: "blocked_by_policy: system continuity" };
  }
  if (normalizedSourcePath.includes("openclaw.json")) {
    return { blocked: true, reason: "blocked_by_policy: gateway config" };
  }
  if (normalizedSourcePath.includes("positions.json")) {
    return { blocked: true, reason: "blocked_by_policy: position config" };
  }
  return { blocked: false };
}

function planTask(workspaceRoot: string, task: TaskWithPolicyDecision): ActionPlanItem {
  const sourcePath = sourcePathFromTask(task);
  const intendedTargetPath = intendedTargetPathForAction(task, sourcePath);
  const hardBlock = isHardBlocked(task.taskId, sourcePath);
  if (hardBlock.blocked) {
    return {
      taskId: task.taskId,
      policyAction: task.policyDecision.action,
      riskLevel: task.policyDecision.riskLevel,
      result: "blocked",
      skipReason: hardBlock.reason,
      sourcePath,
      intendedTargetPath,
    };
  }

  if (task.taskId === "EP-8" && task.policyDecision.action === "auto_defer") {
    return {
      taskId: task.taskId,
      policyAction: task.policyDecision.action,
      riskLevel: task.policyDecision.riskLevel,
      result: "would_skip",
      skipReason: "preserved deferred, EP-8 remains deferred",
      sourcePath,
      intendedTargetPath,
    };
  }

  switch (task.policyDecision.action) {
    case "auto_close":
    case "auto_defer": {
      const absSourcePath = absoluteSourcePath(workspaceRoot, sourcePath);
      if (!absSourcePath || !existsSync(absSourcePath)) {
        return {
          taskId: task.taskId,
          policyAction: task.policyDecision.action,
          riskLevel: task.policyDecision.riskLevel,
          result: "would_skip",
          skipReason: "source file already archived or unavailable",
          sourcePath,
          intendedTargetPath,
        };
      }
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "would_execute",
        sourcePath,
        intendedTargetPath,
      };
    }
    case "retry":
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "blocked",
        skipReason: "retry not allowed in Phase A dry_run",
        sourcePath,
        intendedTargetPath,
      };
    case "quarantine":
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "blocked",
        skipReason: "quarantine recorded only in Phase A dry_run",
        sourcePath,
        intendedTargetPath,
      };
    case "block_by_policy":
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "blocked",
        skipReason: "already blocked by policy",
        sourcePath,
        intendedTargetPath,
      };
    case "human_gate":
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "would_skip",
        skipReason: "requires human gate",
        sourcePath,
        intendedTargetPath,
      };
    default:
      return {
        taskId: task.taskId,
        policyAction: task.policyDecision.action,
        riskLevel: task.policyDecision.riskLevel,
        result: "blocked",
        skipReason: "unsupported policy action",
        sourcePath,
        intendedTargetPath,
      };
  }
}

export function generateActionPlan(workspaceRoot: string, limit?: number): DryRunReport {
  const candidates = readTasksWithPolicyDecision(workspaceRoot)
    .sort((a, b) => (actionSortRank(a) - actionSortRank(b)) || a.taskId.localeCompare(b.taskId));
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : undefined;
  const selected = safeLimit === undefined ? candidates : candidates.slice(0, safeLimit);
  const items = selected.map((task) => planTask(workspaceRoot, task));

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry_run",
    totalCandidates: candidates.length,
    wouldExecute: items.filter((item) => item.result === "would_execute").length,
    wouldSkip: items.filter((item) => item.result === "would_skip").length,
    blocked: items.filter((item) => item.result === "blocked").length,
    items,
  };
}

export function writeDryRunAudit(workspaceRoot: string, report: DryRunReport): void {
  const auditPath = actionAuditPath(workspaceRoot);
  const auditDir = path.dirname(auditPath);
  if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });

  for (const item of report.items) {
    appendFileSync(auditPath, `${JSON.stringify({ ...item, mode: "dry_run", generatedAt: report.generatedAt })}\n`, "utf8");
    if (item.result === "would_execute") {
      emitEvent(workspaceRoot, createRuntimeEvent("policy_action_planned", item as unknown as Record<string, unknown>, "gateway-policy-action-executor"));
    } else {
      emitEvent(workspaceRoot, createRuntimeEvent("policy_action_skipped", item as unknown as Record<string, unknown>, "gateway-policy-action-executor"));
    }
  }

  emitEvent(workspaceRoot, createRuntimeEvent("policy_action_dry_run_completed", {
    generatedAt: report.generatedAt,
    mode: report.mode,
    totalCandidates: report.totalCandidates,
    wouldExecute: report.wouldExecute,
    wouldSkip: report.wouldSkip,
    blocked: report.blocked,
    itemCount: report.items.length,
  }, "gateway-policy-action-executor"));
}
