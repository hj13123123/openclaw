import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRuntimeEvent, emitEvent } from "./event-bus.js";
import { evaluatePolicy } from "./policy-engine.js";
import type { PolicyDecision, RiskLevel, PolicyAction } from "./policy-engine.js";

const TASKS_REL = "runtime/tasks/tasks.jsonl";
const TASK_STATE_READ_LIMIT = 5000;

export type TaskStatus =
  | "queued"
  | "completed"
  | "failed"
  | "deferred"
  | "blocked_by_policy"
  | "quarantined"
  | "dispatched"
  | "running"
  | "return_received"
  | "processing_return"
  | "stale";

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  sourceRole?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  metadata: Record<string, unknown>;
  policyDecision?: {
    decisionId: string;
    ruleId: string;
    riskLevel: RiskLevel;
    action: PolicyAction;
    reason: string;
    timestamp: string;
  };
  retryCount?: number;
}

export interface TaskSummary {
  total: number;
  queued: number;
  completed: number;
  failed: number;
  deferred: number;
  blocked: number;
  quarantined: number;
  dispatched: number;
  running: number;
  return_received: number;
  processing_return: number;
  stale: number;
}

function tasksPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, TASKS_REL);
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstString(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = toStringValue(record[name]);
    if (value) return value;
  }
  return undefined;
}

function inferProcessedStatus(record: Record<string, unknown>): TaskStatus {
  const status = firstString(record, ["status", "result", "outcome", "decision"])?.toLowerCase() ?? "";
  if (status.includes("fail") || status === "failed" || status === "error") return "failed";
  return "completed";
}

function safeIsoFromRecord(record: Record<string, unknown>, filePath: string, names: string[]): string {
  for (const name of names) {
    const value = toStringValue(record[name]);
    if (value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return statSync(filePath).mtime.toISOString();
}

function listJsonFiles(dirPath: string): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function listConsumedReturnFiles(workspaceRoot: string): string[] {
  const root = path.join(workspaceRoot, "system", "returns", "archive", "consumed-returns");
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^20/u.test(entry.name))
      .flatMap((entry) => listJsonFiles(path.join(root, entry.name)));
  } catch {
    return [];
  }
}

function createTaskRecord(workspaceRoot: string, filePath: string, status: TaskStatus, sourceDir: string): TaskRecord {
  const record = readJsonFile(filePath);
  const taskId = firstString(record, ["taskId", "task_id", "id", "candidateId", "returnId"]) ?? path.basename(filePath, ".json");
  const createdAt = safeIsoFromRecord(record, filePath, ["createdAt", "created_at", "timestamp"]);
  const updatedAt = safeIsoFromRecord(record, filePath, ["updatedAt", "updated_at", "completedAt", "processedAt", "timestamp"]);
  const sourceRole = firstString(record, ["sourceRole", "source_role", "role", "agentId"]);
  const summary = firstString(record, ["summary", "message", "title", "description"]);
  return {
    taskId,
    status,
    ...(sourceRole ? { sourceRole } : {}),
    createdAt,
    updatedAt,
    ...(summary ? { summary } : {}),
    metadata: {
      reconciledFrom: sourceDir,
      sourcePath: path.relative(workspaceRoot, filePath),
    },
  };
}

function collectCandidates(workspaceRoot: string): TaskRecord[] {
  const candidates: TaskRecord[] = [];
  for (const filePath of listJsonFiles(path.join(workspaceRoot, "system", "returns", "inbox"))) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, "queued", "system/returns/inbox"));
  }
  for (const filePath of listJsonFiles(path.join(workspaceRoot, "system", "returns", "processed"))) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, inferProcessedStatus(readJsonFile(filePath)), "system/returns/processed"));
  }
  for (const filePath of listJsonFiles(path.join(workspaceRoot, "system", "returns", "archive", "quarantine"))) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, "quarantined", "system/returns/archive/quarantine"));
  }
  for (const filePath of listConsumedReturnFiles(workspaceRoot)) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, "completed", "system/returns/archive/consumed-returns"));
  }
  for (const filePath of listJsonFiles(path.join(workspaceRoot, "runtime", "human-gate", "candidates"))) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, "blocked_by_policy", "runtime/human-gate/candidates"));
  }
  for (const filePath of listJsonFiles(path.join(workspaceRoot, "runtime", "human-gate", "deferred"))) {
    candidates.push(createTaskRecord(workspaceRoot, filePath, "deferred", "runtime/human-gate/deferred"));
  }
  return candidates;
}

