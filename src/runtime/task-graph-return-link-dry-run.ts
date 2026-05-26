import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isPlainObject, asNonEmptyString } from "./returns/return-consumer-plan.js";
import { RETURNS_INBOX_RELATIVE_PATH } from "./returns/return-inbox.js";
import { buildTaskGraphReturnPreview } from "./task-graph.js";

export interface TaskGraphReturnLinkDryRunPlan {
  returnId: string;
  taskId: string | null;
  reason: "no_matching_task_node" | "missing_task_id";
  linkable: boolean;
  blockedReasons: string[];
  proposedNode: {
    nodeId: string;
    taskId: string;
    role: string;
    status: "review_pending";
    returnId: string;
    humanGateRequired: true;
  } | null;
}

export interface TaskGraphReturnLinkDryRunResult {
  mode: "observe-only";
  dryRun: true;
  plannedAt: string;
  sourcePath: string;
  inboxPath: string;
  unmatchedReturnCount: number;
  candidateCount: number;
  linkableCount: number;
  blockedCount: number;
  plans: TaskGraphReturnLinkDryRunPlan[];
  graphErrorCount: number;
  warnings: string[];
  constraintsVerified: {
    readOnly: "yes";
    taskGraphWritten: "no";
    returnConsumed: "no";
    receiptWritten: "no";
    dispatchTriggered: "no";
    applied: "no";
  };
}

export interface TaskGraphReturnLinkDryRunOptions {
  plannedAt?: string;
  limit?: number;
}

function safeNodeId(taskId: string): string {
  const safeTaskId = taskId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return `return-link-${safeTaskId || "unknown"}`;
}

function readReturnRecord(workspaceRoot: string, returnId: string): Record<string, unknown> | null {
  const filePath = path.join(workspaceRoot, RETURNS_INBOX_RELATIVE_PATH, returnId);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nestedString(record: Record<string, unknown> | null, dottedPath: string): string | null {
  if (!record) return null;
  let current: unknown = record;
  for (const segment of dottedPath.split(".")) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return asNonEmptyString(current) ?? null;
}

function roleForReturn(workspaceRoot: string, returnId: string): string {
  const record = readReturnRecord(workspaceRoot, returnId);
  return (
    nestedString(record, "routing.sourceRole") ??
    nestedString(record, "role.roleId") ??
    "engineering-executive"
  );
}

function planLink(params: {
  workspaceRoot: string;
  returnId: string;
  taskId: string | null;
  reason: "no_matching_task_node" | "missing_task_id";
}): TaskGraphReturnLinkDryRunPlan {
  const blockedReasons: string[] = [];
  if (!params.taskId) blockedReasons.push("task_id_missing");
  if (params.reason === "missing_task_id") blockedReasons.push("return_missing_task_id");
  const linkable = blockedReasons.length === 0;
  return {
    returnId: params.returnId,
    taskId: params.taskId,
    reason: params.reason,
    linkable,
    blockedReasons,
    proposedNode:
      linkable && params.taskId
        ? {
            nodeId: safeNodeId(params.taskId),
            taskId: params.taskId,
            role: roleForReturn(params.workspaceRoot, params.returnId),
            status: "review_pending",
            returnId: params.returnId,
            humanGateRequired: true,
          }
        : null,
  };
}

export function buildTaskGraphReturnLinkDryRun(
  workspaceRoot: string,
  options: TaskGraphReturnLinkDryRunOptions = {},
): TaskGraphReturnLinkDryRunResult {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const preview = buildTaskGraphReturnPreview(workspaceRoot, { observedAt: plannedAt });
  const plans = preview.unmatchedReturns.map((item) =>
    planLink({
      workspaceRoot,
      returnId: item.returnId,
      taskId: item.taskId,
      reason: item.reason,
    }),
  );

  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    sourcePath: preview.sourcePath,
    inboxPath: preview.inboxPath,
    unmatchedReturnCount: preview.unmatchedReturnCount,
    candidateCount: plans.length,
    linkableCount: plans.filter((plan) => plan.linkable).length,
    blockedCount: plans.filter((plan) => !plan.linkable).length,
    plans: plans.slice(0, limit),
    graphErrorCount: preview.graphErrors.length,
    warnings: preview.graphErrors.map((error) => `${error.field}: ${error.message}`),
    constraintsVerified: {
      readOnly: "yes",
      taskGraphWritten: "no",
      returnConsumed: "no",
      receiptWritten: "no",
      dispatchTriggered: "no",
      applied: "no",
    },
  };
}
