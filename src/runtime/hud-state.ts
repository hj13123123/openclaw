import type { ControlSignalScanResult } from "./control-signals.js";
import type { PromotionCandidatesScan } from "./distillation/promotion-candidates.js";
import type { RecoveryCandidateScanResult } from "./recovery-candidates.js";
import type { ReturnConsumerPlanScanResult } from "./returns/return-consumer-plan.js";
import type { ReturnDiagnosisScanResult } from "./returns/return-diagnosis.js";
import type { SchedulerTickPlan } from "./scheduler-tick-plan.js";
import type { TaskGraphReturnPreviewResult } from "./task-graph.js";

export type HudAgentStatus =
  | "completed"
  | "running"
  | "failed"
  | "attention_required"
  | "unknown"
  | string;

export interface HudAgentDefault {
  agentId: string;
  displayName: string;
  role: string;
}

export interface HudPositionState {
  agentId?: string;
  positionId?: string;
  roleId?: string;
  status?: unknown;
  currentState?: unknown;
  state?: unknown;
  currentTask?: unknown;
  currentTaskId?: unknown;
  currentTicketId?: unknown;
  taskId?: unknown;
  currentTaskTitle?: unknown;
  currentTicketTitle?: unknown;
  taskTitle?: unknown;
  progressPct?: unknown;
  progress?: unknown;
  completionPct?: unknown;
  lastProgressAt?: unknown;
  lastActivityAt?: unknown;
  last_activity_at?: unknown;
  updatedAt?: unknown;
  lastCompletionAt?: unknown;
  completedAt?: unknown;
}

export interface HudAgentGroup {
  agentId: string;
  displayName: string;
  role: string;
  status: HudAgentStatus;
  currentTask: string | null;
  currentTaskTitle: string | null;
  progressPct: number;
  source: "position-state" | "configured";
  progressDerivation: "position-state" | "unknown";
  hasAlerts: boolean;
  lastProgressAt: string | null;
  lastCompletionAt: string | null;
}

export interface HudPendingReturnItem {
  returnId: string;
  taskId: string | null;
  sourceRole: string | null;
  action: string | null;
  status: "pending";
  createdAt: string;
  needsReview: boolean;
  summary: string | null;
}

export interface HudTaskGraphItem {
  graphId: string | null;
  title: string | null;
  aggregateStatus: string | null;
  nodeSummary: {
    total: number;
    completed: number;
    running: number;
    ready: number;
    planned: number;
    blocked: number;
    failed: number;
  };
  blockers: unknown[];
  nextRunnable: string[];
  lastValidatedAt: string | null;
  validationSeverity: string | null;
}

export interface HudMirrorObserveSummary {
  available: boolean;
  reportPath: string | null;
  mirrorId: string | null;
  generatedAt: string | null;
  mode: string | null;
  stats: {
    observationCount: number;
    findingCount: number;
    bySeverity: Record<string, number>;
  } | null;
  constraintsVerified: Record<string, string> | null;
  verdict: string | null;
}

export interface HudAutoEvolutionObserveSummary {
  available: boolean;
  reportPath: string | null;
  generatedAt: string | null;
  mode: string | null;
  stats: {
    totalSuggestions: number;
    byPriority: Record<string, number>;
    bySource: Record<string, number>;
  } | null;
  constraintsVerified: Record<string, string> | null;
  verdict: string | null;
}

export interface HudSemanticRebuildSummary {
  available: boolean;
  stage:
    | "plan_missing"
    | "plan_ready"
    | "acceptance_ready"
    | "rebuild_approval_required"
    | "ready_for_real_rebuild_implementation"
    | "applied"
    | "blocked";
  latestPlanPath: string | null;
  latestAcceptancePath: string | null;
  latestApprovalPath: string | null;
  latestExecutionPath: string | null;
  executionStatus: string | null;
  totalItems: number | null;
  plannedBatches: number | null;
  readyForHumanGate: boolean;
  readyForExecution: boolean;
  readyForRealRebuildImplementation: boolean;
  constraintsVerified: Record<string, string> | null;
}

