import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanControlSignals } from "./control-signals.js";
import { readAutoEvolutionState } from "./evolution/auto-evolution-observe.js";
import {
  generateHudState,
  type HudAutoEvolutionObserveSummary,
  type HudPendingReturnItem,
  type HudMirrorObserveSummary,
  type HudPositionState,
  type HudReturnConsumerPlanSummary,
  type HudSemanticRebuildSummary,
  type HudState,
  type HudTaskGraphItem,
} from "./hud-state.js";
import { readMirrorObserveState } from "./mirror/mirror-observe.js";
import { scanRecoveryCandidates } from "./recovery-candidates.js";
import { scanReturnConsumerPlan } from "./returns/return-consumer-plan.js";
import { scanReturnInbox } from "./returns/return-inbox.js";
import {
  TASK_GRAPH_SOURCE_RELATIVE_PATH,
  buildTaskGraphValidationSummary,
  type TaskGraphValidationReport,
} from "./task-graph.js";

export const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
const POSITIONS_STATE_REL = "system/positions/state";
const CASE_LIBRARY_REL = "system/case-library";
const TASK_GRAPH_SOURCE_REL = TASK_GRAPH_SOURCE_RELATIVE_PATH;
const SEMANTIC_REBUILD_REPORT_REL = "runtime/main/tmp";
const SEMANTIC_REBUILD_PLAN_PREFIX = "kb-semantic-rebuild-plan-";
const SEMANTIC_REBUILD_ACCEPTANCE_PREFIX = "kb-semantic-rebuild-acceptance-";
const SEMANTIC_REBUILD_APPROVAL_PREFIX = "kb-semantic-rebuild-approval-";
const SEMANTIC_REBUILD_EXECUTION_RUN_PREFIX = "kb-semantic-rebuild-execution-run-";
const REPORT_FILE_SUFFIX = ".json";

export interface HudStateRefreshResult {
  refreshed: true;
  generatedAt: string;
  statePath: string;
  warnings: string[];
  state: HudState;
}

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

function firstString(record: Record<string, unknown> | null, names: string[]): string | null {
  if (!record) return null;
  for (const name of names) {
    const value = stringValue(record[name]);
    if (value) return value;
  }
  return null;
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

function listFilesRecursive(dirPath: string, predicate: (name: string) => boolean): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return listFilesRecursive(fullPath, predicate);
      return entry.isFile() && predicate(entry.name) ? [fullPath] : [];
    });
  } catch {
    return [];
  }
}

function readPositionStates(
  workspaceRoot: string,
  warnings: string[],
): Record<string, HudPositionState> {
  const positionsDir = path.join(workspaceRoot, POSITIONS_STATE_REL);
  if (!existsSync(positionsDir)) {
    warnings.push("positions state directory missing");
    return {};
  }

  const states: Record<string, HudPositionState> = {};
  for (const filePath of listFiles(positionsDir, (name) => name.endsWith(".json"))) {
    const state = readJsonFile(filePath);
    if (!state) {
      warnings.push(`Failed to read position state: ${filePath}`);
      continue;
    }
    const baseName = path.basename(filePath, ".json").replace(/_workspace-main$/u, "");
    const agentId = firstString(state, ["agentId", "positionId", "roleId"]) ?? baseName;
    states[agentId] = state as HudPositionState;
  }
  return states;
}

function readPendingReturns(workspaceRoot: string, warnings: string[]): HudPendingReturnItem[] {
  const scan = scanReturnInbox(workspaceRoot, { limit: 10 });
  warnings.push(...scan.warnings);
  return scan.pendingItems.map((item) => ({
    returnId: item.returnId,
    taskId: item.taskId,
    sourceRole: item.sourceRole,
    action: item.action,
    status: item.status,
    createdAt: item.createdAt,
    needsReview: item.needsReview,
    summary: item.summary,
  }));
}

