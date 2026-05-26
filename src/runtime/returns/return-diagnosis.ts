import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildTaskGraphReturnPreview } from "../task-graph.js";
import {
  asNonEmptyString,
  extractReturnPackageIdentity,
  isPlainObject,
  scanReturnConsumerPlan,
  type ReturnConsumerPlanScanItem,
} from "./return-consumer-plan.js";
import { RETURNS_INBOX_RELATIVE_PATH } from "./return-inbox.js";

export type ReturnCompatibility =
  | "v1-consumable"
  | "v1-invalid"
  | "v2-shaped"
  | "legacy-flat"
  | "unreadable";
export type ReturnTaskGraphStatus = "matched" | "unmatched" | "missing-task-id" | "unknown";
export type ReturnDiagnosisSuggestedAction =
  | "no-action"
  | "repair-to-v1-dry-run"
  | "link-task-graph-node"
  | "manual-review";

export interface ReturnDiagnosisIssue {
  code: string;
  field?: string;
  message: string;
}

export interface ReturnDiagnosisItem {
  sourceFile: string;
  returnId: string | null;
  taskId: string | null;
  planStatus: ReturnConsumerPlanScanItem["status"];
  planReason: string | null;
  compatibility: ReturnCompatibility;
  taskGraphStatus: ReturnTaskGraphStatus;
  suggestedAction: ReturnDiagnosisSuggestedAction;
  issues: ReturnDiagnosisIssue[];
}

export interface ReturnDiagnosisScanResult {
  mode: "observe-only";
  scannedAt: string;
  inboxPath: string;
  totalCount: number;
  diagnosableCount: number;
  byCompatibility: { compatibility: ReturnCompatibility; count: number }[];
  bySuggestedAction: { action: ReturnDiagnosisSuggestedAction; count: number }[];
  byIssueCode: { code: string; count: number }[];
  items: ReturnDiagnosisItem[];
  warnings: string[];
  constraintsVerified: {
    readOnly: "yes";
    returnWritten: "no";
    returnConsumed: "no";
    archived: "no";
    receiptWritten: "no";
    taskGraphMutated: "no";
    applied: "no";
  };
}

export interface ReturnDiagnosisScanOptions {
  scannedAt?: string;
  limit?: number;
}

function readReturnPackage(
  workspaceRoot: string,
  sourceFile: string,
): Record<string, unknown> | null {
  const filePath = path.join(workspaceRoot, RETURNS_INBOX_RELATIVE_PATH, sourceFile);
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

function hasFlatReturnShape(record: Record<string, unknown>): boolean {
  return Boolean(
    asNonEmptyString(record.taskId) ||
    asNonEmptyString(record.roleReturnPackageId) ||
    Array.isArray(record.filesModified) ||
    Array.isArray(record.filesCreated),
  );
}

function isV2Shaped(record: Record<string, unknown>): boolean {
  return Boolean(
    asNonEmptyString(record.schema) === "canonical-v2-return" ||
    asNonEmptyString(record.packageVersion) === "2.0" ||
    nestedString(record, "task.taskId") ||
    isPlainObject(record.result) ||
    isPlainObject(record.verification),
  );
}

function classifyCompatibility(
  record: Record<string, unknown> | null,
  plan: ReturnConsumerPlanScanItem,
): ReturnCompatibility {
  if (!record || planReason(plan) === "json-parse-failed") return "unreadable";
  if (plan.status === "process") return "v1-consumable";
  if (isV2Shaped(record)) return "v2-shaped";
  if (hasFlatReturnShape(record)) return "legacy-flat";
  return "v1-invalid";
}

function planReason(plan: ReturnConsumerPlanScanItem): string | null {
  return "reason" in plan ? plan.reason : null;
}

function issueFromValidationError(field: string): ReturnDiagnosisIssue {
  return {
    code: "consumer_schema_invalid",
    field,
    message: `Return package does not satisfy consumer V1 field: ${field}.`,
  };
}

function buildIssues(params: {
  plan: ReturnConsumerPlanScanItem;
  record: Record<string, unknown> | null;
  compatibility: ReturnCompatibility;
  taskGraphStatus: ReturnTaskGraphStatus;
}): ReturnDiagnosisIssue[] {
  const issues: ReturnDiagnosisIssue[] = [];
  if (planReason(params.plan) === "json-parse-failed") {
    issues.push({
      code: "json_parse_failed",
      message: "Return package JSON could not be parsed.",
    });
  }
  if ("validationErrors" in params.plan && params.plan.validationErrors) {
    issues.push(...params.plan.validationErrors.map(issueFromValidationError));
  }
  if (planReason(params.plan) === "legacy-p2-p-skipped") {
    issues.push({
      code: "legacy_p2_p_skipped",
      message: "Legacy P2-P return packages are intentionally skipped by the consumer.",
    });
  }
  if (params.compatibility === "v2-shaped") {
    issues.push({
      code: "v2_shape_not_consumer_v1",
      message:
        "Return package uses a V2-shaped payload while the consumer currently accepts V1 packages.",
    });
  }
  if (params.taskGraphStatus === "missing-task-id") {
    issues.push({
      code: "task_id_missing",
      field: "taskId",
      message: "Return package does not expose a taskId that can be linked to the task graph.",
    });
  }
  if (params.taskGraphStatus === "unmatched") {
    issues.push({
      code: "task_graph_unmatched",
      message: "Return taskId has no matching task graph node.",
    });
  }
  return issues;
}

function taskGraphStatus(
  sourceFile: string,
  taskId: string | null,
  unmatchedReasons: ReadonlyMap<string, "missing_task_id" | "no_matching_task_node">,
): ReturnTaskGraphStatus {
  const reason = unmatchedReasons.get(sourceFile);
  if (reason === "missing_task_id") return "missing-task-id";
  if (reason === "no_matching_task_node") return "unmatched";
  if (taskId) return "matched";
  return "unknown";
}

function suggestedAction(params: {
  plan: ReturnConsumerPlanScanItem;
  compatibility: ReturnCompatibility;
  taskGraphStatus: ReturnTaskGraphStatus;
}): ReturnDiagnosisSuggestedAction {
  if (params.plan.status === "process") return "no-action";
  if (params.compatibility === "v2-shaped" || params.compatibility === "legacy-flat") {
    return "repair-to-v1-dry-run";
  }
  if (params.taskGraphStatus === "unmatched") return "link-task-graph-node";
  return "manual-review";
}

function countBy<T extends string>(
  items: readonly T[],
  keyName: string,
): Array<Record<string, string | number>> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ [keyName]: key, count }));
}

