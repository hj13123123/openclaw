import { readFileSync } from "node:fs";
import path from "node:path";
import { listTaskGraphFiles, TASK_GRAPH_SOURCE_RELATIVE_PATH } from "./task-graph.js";

export const RECOVERY_ELIGIBLE_STATUSES = [
  "failed",
  "cancelled",
  "blocked",
  "interrupted",
  "paused",
] as const;
export type RecoveryEligibleStatus = (typeof RECOVERY_ELIGIBLE_STATUSES)[number];

export type RecoverySuggestedAction = "resume" | "unblock" | "retry" | "skip" | "human-review";

export interface RecoveryCandidate {
  graphId: string;
  graphPath: string;
  nodeId: string;
  taskId: string | null;
  nodeStatus: RecoveryEligibleStatus;
  suggestedAction: RecoverySuggestedAction;
  description: string | null;
  dependsOn: string[];
  runId: string | null;
  affectedDownstream: string[];
}

export interface RecoveryCandidateScanIssue {
  graphPath: string;
  code: string;
  message: string;
}

export interface RecoveryCandidateScanResult {
  mode: "observe-only";
  scannedAt: string;
  sourcePath: string;
  frozen: boolean;
  graphCount: number;
  candidateCount: number;
  byStatus: { status: RecoveryEligibleStatus; count: number }[];
  bySuggestedAction: { action: RecoverySuggestedAction; count: number }[];
  candidates: RecoveryCandidate[];
  errors: RecoveryCandidateScanIssue[];
  message: string;
  constraintsVerified: {
    readOnly: "yes";
    recoveryDecisionWritten: "no";
    taskGraphMutated: "no";
    sessionsSent: "no";
    autoDispatchTriggered: "no";
    applied: "no";
  };
}

export interface RecoveryCandidateScanOptions {
  scannedAt?: string;
  graphId?: string;
  graphFiles?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readTextIfExists(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function detectFrozenFlag(workspaceRoot: string): boolean {
  return (
    /frozen/iu.test(readTextIfExists(path.join(workspaceRoot, "HEARTBEAT.md"))) ||
    /frozen flag.*active/iu.test(readTextIfExists(path.join(workspaceRoot, "SESSION_SUMMARY.md")))
  );
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecoveryEligibleStatus(value: unknown): value is RecoveryEligibleStatus {
  return (
    typeof value === "string" &&
    RECOVERY_ELIGIBLE_STATUSES.includes(value as RecoveryEligibleStatus)
  );
}

export function suggestRecoveryAction(status: RecoveryEligibleStatus): RecoverySuggestedAction {
  switch (status) {
    case "paused":
      return "resume";
    case "blocked":
      return "unblock";
    case "failed":
      return "retry";
    case "cancelled":
      return "skip";
    case "interrupted":
      return "skip";
  }
}

function countBy<T extends string>(items: readonly T[]): { value: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }));
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
}

function scanGraphFile(
  workspaceRoot: string,
  filePath: string,
  graphIdFilter: string | undefined,
  errors: RecoveryCandidateScanIssue[],
): { graphCount: number; candidates: RecoveryCandidate[] } {
  const graphPath = relativePath(workspaceRoot, filePath);
  const graph = readJsonFile(filePath);
  if (!graph) {
    errors.push({
      graphPath,
      code: "parse_failed",
      message: "Task graph JSON could not be parsed.",
    });
    return { graphCount: 0, candidates: [] };
  }

  const graphId = stringValue(graph.graphId);
  if (!graphId) {
    errors.push({
      graphPath,
      code: "graph_id_missing",
      message: "Task graph graphId is required.",
    });
    return { graphCount: 0, candidates: [] };
  }
  if (graphIdFilter && graphId !== graphIdFilter) return { graphCount: 0, candidates: [] };

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const candidates: RecoveryCandidate[] = [];
  for (const node of nodes) {
    const nodeStatus = stringValue(node.status);
    if (!isRecoveryEligibleStatus(nodeStatus)) continue;
    const nodeId = stringValue(node.nodeId);
    if (!nodeId) continue;
    const affectedDownstream = nodes
      .filter((candidate) => stringArray(candidate.dependsOn).includes(nodeId))
      .filter((candidate) => stringValue(candidate.status) === "planned")
      .map((candidate) => stringValue(candidate.nodeId))
      .filter((candidateId): candidateId is string => candidateId !== null);
    candidates.push({
      graphId,
      graphPath,
      nodeId,
      taskId: stringValue(node.taskId),
      nodeStatus,
      suggestedAction: suggestRecoveryAction(nodeStatus),
      description: stringValue(node.description),
      dependsOn: stringArray(node.dependsOn),
      runId: stringValue(node.runId),
      affectedDownstream,
    });
  }

  return { graphCount: 1, candidates };
}

export function scanRecoveryCandidates(
  workspaceRoot: string,
  options: RecoveryCandidateScanOptions = {},
): RecoveryCandidateScanResult {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const graphFiles = options.graphFiles ?? listTaskGraphFiles(workspaceRoot);
  const errors: RecoveryCandidateScanIssue[] = [];
  const candidates: RecoveryCandidate[] = [];
  let graphCount = 0;

  for (const filePath of graphFiles) {
    const scan = scanGraphFile(workspaceRoot, filePath, options.graphId, errors);
    graphCount += scan.graphCount;
    candidates.push(...scan.candidates);
  }

  const byStatus = countBy(candidates.map((candidate) => candidate.nodeStatus)).map(
    ({ value, count }) => ({ status: value, count }),
  );
  const bySuggestedAction = countBy(candidates.map((candidate) => candidate.suggestedAction)).map(
    ({ value, count }) => ({ action: value, count }),
  );
  const frozen = detectFrozenFlag(workspaceRoot);
  const message =
    candidates.length === 0
      ? "No recovery-eligible nodes found."
      : frozen
        ? `${candidates.length} recovery candidate(s) found. Frozen: apply blocked. Scan-only output allowed.`
        : `${candidates.length} recovery candidate(s) found.`;

  return {
    mode: "observe-only",
    scannedAt,
    sourcePath: `${TASK_GRAPH_SOURCE_RELATIVE_PATH}/`,
    frozen,
    graphCount,
    candidateCount: candidates.length,
    byStatus,
    bySuggestedAction,
    candidates,
    errors,
    message,
    constraintsVerified: {
      readOnly: "yes",
      recoveryDecisionWritten: "no",
      taskGraphMutated: "no",
      sessionsSent: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    },
  };
}