function readReturnConsumerPlan(workspaceRoot: string): HudReturnConsumerPlanSummary {
  const scan = scanReturnConsumerPlan(workspaceRoot, { limit: 0 });
  return {
    mode: scan.mode,
    scannedAt: scan.scannedAt,
    inboxPath: scan.inboxPath,
    processedPath: scan.processedPath,
    totalCount: scan.totalCount,
    processCount: scan.processCount,
    skipCount: scan.skipCount,
    byReason: scan.byReason,
    warningCount: scan.warnings.length,
    constraintsVerified: scan.constraintsVerified,
  };
}

function readCaseLibraryState(
  workspaceRoot: string,
  warnings: string[],
): { totalCaseFiles: number; lastCaseAt: string | null } {
  const caseLibraryDir = path.join(workspaceRoot, CASE_LIBRARY_REL);
  if (!existsSync(caseLibraryDir)) {
    warnings.push("case library directory missing");
    return { totalCaseFiles: 0, lastCaseAt: null };
  }

  const files = listFilesRecursive(caseLibraryDir, (name) => name.endsWith(".json"));
  const lastCaseAt =
    files.length > 0
      ? (files
          .map((filePath) => statSync(filePath).mtime)
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null)
      : null;
  return { totalCaseFiles: files.length, lastCaseAt };
}

function validationReportMap(
  validationReports: readonly TaskGraphValidationReport[],
): Map<string, { checkedAt: string; severity: string | null }> {
  const reports = new Map<string, { checkedAt: string; severity: string | null }>();
  for (const report of validationReports) {
    const graphId = report.graphId;
    if (!graphId) continue;
    const current = reports.get(graphId);
    if (current && Date.parse(current.checkedAt) >= Date.parse(report.checkedAt)) continue;
    reports.set(graphId, {
      checkedAt: report.checkedAt,
      severity: report.severity,
    });
  }
  return reports;
}

function nodeStatusSummary(nodes: unknown[]): HudTaskGraphItem["nodeSummary"] {
  const summary: HudTaskGraphItem["nodeSummary"] = {
    total: nodes.length,
    completed: 0,
    running: 0,
    ready: 0,
    planned: 0,
    blocked: 0,
    failed: 0,
  };
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const status = stringValue(node.status);
    if (status && status in summary && status !== "total")
      summary[status as keyof Omit<typeof summary, "total">] += 1;
  }
  return summary;
}

function readTaskGraphs(
  workspaceRoot: string,
  warnings: string[],
  validationReports: readonly TaskGraphValidationReport[],
): HudTaskGraphItem[] {
  const taskGraphDir = path.join(workspaceRoot, TASK_GRAPH_SOURCE_REL);
  if (!existsSync(taskGraphDir)) return [];

  const validationReportsByGraphId = validationReportMap(validationReports);
  return listFiles(taskGraphDir, (name) => /^task-graph-.*\.json$/u.test(name))
    .map((filePath) => {
      const graph = readJsonFile(filePath);
      if (!graph) {
        warnings.push(`Failed to parse task graph: ${path.basename(filePath)}`);
        return null;
      }
      const graphId = firstString(graph, ["graphId"]);
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const matchedValidation = graphId ? validationReportsByGraphId.get(graphId) : undefined;
      return {
        graphId,
        title: firstString(graph, ["title"]),
        aggregateStatus: firstString(graph, ["aggregateStatus"]),
        nodeSummary: nodeStatusSummary(nodes),
        blockers: Array.isArray(graph.blockers) ? graph.blockers : [],
        nextRunnable: Array.isArray(graph.nextRunnable)
          ? graph.nextRunnable.filter((item): item is string => typeof item === "string")
          : [],
        lastValidatedAt: matchedValidation?.checkedAt ?? null,
        validationSeverity: matchedValidation?.severity ?? null,
      } satisfies HudTaskGraphItem;
    })
    .filter((item): item is HudTaskGraphItem => item !== null);
}

