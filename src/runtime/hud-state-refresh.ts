import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanControlSignals } from "./control-signals.js";
import { scanPromotionCandidates } from "./distillation/promotion-candidates.js";
import { readAutoEvolutionState } from "./evolution/auto-evolution-observe.js";
import {
  generateHudState,
  type HudAutoEvolutionObserveSummary,
  type HudPendingReturnItem,
  type HudMirrorObserveSummary,
  type HudPositionState,
  type HudPromotionCandidatesSummary,
  type HudReturnDiagnosisSummary,
  type HudReturnReconciliationApplyPlanSummary,
  type HudReturnRepairDryRunSummary,
  type HudReturnReconciliationGateSummary,
  type HudSchedulerTickPlanSummary,
  type HudTaskGraphReturnLinkDryRunSummary,
  type HudTaskGraphReturnPreviewSummary,
  type HudReturnConsumerPlanSummary,
  type HudState,
  type HudTaskGraphItem,
} from "./hud-state.js";
import { readSemanticRebuildSummary } from "./kb-semantic-rebuild-state.js";
import { readMirrorObserveState } from "./mirror/mirror-observe.js";
import { scanRecoveryCandidates } from "./recovery-candidates.js";
import { scanReturnConsumerPlan } from "./returns/return-consumer-plan.js";
import { scanReturnDiagnosis } from "./returns/return-diagnosis.js";
import { scanReturnInbox } from "./returns/return-inbox.js";
import { buildReturnReconciliationApplyPlan } from "./returns/return-reconciliation-apply-plan.js";
import { evaluateReturnReconciliationGate } from "./returns/return-reconciliation-gate.js";
import { buildReturnRepairDryRun } from "./returns/return-repair-dry-run.js";
import { buildSchedulerTickPlan } from "./scheduler-tick-plan.js";
import { buildTaskGraphReturnLinkDryRun } from "./task-graph-return-link-dry-run.js";
import {
  TASK_GRAPH_SOURCE_RELATIVE_PATH,
  buildTaskGraphReturnPreview,
  buildTaskGraphValidationSummary,
  type TaskGraphValidationReport,
} from "./task-graph.js";

export const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
const POSITIONS_STATE_REL = "system/positions/state";
const CASE_LIBRARY_REL = "system/case-library";
const TASK_GRAPH_SOURCE_REL = TASK_GRAPH_SOURCE_RELATIVE_PATH;

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

function readReturnDiagnosis(workspaceRoot: string): HudReturnDiagnosisSummary {
  const scan = scanReturnDiagnosis(workspaceRoot, { limit: 0 });
  return {
    mode: scan.mode,
    scannedAt: scan.scannedAt,
    inboxPath: scan.inboxPath,
    totalCount: scan.totalCount,
    diagnosableCount: scan.diagnosableCount,
    byCompatibility: scan.byCompatibility,
    bySuggestedAction: scan.bySuggestedAction,
    byIssueCode: scan.byIssueCode,
    warningCount: scan.warnings.length,
    constraintsVerified: scan.constraintsVerified,
  };
}

function readReturnRepairDryRun(workspaceRoot: string): HudReturnRepairDryRunSummary {
  const plan = buildReturnRepairDryRun(workspaceRoot, { limit: 0 });
  return {
    mode: plan.mode,
    dryRun: plan.dryRun,
    plannedAt: plan.plannedAt,
    inboxPath: plan.inboxPath,
    totalDiagnosed: plan.totalDiagnosed,
    candidateCount: plan.candidateCount,
    repairableCount: plan.repairableCount,
    blockedCount: plan.blockedCount,
    warningCount: plan.warnings.length,
    constraintsVerified: plan.constraintsVerified,
  };
}

function readReturnReconciliationGate(
  workspaceRoot: string,
  checkedAt: string,
): HudReturnReconciliationGateSummary {
  return evaluateReturnReconciliationGate(workspaceRoot, { checkedAt });
}

function readReturnReconciliationApplyPlan(
  workspaceRoot: string,
  plannedAt: string,
): HudReturnReconciliationApplyPlanSummary {
  const plan = buildReturnReconciliationApplyPlan(workspaceRoot, {
    plannedAt,
    limit: 0,
  });
  return {
    mode: plan.mode,
    dryRun: plan.dryRun,
    plannedAt: plan.plannedAt,
    status: plan.status,
    frozen: plan.frozen,
    readyForControlledApply: plan.readyForControlledApply,
    blockedReasons: plan.blockedReasons,
    nextAction: plan.nextAction,
    repair: plan.repair,
    returnLink: plan.returnLink,
    stepCount: plan.stepCount,
    readyStepCount: plan.readyStepCount,
    blockedStepCount: plan.blockedStepCount,
    constraintsVerified: plan.constraintsVerified,
  };
}