export type HudControlSignalsSummary = Pick<
  ControlSignalScanResult,
  | "mode"
  | "status"
  | "pendingPath"
  | "frozen"
  | "g2Approved"
  | "pendingCount"
  | "expiredCount"
  | "errorCount"
  | "validCount"
  | "invalidCount"
  | "byRole"
  | "byAction"
  | "constraintsVerified"
>;

export type HudRecoveryCandidatesSummary = Pick<
  RecoveryCandidateScanResult,
  | "mode"
  | "sourcePath"
  | "frozen"
  | "graphCount"
  | "candidateCount"
  | "byStatus"
  | "bySuggestedAction"
  | "constraintsVerified"
> & { errorCount: number };

export type HudReturnConsumerPlanSummary = Pick<
  ReturnConsumerPlanScanResult,
  | "mode"
  | "scannedAt"
  | "inboxPath"
  | "processedPath"
  | "totalCount"
  | "processCount"
  | "skipCount"
  | "byReason"
  | "constraintsVerified"
> & { warningCount: number };

export type HudReturnDiagnosisSummary = Pick<
  ReturnDiagnosisScanResult,
  | "mode"
  | "scannedAt"
  | "inboxPath"
  | "totalCount"
  | "diagnosableCount"
  | "byCompatibility"
  | "bySuggestedAction"
  | "byIssueCode"
  | "constraintsVerified"
> & { warningCount: number };

export type HudPromotionCandidatesSummary = Pick<
  PromotionCandidatesScan,
  | "available"
  | "status"
  | "sourceFile"
  | "stateFile"
  | "generatedAt"
  | "lastSyncedAt"
  | "stats"
  | "constraintsVerified"
> & { errorCount: number };

export type HudSchedulerTickPlanSummary = Pick<
  SchedulerTickPlan,
  | "mode"
  | "plannedAt"
  | "decision"
  | "reason"
  | "enabled"
  | "markerMode"
  | "stateStatus"
  | "running"
  | "totalTicks"
  | "nextTickIndex"
  | "maxTicks"
  | "sourceFiles"
  | "constraintsVerified"
> & { warningCount: number };

export type HudTaskGraphReturnPreviewSummary = Pick<
  TaskGraphReturnPreviewResult,
  | "mode"
  | "observedAt"
  | "sourcePath"
  | "inboxPath"
  | "graphCount"
  | "nodeCount"
  | "pendingReturnCount"
  | "matchedNodeCount"
  | "missingNodeCount"
  | "ambiguousNodeCount"
  | "declaredReturnNodeCount"
  | "unmatchedReturnCount"
  | "constraintsVerified"
> & {
  graphErrorCount: number;
  sampleUnmatchedReturns: TaskGraphReturnPreviewResult["unmatchedReturns"];
};

export interface HudStateInput {
  generatedAt: string;
  positionStatesByAgentId?: Record<string, HudPositionState>;
  pendingReturnItems?: HudPendingReturnItem[];
  returnConsumerPlan?: HudReturnConsumerPlanSummary;
  returnDiagnosis?: HudReturnDiagnosisSummary;
  totalCaseFiles?: number;
  lastCaseAt?: string | null;
  taskGraphItems?: HudTaskGraphItem[];
  taskGraphSourcePath?: string;
  taskGraphReturnPreview?: HudTaskGraphReturnPreviewSummary;
  mirrorObserve?: HudMirrorObserveSummary;
  autoEvolutionObserve?: HudAutoEvolutionObserveSummary;
  semanticRebuild?: HudSemanticRebuildSummary;
  controlSignals?: HudControlSignalsSummary;
  recoveryCandidates?: HudRecoveryCandidatesSummary;
  promotionCandidates?: HudPromotionCandidatesSummary;
  schedulerTickPlan?: HudSchedulerTickPlanSummary;
  warnings?: string[];
  agentDefaults?: HudAgentDefault[];
}