function allPlanItems(workspaceRoot: string, scannedAt: string): ReturnConsumerPlanScanItem[] {
  return scanReturnConsumerPlan(workspaceRoot, {
    scannedAt,
    limit: Number.MAX_SAFE_INTEGER,
  }).plans;
}

export function scanReturnDiagnosis(
  workspaceRoot: string,
  options: ReturnDiagnosisScanOptions = {},
): ReturnDiagnosisScanResult {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const consumerPlans = allPlanItems(workspaceRoot, scannedAt);
  const returnPreview = buildTaskGraphReturnPreview(workspaceRoot, { observedAt: scannedAt });
  const unmatchedReasons = new Map(
    returnPreview.unmatchedReturns.map((item) => [item.returnId, item.reason]),
  );

  const items = consumerPlans.map((plan): ReturnDiagnosisItem => {
    const record = readReturnPackage(workspaceRoot, plan.sourceFile);
    const identity = record ? extractReturnPackageIdentity(record) : {};
    const returnId = "returnId" in plan && plan.returnId ? plan.returnId : identity.returnId;
    const taskId = "taskId" in plan && plan.taskId ? plan.taskId : identity.taskId;
    const compatibility = classifyCompatibility(record, plan);
    const graphStatus = taskGraphStatus(plan.sourceFile, taskId ?? null, unmatchedReasons);
    const action = suggestedAction({ plan, compatibility, taskGraphStatus: graphStatus });
    return {
      sourceFile: plan.sourceFile,
      returnId: returnId ?? null,
      taskId: taskId ?? null,
      planStatus: plan.status,
      planReason: planReason(plan),
      compatibility,
      taskGraphStatus: graphStatus,
      suggestedAction: action,
      issues: buildIssues({ plan, record, compatibility, taskGraphStatus: graphStatus }),
    };
  });

  return {
    mode: "observe-only",
    scannedAt,
    inboxPath: RETURNS_INBOX_RELATIVE_PATH,
    totalCount: items.length,
    diagnosableCount: items.filter((item) => item.issues.length > 0).length,
    byCompatibility: countBy(
      items.map((item) => item.compatibility),
      "compatibility",
    ) as ReturnDiagnosisScanResult["byCompatibility"],
    bySuggestedAction: countBy(
      items.map((item) => item.suggestedAction),
      "action",
    ) as ReturnDiagnosisScanResult["bySuggestedAction"],
    byIssueCode: countBy(
      items.flatMap((item) => item.issues.map((issue) => issue.code)),
      "code",
    ) as ReturnDiagnosisScanResult["byIssueCode"],
    items: items.slice(0, limit),
    warnings: returnPreview.graphErrors.map((error) => `${error.field}: ${error.message}`),
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      returnConsumed: "no",
      archived: "no",
      receiptWritten: "no",
      taskGraphMutated: "no",
      applied: "no",
    },
  };
}