function readLatestMirrorObserve(
  workspaceRoot: string,
  warnings: string[],
): HudMirrorObserveSummary {
  const state = readMirrorObserveState(workspaceRoot);
  if (!state.available) {
    if (state.error) warnings.push(state.error);
    return {
      available: false,
      reportPath: state.reportPath ?? null,
      mirrorId: null,
      generatedAt: null,
      mode: null,
      stats: null,
      constraintsVerified: null,
      verdict: null,
    };
  }
  return {
    available: true,
    reportPath: state.reportPath,
    mirrorId: state.mirrorId,
    generatedAt: state.generatedAt,
    mode: state.mode,
    stats: state.stats,
    constraintsVerified: state.constraintsVerified,
    verdict: state.verdict,
  };
}

function readLatestAutoEvolutionObserve(
  workspaceRoot: string,
  warnings: string[],
): HudAutoEvolutionObserveSummary {
  const state = readAutoEvolutionState(workspaceRoot);
  if (!state.available) {
    if (state.error) warnings.push(state.error);
    return {
      available: false,
      reportPath: state.reportPath ?? null,
      generatedAt: null,
      mode: null,
      stats: null,
      constraintsVerified: null,
      verdict: null,
    };
  }
  return {
    available: true,
    reportPath: state.reportPath,
    generatedAt: state.generatedAt,
    mode: state.mode,
    stats: state.stats,
    constraintsVerified: state.constraintsVerified,
    verdict: state.verdict,
  };
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

function readSemanticRebuildSummary(workspaceRoot: string): HudSemanticRebuildSummary {
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

export function generateHudStateFromWorkspace(
  workspaceRoot: string,
  generatedAt = new Date().toISOString(),
): HudState {
  const warnings: string[] = [];
  const taskGraphValidationSummary = buildTaskGraphValidationSummary(workspaceRoot, {
    checkedAt: generatedAt,
  });
  const { totalCaseFiles, lastCaseAt } = readCaseLibraryState(workspaceRoot, warnings);
  return generateHudState({
    generatedAt,
    positionStatesByAgentId: readPositionStates(workspaceRoot, warnings),
    pendingReturnItems: readPendingReturns(workspaceRoot, warnings),
    returnConsumerPlan: readReturnConsumerPlan(workspaceRoot),
    totalCaseFiles,
    lastCaseAt,
    taskGraphItems: readTaskGraphs(workspaceRoot, warnings, taskGraphValidationSummary.reports),
    taskGraphSourcePath: `${TASK_GRAPH_SOURCE_REL}/`,
    mirrorObserve: readLatestMirrorObserve(workspaceRoot, warnings),
    autoEvolutionObserve: readLatestAutoEvolutionObserve(workspaceRoot, warnings),
    semanticRebuild: readSemanticRebuildSummary(workspaceRoot),
    controlSignals: (() => {
      const scan = scanControlSignals(workspaceRoot);
      return {
        mode: scan.mode,
        status: scan.status,
        pendingPath: scan.pendingPath,
        frozen: scan.frozen,
        g2Approved: scan.g2Approved,
        pendingCount: scan.pendingCount,
        expiredCount: scan.expiredCount,
        errorCount: scan.errorCount,
        validCount: scan.validCount,
        invalidCount: scan.invalidCount,
        byRole: scan.byRole,
        byAction: scan.byAction,
        constraintsVerified: scan.constraintsVerified,
      };
    })(),
    recoveryCandidates: (() => {
      const scan = scanRecoveryCandidates(workspaceRoot);
      return {
        mode: scan.mode,
        sourcePath: scan.sourcePath,
        frozen: scan.frozen,
        graphCount: scan.graphCount,
        candidateCount: scan.candidateCount,
        byStatus: scan.byStatus,
        bySuggestedAction: scan.bySuggestedAction,
        errorCount: scan.errors.length,
        constraintsVerified: scan.constraintsVerified,
      };
    })(),
    warnings,
  });
}

export function writeHudStateSnapshot(
  workspaceRoot: string,
  generatedAt = new Date().toISOString(),
): HudStateRefreshResult {
  const state = generateHudStateFromWorkspace(workspaceRoot, generatedAt);
  const statePath = path.join(workspaceRoot, HUD_STATE_RELATIVE_PATH);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return {
    refreshed: true,
    generatedAt: state.generatedAt,
    statePath: HUD_STATE_RELATIVE_PATH,
    warnings: state.warnings,
    state,
  };
}