export interface HudState {
  version: "1.1";
  generatedAt: string;
  generator: "runtime-hud-state";
  globalStatus: {
    status: "healthy" | "attention_required" | "degraded";
    runningCount: number;
    completedCount: number;
    failedCount: number;
    alertCount: number;
    pendingReviewCount: number;
    lastUpdatedAt: string;
  };
  agentGroups: HudAgentGroup[];
  activeTasks: unknown[];
  projectGroups: unknown[];
  attentionQueue: unknown[];
  watchdogSnapshot: {
    totalAlerts: number;
    byCondition: Record<string, number>;
    healthyCount: number;
    fixtureCount: 0;
  };
  caseLibrary: {
    totalCases: number;
    lastCaseAt: string | null;
  };
  returnInbox: {
    pendingCount: number;
    lastScanAt: string;
    pendingItems: HudPendingReturnItem[];
  };
  returnConsumerPlan: HudReturnConsumerPlanSummary;
  returnDiagnosis: HudReturnDiagnosisSummary;
  taskGraphs: {
    total: number;
    active: number;
    blocked: number;
    sourcePath: string;
    items: HudTaskGraphItem[];
    returnPreview: HudTaskGraphReturnPreviewSummary;
  };
  mirrorObserve: HudMirrorObserveSummary;
  autoEvolutionObserve: HudAutoEvolutionObserveSummary;
  semanticRebuild: HudSemanticRebuildSummary;
  controlSignals: HudControlSignalsSummary;
  recoveryCandidates: HudRecoveryCandidatesSummary;
  promotionCandidates: HudPromotionCandidatesSummary;
  schedulerTickPlan: HudSchedulerTickPlanSummary;
  warnings: string[];
}

export const DEFAULT_HUD_AGENT_DEFAULTS: HudAgentDefault[] = [
  { agentId: "main", displayName: "main", role: "orchestrator" },
  { agentId: "engineering-executive", displayName: "Engineering Executive", role: "execution" },
  { agentId: "front-end-executive", displayName: "Front-End Executive", role: "execution" },
  { agentId: "patrol", displayName: "Patrol", role: "observability" },
];

