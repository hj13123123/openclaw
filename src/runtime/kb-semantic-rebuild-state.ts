import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { HudSemanticRebuildSummary } from "./hud-state.js";

const SEMANTIC_REBUILD_REPORT_REL = "runtime/main/tmp";
const SEMANTIC_REBUILD_PLAN_PREFIX = "kb-semantic-rebuild-plan-";
const SEMANTIC_REBUILD_ACCEPTANCE_PREFIX = "kb-semantic-rebuild-acceptance-";
const SEMANTIC_REBUILD_APPROVAL_PREFIX = "kb-semantic-rebuild-approval-";
const SEMANTIC_REBUILD_EXECUTION_RUN_PREFIX = "kb-semantic-rebuild-execution-run-";
const REPORT_FILE_SUFFIX = ".json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function listFiles(dirPath: string, predicate: (name: string) => boolean): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function latestSemanticRebuildReport(
  workspaceRoot: string,
  prefix: string,
): { reportPath: string; report: Record<string, unknown> } | null {
  const reportDir = path.join(workspaceRoot, SEMANTIC_REBUILD_REPORT_REL);
  const latestReport = listFiles(
    reportDir,
    (name) => name.startsWith(prefix) && name.endsWith(REPORT_FILE_SUFFIX),
  ).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!latestReport) return null;

  const report = readJsonFile(latestReport);
  if (!report) return null;
  return {
    reportPath: path.relative(workspaceRoot, latestReport).replace(/\\/gu, "/"),
    report,
  };
}

function numberFromRecordValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function semanticRebuildConstraints(
  execution: Record<string, unknown> | null,
  approval: Record<string, unknown> | null,
  acceptance: Record<string, unknown> | null,
  plan: Record<string, unknown> | null,
): Record<string, string> | null {
  const constraints =
    recordValue(execution?.constraintsVerified) ??
    recordValue(approval?.constraintsVerified) ??
    recordValue(acceptance?.constraintsVerified) ??
    recordValue(plan?.constraintsVerified);
  if (!constraints) return null;
  return Object.fromEntries(
    Object.entries(constraints).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function readSemanticRebuildSummary(workspaceRoot: string): HudSemanticRebuildSummary {
  const plan = latestSemanticRebuildReport(workspaceRoot, SEMANTIC_REBUILD_PLAN_PREFIX);
  const acceptance = latestSemanticRebuildReport(workspaceRoot, SEMANTIC_REBUILD_ACCEPTANCE_PREFIX);
  const approval = latestSemanticRebuildReport(workspaceRoot, SEMANTIC_REBUILD_APPROVAL_PREFIX);
  const execution = latestSemanticRebuildReport(
    workspaceRoot,
    SEMANTIC_REBUILD_EXECUTION_RUN_PREFIX,
  );
  const planSource = recordValue(plan?.report.source);
  const executionStatus = stringValue(execution?.report.status);
  const stage: HudSemanticRebuildSummary["stage"] =
    executionStatus === "applied"
      ? "applied"
      : !plan
        ? "plan_missing"
        : plan.report.status !== "ready"
          ? "blocked"
          : !acceptance
            ? "plan_ready"
            : !approval
              ? "rebuild_approval_required"
              : "ready_for_real_rebuild_implementation";

  return {
    available: Boolean(plan),
    stage,
    latestPlanPath: plan?.reportPath ?? null,
    latestAcceptancePath: acceptance?.reportPath ?? null,
    latestApprovalPath: approval?.reportPath ?? null,
    latestExecutionPath: execution?.reportPath ?? null,
    executionStatus,
    totalItems:
      (execution ? numberFromRecordValue(execution.report, "totalItems") : null) ??
      (planSource ? numberFromRecordValue(planSource, "totalItems") : null),
    plannedBatches: plan ? numberFromRecordValue(plan.report, "plannedBatches") : null,
    readyForHumanGate: Boolean(acceptance),
    readyForExecution: Boolean(acceptance),
    readyForRealRebuildImplementation:
      Boolean(approval) && stage === "ready_for_real_rebuild_implementation",
    constraintsVerified: semanticRebuildConstraints(
      execution?.report ?? null,
      approval?.report ?? null,
      acceptance?.report ?? null,
      plan?.report ?? null,
    ),
  };
}