function dedupeLastWriteWins(records: TaskRecord[]): TaskRecord[] {
  const sorted = [...records].sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
  const map = new Map<string, TaskRecord>();
  for (const record of sorted) map.set(record.taskId, record);
  return [...map.values()];
}

export function reconcileFromOldDirs(workspaceRoot: string): TaskRecord[] {
  const reconciled = dedupeLastWriteWins(collectCandidates(workspaceRoot));
  const outputPath = tasksPath(workspaceRoot);
  const outputDir = path.dirname(outputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  for (const record of reconciled) {
    appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
    emitEvent(workspaceRoot, createRuntimeEvent("task_reconciled", {
      taskId: record.taskId,
      status: record.status,
      sourceRole: record.sourceRole ?? null,
      updatedAt: record.updatedAt,
      reconciledFrom: record.metadata.reconciledFrom,
    }, "gateway-task-state-machine"));
  }
  return reconciled;
}

function emptySummary(): TaskSummary {
  return {
    total: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    blocked: 0,
    quarantined: 0,
    dispatched: 0,
    running: 0,
    return_received: 0,
    processing_return: 0,
    stale: 0,
  };
}

function summarize(tasks: TaskRecord[]): TaskSummary {
  const summary = emptySummary();
  summary.total = tasks.length;
  for (const task of tasks) {
    if (task.status === "blocked_by_policy") summary.blocked++;
    else if (task.status in summary) summary[task.status]++;
  }
  return summary;
}

export function getTaskState(workspaceRoot: string): { summary: TaskSummary; tasks: TaskRecord[] } {
  try {
    const outputPath = tasksPath(workspaceRoot);
    if (!existsSync(outputPath)) return { summary: emptySummary(), tasks: [] };
    const lines = readFileSync(outputPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .slice(-TASK_STATE_READ_LIMIT);
    const map = new Map<string, TaskRecord>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TaskRecord;
        if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
          map.set(parsed.taskId, parsed);
        }
      } catch {
        // Skip corrupt JSONL records and keep rebuilding from remaining lines.
      }
    }
    const tasks = [...map.values()].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    return { summary: summarize(tasks), tasks };
  } catch {
    return { summary: emptySummary(), tasks: [] };
  }
}

function toRecordedPolicyDecision(decision: PolicyDecision): TaskRecord["policyDecision"] {
  return {
    decisionId: decision.decisionId,
    ruleId: decision.ruleId,
    riskLevel: decision.riskLevel,
    action: decision.action,
    reason: decision.reason,
    timestamp: decision.timestamp,
  };
}

export function evaluateAndRecordPolicy(workspaceRoot: string): { tasks: TaskRecord[]; decisions: PolicyDecision[] } {
  const state = getTaskState(workspaceRoot);
  const decisions = evaluatePolicy(workspaceRoot, state.tasks);
  const outputPath = tasksPath(workspaceRoot);
  const outputDir = path.dirname(outputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const decisionByTaskId = new Map(decisions.map((decision) => [decision.taskId, decision]));
  const recordedTasks = state.tasks.map((task) => {
    const decision = decisionByTaskId.get(task.taskId);
    if (!decision) return task;
    const nextRecord: TaskRecord = {
      ...task,
      status: decision.newStatus,
      updatedAt: decision.timestamp,
      policyDecision: toRecordedPolicyDecision(decision),
      ...(decision.action === "retry" ? { retryCount: (task.retryCount ?? 0) + 1 } : {}),
    };
    appendFileSync(outputPath, `${JSON.stringify(nextRecord)}\n`, "utf8");
    emitEvent(workspaceRoot, createRuntimeEvent("policy_decision", {
      decisionId: decision.decisionId,
      taskId: decision.taskId,
      ruleId: decision.ruleId,
      riskLevel: decision.riskLevel,
      action: decision.action,
      reason: decision.reason,
      previousStatus: decision.previousStatus,
      newStatus: decision.newStatus,
      timestamp: decision.timestamp,
    }, "gateway-policy-engine"));
    return nextRecord;
  });

  emitEvent(workspaceRoot, createRuntimeEvent("policy_evaluation_completed", {
    evaluatedTasks: state.tasks.length,
    decisions: decisions.length,
    timestamp: new Date().toISOString(),
  }, "gateway-policy-engine"));

  return { tasks: recordedTasks, decisions };
}