const HUD_CONFIGURED_AGENT_IDS = new Set(["patrol"]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstString(
  record: HudPositionState | undefined,
  names: Array<keyof HudPositionState>,
): string | null {
  if (!record) return null;
  for (const name of names) {
    const value = stringValue(record[name]);
    if (value) return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(
  record: HudPositionState | undefined,
  names: Array<keyof HudPositionState>,
): number | null {
  if (!record) return null;
  for (const name of names) {
    const value = numberValue(record[name]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeHudAgentStatus(rawStatus: unknown): HudAgentStatus {
  const status = stringValue(rawStatus)?.toLowerCase() ?? "unknown";
  switch (status) {
    case "available":
    case "idle":
    case "complete":
    case "completed":
      return "completed";
    case "running":
    case "active":
    case "in_progress":
    case "busy":
      return "running";
    case "failed":
    case "error":
      return "failed";
    case "blocked":
      return "attention_required";
    default:
      return status;
  }
}

function buildAgentGroups(input: HudStateInput): HudAgentGroup[] {
  const defaults = input.agentDefaults ?? DEFAULT_HUD_AGENT_DEFAULTS;
  const statesByAgentId = input.positionStatesByAgentId ?? {};
  const defaultsById = new Map(defaults.map((item) => [item.agentId, item]));
  const defaultOrderById = new Map(defaults.map((item, index) => [item.agentId, index]));
  const configuredIds = defaults
    .map((item) => item.agentId)
    .filter((agentId) => statesByAgentId[agentId] || HUD_CONFIGURED_AGENT_IDS.has(agentId));
  const agentIds = configuredIds.sort((a, b) => {
    const aOrder = defaultOrderById.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = defaultOrderById.get(b) ?? Number.MAX_SAFE_INTEGER;
    return aOrder === bOrder ? a.localeCompare(b) : aOrder - bOrder;
  });

  return agentIds.map((agentId) => {
    const state = statesByAgentId[agentId];
    const defaultValue = defaultsById.get(agentId);
    const source = state ? "position-state" : "configured";
    const status = state
      ? normalizeHudAgentStatus(firstString(state, ["status", "currentState", "state"]))
      : "unknown";
    return {
      agentId,
      displayName: defaultValue?.displayName ?? agentId,
      role: defaultValue?.role ?? "execution",
      status,
      currentTask: firstString(state, [
        "currentTask",
        "currentTaskId",
        "currentTicketId",
        "taskId",
      ]),
      currentTaskTitle: firstString(state, ["currentTaskTitle", "currentTicketTitle", "taskTitle"]),
      progressPct: Math.max(
        0,
        Math.min(
          100,
          Math.floor(firstNumber(state, ["progressPct", "progress", "completionPct"]) ?? 0),
        ),
      ),
      source,
      progressDerivation: state ? "position-state" : "unknown",
      hasAlerts: status === "failed" || status === "attention_required",
      lastProgressAt: firstString(state, [
        "lastProgressAt",
        "lastActivityAt",
        "last_activity_at",
        "updatedAt",
      ]),
      lastCompletionAt: firstString(state, ["lastCompletionAt", "completedAt"]),
    };
  });
}

function numberFromRecord(record: Record<string, number> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function defaultMirrorObserveSummary(): HudMirrorObserveSummary {
  return {
    available: false,
    reportPath: null,
    mirrorId: null,
    generatedAt: null,
    mode: null,
    stats: null,
    constraintsVerified: null,
    verdict: null,
  };
}

function defaultAutoEvolutionObserveSummary(): HudAutoEvolutionObserveSummary {
  return {
    available: false,
    reportPath: null,
    generatedAt: null,
    mode: null,
    stats: null,
    constraintsVerified: null,
    verdict: null,
  };
}

function defaultSemanticRebuildSummary(): HudSemanticRebuildSummary {
  return {
    available: false,
    stage: "plan_missing",
    latestPlanPath: null,
    latestAcceptancePath: null,
    latestApprovalPath: null,
    latestExecutionPath: null,
    executionStatus: null,
    totalItems: null,
    plannedBatches: null,
    readyForHumanGate: false,
    readyForExecution: false,
    readyForRealRebuildImplementation: false,
    constraintsVerified: null,
  };
}

function defaultControlSignalsSummary(): HudControlSignalsSummary {
  return {
    mode: "observe-only",
    status: "ok",
    pendingPath: "system/control-signals/pending",
    frozen: false,
    g2Approved: false,
    pendingCount: 0,
    expiredCount: 0,
    errorCount: 0,
    validCount: 0,
    invalidCount: 0,
    byRole: [],
    byAction: [],
    constraintsVerified: {
      readOnly: "yes",
      signalWritten: "no",
      taskGraphMutated: "no",
      sessionsSent: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    },
  };
}

function defaultRecoveryCandidatesSummary(): HudRecoveryCandidatesSummary {
  return {
    mode: "observe-only",
    sourcePath: "runtime/main/tmp/v2-task-graph-01/",
    frozen: false,
    graphCount: 0,
    candidateCount: 0,
    byStatus: [],
    bySuggestedAction: [],
    errorCount: 0,
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

function defaultReturnConsumerPlanSummary(scannedAt: string): HudReturnConsumerPlanSummary {
  return {
    mode: "observe-only",
    scannedAt,
    inboxPath: "system/returns/inbox",
    processedPath: "system/returns/processed",
    totalCount: 0,
    processCount: 0,
    skipCount: 0,
    byReason: [],
    warningCount: 0,
    constraintsVerified: {
      consumed: "no",
      archived: "no",
      receiptWritten: "no",
      taskGraphMutated: "no",
      applied: "no",
    },
  };
}

function defaultReturnDiagnosisSummary(scannedAt: string): HudReturnDiagnosisSummary {
  return {
    mode: "observe-only",
    scannedAt,
    inboxPath: "system/returns/inbox",
    totalCount: 0,
    diagnosableCount: 0,
    byCompatibility: [],
    bySuggestedAction: [],
    byIssueCode: [],
    warningCount: 0,
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

function defaultPromotionCandidatesSummary(): HudPromotionCandidatesSummary {
  return {
    available: false,
    status: "missing",
    sourceFile: "evolution/promotion-candidates.json",
    stateFile: "evolution/candidate-gate-state.json",
    generatedAt: null,
    lastSyncedAt: null,
    stats: {
      total: 0,
      byState: {},
      byRisk: {},
      byConsistency: {},
      invalid: 0,
      safeApplyEligible: 0,
    },
    errorCount: 0,
    constraintsVerified: {
      readOnly: "yes",
      candidateStateWritten: "no",
      truthFilesWritten: "no",
      applied: "none",
      rolledBack: "none",
      autoPromote: "disabled",
    },
  };
}

function defaultSchedulerTickPlanSummary(generatedAt: string): HudSchedulerTickPlanSummary {
  return {
    mode: "observe-only",
    plannedAt: generatedAt,
    decision: "disabled",
    reason: "scheduler marker is disabled",
    enabled: false,
    markerMode: "observe",
    stateStatus: "idle",
    running: false,
    totalTicks: 0,
    nextTickIndex: null,
    maxTicks: {
      effective: 5,
      reason: "global_max_ticks",
      global: 5,
      perTask: null,
      perTaskId: null,
      reached: false,
    },
    sourceFiles: {
      marker: "runtime/main/tmp/task-scheduler-enabled.json",
      state: "runtime/main/tmp/task-scheduler-state.json",
      policy: "runtime/scheduler/scheduler-policy.json",
      tickScript: "evolution/run-auto-progress-tick.ps1",
      tickScriptExists: false,
    },
    warningCount: 0,
    constraintsVerified: {
      readOnly: "yes",
      markerWritten: "no",
      stateWritten: "no",
      eventEmitted: "no",
      scriptInvoked: "no",
      childProcessSpawned: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    },
  };
}

function defaultTaskGraphReturnPreviewSummary(
  observedAt: string,
): HudTaskGraphReturnPreviewSummary {
  return {
    mode: "observe-only",
    observedAt,
    sourcePath: "runtime/main/tmp/v2-task-graph-01/",
    inboxPath: "system/returns/inbox",
    graphCount: 0,
    nodeCount: 0,
    pendingReturnCount: 0,
    matchedNodeCount: 0,
    missingNodeCount: 0,
    ambiguousNodeCount: 0,
    declaredReturnNodeCount: 0,
    unmatchedReturnCount: 0,
    graphErrorCount: 0,
    sampleUnmatchedReturns: [],
    constraintsVerified: {
      graphMutated: "no",
      returnConsumed: "no",
      receiptWritten: "no",
      dispatchTriggered: "no",
      applied: "no",
    },
  };
}

function buildWatchdogConditions(
  mirrorObserve: HudMirrorObserveSummary,
  autoEvolutionObserve: HudAutoEvolutionObserveSummary,
  taskGraphItems: readonly HudTaskGraphItem[],
  controlSignals: HudControlSignalsSummary,
  recoveryCandidates: HudRecoveryCandidatesSummary,
  returnConsumerPlan: HudReturnConsumerPlanSummary,
  returnDiagnosis: HudReturnDiagnosisSummary,
  promotionCandidates: HudPromotionCandidatesSummary,
  schedulerTickPlan: HudSchedulerTickPlanSummary,
  taskGraphReturnPreview: HudTaskGraphReturnPreviewSummary,
): Record<string, number> {
  const byCondition: Record<string, number> = {};
  const taskGraphValidationErrorCount = taskGraphItems.filter(
    (item) => item.validationSeverity === "error",
  ).length;
  const taskGraphValidationWarningCount = taskGraphItems.filter(
    (item) => item.validationSeverity === "warning",
  ).length;
  if (taskGraphValidationErrorCount > 0)
    byCondition.taskGraphValidationError = taskGraphValidationErrorCount;
  if (taskGraphValidationWarningCount > 0)
    byCondition.taskGraphValidationWarning = taskGraphValidationWarningCount;

  const bySeverity = mirrorObserve.stats?.bySeverity;
  const attentionCount = numberFromRecord(bySeverity, "attention");
  const warningCount = numberFromRecord(bySeverity, "warning");
  if (attentionCount > 0) byCondition.mirrorObserveAttention = attentionCount;
  if (warningCount > 0) byCondition.mirrorObserveWarning = warningCount;

  const constraints = mirrorObserve.constraintsVerified ?? {};
  const expectedConstraints: Record<string, string> = {
    MEMORYWritten: "no",
    ENGINEERING_RULESWritten: "no",
    skillLibraryWritten: "no",
    caseLibraryWritten: "no",
    promoted: "none",
    autoLoopTriggered: "no",
    applyPerformed: "no",
  };
  const violationCount = Object.entries(expectedConstraints).filter(
    ([key, expected]) => constraints[key] !== undefined && constraints[key] !== expected,
  ).length;
  if (violationCount > 0) byCondition.mirrorObserveConstraintViolation = violationCount;

  const byPriority = autoEvolutionObserve.stats?.byPriority;
  const p0Count = numberFromRecord(byPriority, "P0");
  const p1Count = numberFromRecord(byPriority, "P1");
  if (p0Count > 0) byCondition.autoEvolutionObserveP0 = p0Count;
  if (p1Count > 0) byCondition.autoEvolutionObserveP1 = p1Count;

  const evolutionConstraints = autoEvolutionObserve.constraintsVerified ?? {};
  const expectedEvolutionConstraints: Record<string, string> = {
    MEMORYWritten: "no",
    ENGINEERING_RULESWritten: "no",
    codeWritten: "no",
    skillLibraryWritten: "no",
    caseLibraryWritten: "no",
    promoted: "none",
    applyPerformed: "no",
    autoEvolutionApplied: "no",
    continuousAutoLoopTriggered: "no",
  };
  const evolutionViolationCount = Object.entries(expectedEvolutionConstraints).filter(
    ([key, expected]) =>
      evolutionConstraints[key] !== undefined && evolutionConstraints[key] !== expected,
  ).length;
  if (evolutionViolationCount > 0) {
    byCondition.autoEvolutionObserveConstraintViolation = evolutionViolationCount;
  }
  if (controlSignals.pendingCount > 0) {
    byCondition.pendingControlSignals = controlSignals.pendingCount;
  }
  if (controlSignals.invalidCount > 0) {
    byCondition.invalidControlSignals = controlSignals.invalidCount;
  }
  if (controlSignals.errorCount > 0) {
    byCondition.controlSignalScanError = controlSignals.errorCount;
  }
  if (recoveryCandidates.candidateCount > 0) {
    byCondition.recoveryCandidates = recoveryCandidates.candidateCount;
  }
  if (recoveryCandidates.errorCount > 0) {
    byCondition.recoveryCandidateScanError = recoveryCandidates.errorCount;
  }
  if (returnConsumerPlan.processCount > 0) {
    byCondition.returnConsumerProcessable = returnConsumerPlan.processCount;
  }
  if (returnConsumerPlan.skipCount > 0) {
    byCondition.returnConsumerSkipped = returnConsumerPlan.skipCount;
  }
  if (returnConsumerPlan.warningCount > 0) {
    byCondition.returnConsumerPlanWarning = returnConsumerPlan.warningCount;
  }
  if (returnDiagnosis.diagnosableCount > 0) {
    byCondition.returnDiagnosisIssue = returnDiagnosis.diagnosableCount;
  }
  if (returnDiagnosis.warningCount > 0) {
    byCondition.returnDiagnosisWarning = returnDiagnosis.warningCount;
  }
  if (promotionCandidates.stats.invalid > 0) {
    byCondition.invalidPromotionCandidates = promotionCandidates.stats.invalid;
  }
  const consistencyIssueCount = Object.entries(promotionCandidates.stats.byConsistency).reduce(
    (sum, [key, count]) => (key === "ok" ? sum : sum + Math.max(0, count)),
    0,
  );
  if (consistencyIssueCount > 0) {
    byCondition.promotionCandidateConsistencyIssue = consistencyIssueCount;
  }
  if (promotionCandidates.errorCount > 0) {
    byCondition.promotionCandidateScanError = promotionCandidates.errorCount;
  }
  if (schedulerTickPlan.decision === "would_spawn_apply_tick") {
    byCondition.schedulerWouldSpawnApplyTick = 1;
  }
  if (schedulerTickPlan.decision === "max_ticks_reached") {
    byCondition.schedulerMaxTicksReached = 1;
  }
  if (schedulerTickPlan.decision === "already_running") {
    byCondition.schedulerAlreadyRunning = 1;
  }
  if (taskGraphReturnPreview.unmatchedReturnCount > 0) {
    byCondition.taskGraphUnmatchedReturns = taskGraphReturnPreview.unmatchedReturnCount;
  }
  if (taskGraphReturnPreview.graphErrorCount > 0) {
    byCondition.taskGraphReturnPreviewError = taskGraphReturnPreview.graphErrorCount;
  }
  return byCondition;
}

export function generateHudState(input: HudStateInput): HudState {
  const agentGroups = buildAgentGroups(input);
  const warnings = input.warnings ?? [];
  const pendingReturnItems = input.pendingReturnItems ?? [];
  const taskGraphItems = (input.taskGraphItems ?? []).slice(0, 5);
  const runningCount = agentGroups.filter((agent) => agent.status === "running").length;
  const completedCount = agentGroups.filter((agent) => agent.status === "completed").length;
  const failedCount = agentGroups.filter((agent) => agent.status === "failed").length;
  const alertCount = agentGroups.filter((agent) => agent.hasAlerts).length;
  const mirrorObserve = input.mirrorObserve ?? defaultMirrorObserveSummary();
  const autoEvolutionObserve = input.autoEvolutionObserve ?? defaultAutoEvolutionObserveSummary();
  const semanticRebuild = input.semanticRebuild ?? defaultSemanticRebuildSummary();
  const controlSignals = input.controlSignals ?? defaultControlSignalsSummary();
  const recoveryCandidates = input.recoveryCandidates ?? defaultRecoveryCandidatesSummary();
  const returnConsumerPlan =
    input.returnConsumerPlan ?? defaultReturnConsumerPlanSummary(input.generatedAt);
  const returnDiagnosis = input.returnDiagnosis ?? defaultReturnDiagnosisSummary(input.generatedAt);
  const promotionCandidates = input.promotionCandidates ?? defaultPromotionCandidatesSummary();
  const schedulerTickPlan =
    input.schedulerTickPlan ?? defaultSchedulerTickPlanSummary(input.generatedAt);
  const taskGraphReturnPreview =
    input.taskGraphReturnPreview ?? defaultTaskGraphReturnPreviewSummary(input.generatedAt);
  const watchdogConditions = buildWatchdogConditions(
    mirrorObserve,
    autoEvolutionObserve,
    taskGraphItems,
    controlSignals,
    recoveryCandidates,
    returnConsumerPlan,
    returnDiagnosis,
    promotionCandidates,
    schedulerTickPlan,
    taskGraphReturnPreview,
  );
  const watchdogConditionAlertCount = Object.values(watchdogConditions).reduce(
    (sum, count) => sum + count,
    0,
  );

  let globalStatus: HudState["globalStatus"]["status"] = "healthy";
  if (failedCount > 0 || pendingReturnItems.length > 0) {
    globalStatus = "attention_required";
  } else if (
    warnings.length > 0 ||
    agentGroups.some((agent) => agent.status === "unknown" && agent.source === "position-state")
  ) {
    globalStatus = "degraded";
  }

  return {
    version: "1.1",
    generatedAt: input.generatedAt,
    generator: "runtime-hud-state",
    globalStatus: {
      status: globalStatus,
      runningCount,
      completedCount,
      failedCount,
      alertCount,
      pendingReviewCount: pendingReturnItems.length,
      lastUpdatedAt: input.generatedAt,
    },
    agentGroups,
    activeTasks: [],
    projectGroups: [],
    attentionQueue: [],
    watchdogSnapshot: {
      totalAlerts: alertCount + watchdogConditionAlertCount,
      byCondition: watchdogConditions,
      healthyCount: agentGroups.filter((agent) => !agent.hasAlerts).length,
      fixtureCount: 0,
    },
    caseLibrary: {
      totalCases: input.totalCaseFiles ?? 0,
      lastCaseAt: input.lastCaseAt ?? null,
    },
    returnInbox: {
      pendingCount: pendingReturnItems.length,
      lastScanAt: input.generatedAt,
      pendingItems: pendingReturnItems,
    },
    returnConsumerPlan,
    returnDiagnosis,
    taskGraphs: {
      total: input.taskGraphItems?.length ?? 0,
      active: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus !== "completed")
        .length,
      blocked: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus === "blocked")
        .length,
      sourcePath: input.taskGraphSourcePath ?? "runtime/main/tmp/v2-task-graph-01/",
      items: taskGraphItems,
      returnPreview: taskGraphReturnPreview,
    },
    mirrorObserve,
    autoEvolutionObserve,
    semanticRebuild,
    controlSignals,
    recoveryCandidates,
    promotionCandidates,
    schedulerTickPlan,
    warnings,
  };
}