function readPromotionCandidates(workspaceRoot: string): HudPromotionCandidatesSummary {
  const scan = scanPromotionCandidates(workspaceRoot);
  return {
    available: scan.available,
    status: scan.status,
    sourceFile: scan.sourceFile,
    stateFile: scan.stateFile,
    generatedAt: scan.generatedAt,
    lastSyncedAt: scan.lastSyncedAt,
    stats: scan.stats,
    errorCount: scan.errors.length,
    constraintsVerified: scan.constraintsVerified,
  };
}

function readSchedulerTickPlan(
  workspaceRoot: string,
  generatedAt: string,
): HudSchedulerTickPlanSummary {
  const plan = buildSchedulerTickPlan(workspaceRoot, { plannedAt: generatedAt });
  return {
    mode: plan.mode,
    plannedAt: plan.plannedAt,
    decision: plan.decision,
    reason: plan.reason,
    enabled: plan.enabled,
    markerMode: plan.markerMode,
    stateStatus: plan.stateStatus,
    running: plan.running,
    totalTicks: plan.totalTicks,
    nextTickIndex: plan.nextTickIndex,
    maxTicks: plan.maxTicks,
    sourceFiles: plan.sourceFiles,
    warningCount: plan.warnings.length,
    constraintsVerified: plan.constraintsVerified,
  };
}

function readTaskGraphReturnPreview(
  workspaceRoot: string,
  observedAt: string,
): HudTaskGraphReturnPreviewSummary {
  const preview = buildTaskGraphReturnPreview(workspaceRoot, { observedAt });
  return {
    mode: preview.mode,
    observedAt: preview.observedAt,
    sourcePath: preview.sourcePath,
    inboxPath: preview.inboxPath,
    graphCount: preview.graphCount,
    nodeCount: preview.nodeCount,
    pendingReturnCount: preview.pendingReturnCount,
    matchedNodeCount: preview.matchedNodeCount,
    missingNodeCount: preview.missingNodeCount,
    ambiguousNodeCount: preview.ambiguousNodeCount,
    declaredReturnNodeCount: preview.declaredReturnNodeCount,
    unmatchedReturnCount: preview.unmatchedReturnCount,
    graphErrorCount: preview.graphErrors.length,
    sampleUnmatchedReturns: preview.unmatchedReturns.slice(0, 5),
    constraintsVerified: preview.constraintsVerified,
  };
}

function readTaskGraphReturnLinkDryRun(
  workspaceRoot: string,
  plannedAt: string,
): HudTaskGraphReturnLinkDryRunSummary {
  const plan = buildTaskGraphReturnLinkDryRun(workspaceRoot, { plannedAt, limit: 0 });
  return {
    mode: plan.mode,
    dryRun: plan.dryRun,
    plannedAt: plan.plannedAt,
    sourcePath: plan.sourcePath,
    inboxPath: plan.inboxPath,
    unmatchedReturnCount: plan.unmatchedReturnCount,
    candidateCount: plan.candidateCount,
    linkableCount: plan.linkableCount,
    blockedCount: plan.blockedCount,
    graphErrorCount: plan.graphErrorCount,
    warningCount: plan.warnings.length,
    constraintsVerified: plan.constraintsVerified,
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
    returnDiagnosis: readReturnDiagnosis(workspaceRoot),
    returnRepairDryRun: readReturnRepairDryRun(workspaceRoot),
    returnReconciliationGate: readReturnReconciliationGate(workspaceRoot, generatedAt),
    returnReconciliationApplyPlan: readReturnReconciliationApplyPlan(workspaceRoot, generatedAt),
    totalCaseFiles,
    lastCaseAt,
    taskGraphItems: readTaskGraphs(workspaceRoot, warnings, taskGraphValidationSummary.reports),
    taskGraphSourcePath: `${TASK_GRAPH_SOURCE_REL}/`,
    taskGraphReturnPreview: readTaskGraphReturnPreview(workspaceRoot, generatedAt),
    taskGraphReturnLinkDryRun: readTaskGraphReturnLinkDryRun(workspaceRoot, generatedAt),
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
    promotionCandidates: readPromotionCandidates(workspaceRoot),
    schedulerTickPlan: readSchedulerTickPlan(workspaceRoot, generatedAt),
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
