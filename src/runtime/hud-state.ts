import type { ControlSignalScanResult } from "./control-signals.js";
import type { PromotionCandidatesScan } from "./distillation/promotion-candidates.js";
import type { PositionConfigAuditResult } from "./position-config-audit.js";
import type { PositionConfigCleanupGateResult } from "./position-config-cleanup-gate.js";
import type { PositionConfigCleanupPlanResult } from "./position-config-cleanup-plan.js";
import type { RecoveryCandidateScanResult } from "./recovery-candidates.js";
import type { ReturnConsumerPlanScanResult } from "./returns/return-consumer-plan.js";
import type { ReturnDiagnosisScanResult } from "./returns/return-diagnosis.js";
import type { ReturnReconciliationApplyPlanResult } from "./returns/return-reconciliation-apply-plan.js";
import type { ReturnReconciliationGateResult } from "./returns/return-reconciliation-gate.js";
import type { ReturnRepairDryRunResult } from "./returns/return-repair-dry-run.js";
import type { SchedulerTickPlan } from "./scheduler-tick-plan.js";
import type { TaskGraphReturnLinkDryRunResult } from "./task-graph-return-link-dry-run.js";
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

export type HudPositionConfigAuditSummary = Pick<
  PositionConfigAuditResult,
  | "mode"
  | "auditedAt"
  | "configPath"
  | "available"
  | "enabledPositions"
  | "officialPositionIds"
  | "nonV2EnabledPositions"
  | "configuredOnlyPositions"
  | "missingEnabledModelMappings"
  | "missingEnabledOverrides"
  | "positionModelMappingCount"
  | "positionOverrideCount"
  | "warnings"
  | "constraintsVerified"
>;

export type HudPositionConfigCleanupPlanSummary = Pick<
  PositionConfigCleanupPlanResult,
  | "mode"
  | "dryRun"
  | "plannedAt"
  | "status"
  | "configPath"
  | "available"
  | "staleConfiguredOnlyPositions"
  | "retainedConfiguredOnlyOfficialPositions"
  | "nonV2EnabledPositions"
  | "removalStepCount"
  | "readyStepCount"
  | "blockedStepCount"
  | "readyForControlledApply"
  | "blockedReasons"
  | "constraintsVerified"
>;

export type HudPositionConfigCleanupGateSummary = Pick<
  PositionConfigCleanupGateResult,
  | "mode"
  | "checkedAt"
  | "status"
  | "frozen"
  | "g2Approved"
  | "readyForControlledApply"
  | "applyBlockedReason"
  | "nextAction"
  | "cleanup"
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

export type HudReturnRepairDryRunSummary = Pick<
  ReturnRepairDryRunResult,
  | "mode"
  | "dryRun"
  | "plannedAt"
  | "inboxPath"
  | "totalDiagnosed"
  | "candidateCount"
  | "repairableCount"
  | "blockedCount"
  | "constraintsVerified"
> & { warningCount: number; packagePreviewAvailableCount: number };

export type HudReturnReconciliationGateSummary = ReturnReconciliationGateResult;

export type HudReturnReconciliationApplyPlanSummary = Pick<
  ReturnReconciliationApplyPlanResult,
  | "mode"
  | "dryRun"
  | "plannedAt"
  | "status"
  | "frozen"
  | "readyForControlledApply"
  | "blockedReasons"
  | "nextAction"
  | "repair"
  | "returnLink"
  | "stepCount"
  | "readyStepCount"
  | "blockedStepCount"
  | "constraintsVerified"
>;

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

export interface HudPromoteGateSummary {
  available: boolean;
  reportDir: string;
  reportPath: string | null;
  error: string | null;
  status: string | null;
  mode: string | null;
  generatedAt: string | null;
  frozenActive: boolean | null;
  outputFile: string | null;
  stats: {
    total: number;
    byVerdict: Record<string, number>;
    byType: Record<string, number>;
  } | null;
  constraintsVerified: Record<string, string> | null;
}

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

export type HudLongmaV3LaneStatus =
  | "online"
  | "ready"
  | "observe_only"
  | "needs_attention"
  | "blocked"
  | "bootstrapping";

export type HudLongmaV3Status = "online" | "ready" | "attention_required" | "bootstrapping";

export interface HudLongmaV3Lane {
  id:
    | "memory_continuity"
    | "skill_distillation"
    | "autonomous_evolution"
    | "recovery_loop";
  label: string;
  status: HudLongmaV3LaneStatus;
  signalCount: number;
  detail: string;
  sourcePath: string | null;
}

export interface HudLongmaV3Summary {
  mode: "observe-only";
  status: HudLongmaV3Status;
  generatedAt: string;
  lanes: {
    memoryContinuity: HudLongmaV3Lane;
    skillDistillation: HudLongmaV3Lane;
    autonomousEvolution: HudLongmaV3Lane;
    recoveryLoop: HudLongmaV3Lane;
  };
  nextActions: string[];
  constraintsVerified: Record<string, string>;
}

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

export type HudTaskGraphReturnLinkDryRunSummary = Pick<
  TaskGraphReturnLinkDryRunResult,
  | "mode"
  | "dryRun"
  | "plannedAt"
  | "sourcePath"
  | "inboxPath"
  | "unmatchedReturnCount"
  | "candidateCount"
  | "linkableCount"
  | "blockedCount"
  | "graphErrorCount"
  | "constraintsVerified"
> & { warningCount: number };

export interface HudStateInput {
  generatedAt: string;
  positionStatesByAgentId?: Record<string, HudPositionState>;
  pendingReturnItems?: HudPendingReturnItem[];
  returnConsumerPlan?: HudReturnConsumerPlanSummary;
  returnDiagnosis?: HudReturnDiagnosisSummary;
  returnRepairDryRun?: HudReturnRepairDryRunSummary;
  returnReconciliationGate?: HudReturnReconciliationGateSummary;
  returnReconciliationApplyPlan?: HudReturnReconciliationApplyPlanSummary;
  totalCaseFiles?: number;
  lastCaseAt?: string | null;
  taskGraphItems?: HudTaskGraphItem[];
  taskGraphSourcePath?: string;
  taskGraphReturnPreview?: HudTaskGraphReturnPreviewSummary;
  taskGraphReturnLinkDryRun?: HudTaskGraphReturnLinkDryRunSummary;
  mirrorObserve?: HudMirrorObserveSummary;
  autoEvolutionObserve?: HudAutoEvolutionObserveSummary;
  semanticRebuild?: HudSemanticRebuildSummary;
  controlSignals?: HudControlSignalsSummary;
  positionConfigAudit?: HudPositionConfigAuditSummary;
  positionConfigCleanupPlan?: HudPositionConfigCleanupPlanSummary;
  positionConfigCleanupGate?: HudPositionConfigCleanupGateSummary;
  recoveryCandidates?: HudRecoveryCandidatesSummary;
  promotionCandidates?: HudPromotionCandidatesSummary;
  promoteGate?: HudPromoteGateSummary;
  schedulerTickPlan?: HudSchedulerTickPlanSummary;
  longmaV3?: HudLongmaV3Summary;
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
  returnRepairDryRun: HudReturnRepairDryRunSummary;
  returnReconciliationGate: HudReturnReconciliationGateSummary;
  returnReconciliationApplyPlan: HudReturnReconciliationApplyPlanSummary;
  taskGraphs: {
    total: number;
    active: number;
    blocked: number;
    sourcePath: string;
    items: HudTaskGraphItem[];
    returnPreview: HudTaskGraphReturnPreviewSummary;
    returnLinkDryRun: HudTaskGraphReturnLinkDryRunSummary;
  };
  mirrorObserve: HudMirrorObserveSummary;
  autoEvolutionObserve: HudAutoEvolutionObserveSummary;
  semanticRebuild: HudSemanticRebuildSummary;
  controlSignals: HudControlSignalsSummary;
  positionConfigAudit: HudPositionConfigAuditSummary;
  positionConfigCleanupPlan: HudPositionConfigCleanupPlanSummary;
  positionConfigCleanupGate: HudPositionConfigCleanupGateSummary;
  recoveryCandidates: HudRecoveryCandidatesSummary;
  promotionCandidates: HudPromotionCandidatesSummary;
  promoteGate: HudPromoteGateSummary;
  schedulerTickPlan: HudSchedulerTickPlanSummary;
  longmaV3: HudLongmaV3Summary;
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

function defaultPositionConfigAuditSummary(generatedAt: string): HudPositionConfigAuditSummary {
  return {
    mode: "observe-only",
    auditedAt: generatedAt,
    configPath: ".claw/positions.json",
    available: false,
    enabledPositions: [],
    officialPositionIds: ["main", "engineering-executive", "front-end-executive", "patrol"],
    nonV2EnabledPositions: [],
    configuredOnlyPositions: [],
    missingEnabledModelMappings: [],
    missingEnabledOverrides: [],
    positionModelMappingCount: 0,
    positionOverrideCount: 0,
    warnings: [],
    constraintsVerified: {
      readOnly: "yes",
      positionConfigWritten: "no",
      agentsListMutated: "no",
      sessionsSent: "no",
      applied: "no",
    },
  };
}

function defaultPositionConfigCleanupPlanSummary(
  generatedAt: string,
): HudPositionConfigCleanupPlanSummary {
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt: generatedAt,
    status: "clean",
    configPath: ".claw/positions.json",
    available: false,
    staleConfiguredOnlyPositions: [],
    retainedConfiguredOnlyOfficialPositions: [],
    nonV2EnabledPositions: [],
    removalStepCount: 0,
    readyStepCount: 0,
    blockedStepCount: 0,
    readyForControlledApply: false,
    blockedReasons: [],
    constraintsVerified: {
      readOnly: "yes",
      positionConfigWritten: "no",
      agentsListMutated: "no",
      sessionsSent: "no",
      applied: "no",
    },
  };
}

function defaultPositionConfigCleanupGateSummary(
  generatedAt: string,
): HudPositionConfigCleanupGateSummary {
  return {
    mode: "observe-only",
    checkedAt: generatedAt,
    status: "empty",
    frozen: false,
    g2Approved: false,
    readyForControlledApply: false,
    applyBlockedReason: null,
    nextAction: "no_action",
    cleanup: {
      staleConfiguredOnlyCount: 0,
      removalStepCount: 0,
      readyStepCount: 0,
      blockedStepCount: 0,
    },
    constraintsVerified: {
      readOnly: "yes",
      positionConfigWritten: "no",
      agentsListMutated: "no",
      sessionsSent: "no",
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

function defaultReturnRepairDryRunSummary(plannedAt: string): HudReturnRepairDryRunSummary {
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    inboxPath: "system/returns/inbox",
    totalDiagnosed: 0,
    candidateCount: 0,
    repairableCount: 0,
    blockedCount: 0,
    packagePreviewAvailableCount: 0,
    warningCount: 0,
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      originalReturnMutated: "no",
      archived: "no",
      receiptWritten: "no",
      consumerTriggered: "no",
      applied: "no",
    },
  };
}

function defaultReturnReconciliationGateSummary(
  checkedAt: string,
): HudReturnReconciliationGateSummary {
  return {
    mode: "observe-only",
    checkedAt,
    status: "empty",
    frozen: false,
    readyForControlledApply: false,
    applyBlockedReason: null,
    nextAction: "no_action",
    repair: {
      candidateCount: 0,
      repairableCount: 0,
      blockedCount: 0,
    },
    returnLink: {
      candidateCount: 0,
      linkableCount: 0,
      blockedCount: 0,
    },
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      taskGraphWritten: "no",
      receiptWritten: "no",
      consumerTriggered: "no",
      dispatchTriggered: "no",
      applied: "no",
    },
  };
}

function defaultReturnReconciliationApplyPlanSummary(
  plannedAt: string,
): HudReturnReconciliationApplyPlanSummary {
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    status: "empty",
    frozen: false,
    readyForControlledApply: false,
    blockedReasons: [],
    nextAction: "no_action",
    repair: {
      candidateCount: 0,
      repairableCount: 0,
      blockedCount: 0,
    },
    returnLink: {
      candidateCount: 0,
      linkableCount: 0,
      blockedCount: 0,
    },
    stepCount: 0,
    readyStepCount: 0,
    blockedStepCount: 0,
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      taskGraphWritten: "no",
      receiptWritten: "no",
      consumerTriggered: "no",
      dispatchTriggered: "no",
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

function defaultPromoteGateSummary(): HudPromoteGateSummary {
  return {
    available: false,
    reportDir: "runtime/main/tmp",
    reportPath: null,
    error: null,
    status: null,
    mode: null,
    generatedAt: null,
    frozenActive: null,
    outputFile: null,
    stats: null,
    constraintsVerified: null,
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

function defaultTaskGraphReturnLinkDryRunSummary(
  plannedAt: string,
): HudTaskGraphReturnLinkDryRunSummary {
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    sourcePath: "runtime/main/tmp/v2-task-graph-01/",
    inboxPath: "system/returns/inbox",
    unmatchedReturnCount: 0,
    candidateCount: 0,
    linkableCount: 0,
    blockedCount: 0,
    graphErrorCount: 0,
    warningCount: 0,
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

function constraintViolationCount(
  constraints: Record<string, string> | null | undefined,
  expected: Record<string, string>,
): number {
  const actual = constraints ?? {};
  return Object.entries(expected).filter(
    ([key, expectedValue]) => actual[key] !== undefined && actual[key] !== expectedValue,
  ).length;
}

function buildLongmaLane(
  id: HudLongmaV3Lane["id"],
  label: string,
  status: HudLongmaV3LaneStatus,
  signalCount: number,
  detail: string,
  sourcePath: string | null,
): HudLongmaV3Lane {
  return {
    id,
    label,
    status,
    signalCount: Math.max(0, signalCount),
    detail,
    sourcePath,
  };
}

function buildLongmaV3MemoryLane(
  semanticRebuild: HudSemanticRebuildSummary,
): HudLongmaV3Lane {
  const totalItems = semanticRebuild.totalItems ?? 0;
  const sourcePath =
    semanticRebuild.latestExecutionPath ??
    semanticRebuild.latestApprovalPath ??
    semanticRebuild.latestAcceptancePath ??
    semanticRebuild.latestPlanPath;
  if (semanticRebuild.stage === "applied") {
    return buildLongmaLane(
      "memory_continuity",
      "memory-continuity",
      "online",
      totalItems,
      `${totalItems} semantic item(s) indexed`,
      sourcePath,
    );
  }
  if (semanticRebuild.readyForRealRebuildImplementation) {
    return buildLongmaLane(
      "memory_continuity",
      "memory-continuity",
      "ready",
      totalItems,
      "approved semantic rebuild is ready for controlled execution",
      sourcePath,
    );
  }
  if (semanticRebuild.stage === "blocked") {
    return buildLongmaLane(
      "memory_continuity",
      "memory-continuity",
      "blocked",
      totalItems,
      "semantic rebuild is blocked",
      sourcePath,
    );
  }
  return buildLongmaLane(
    "memory_continuity",
    "memory-continuity",
    semanticRebuild.available ? "observe_only" : "bootstrapping",
    totalItems,
    semanticRebuild.available
      ? `semantic rebuild stage: ${semanticRebuild.stage}`
      : "semantic rebuild plan has not been generated",
    sourcePath,
  );
}

function buildLongmaV3SkillLane(
  promotionCandidates: HudPromotionCandidatesSummary,
  promoteGate: HudPromoteGateSummary,
): HudLongmaV3Lane {
  const consistencyIssueCount = Object.entries(promotionCandidates.stats.byConsistency).reduce(
    (sum, [key, value]) => (key === "ok" ? sum : sum + Math.max(0, value)),
    0,
  );
  const gateStats = promoteGate.stats;
  const promoteReady =
    numberFromRecord(gateStats?.byVerdict, "READY_FOR_PROMOTE_GATE") +
    numberFromRecord(gateStats?.byVerdict, "ROUTE_D1_CONTROLLED_APPLY") +
    numberFromRecord(gateStats?.byVerdict, "WAITING_SEPARATE_ENGINEERING_RULE_APPROVAL");
  const promoteAttention =
    numberFromRecord(gateStats?.byVerdict, "WAITING_REVIEW") +
    numberFromRecord(gateStats?.byVerdict, "NEEDS_EVIDENCE") +
    numberFromRecord(gateStats?.byVerdict, "FROZEN_BLOCKED") +
    numberFromRecord(gateStats?.byVerdict, "BLOCKED") +
    (promoteGate.error ? 1 : 0);
  const issueCount =
    promotionCandidates.stats.invalid +
    promotionCandidates.errorCount +
    consistencyIssueCount +
    promoteAttention;
  const safeApplyEligible = promotionCandidates.stats.safeApplyEligible;
  const totalCandidates = promotionCandidates.stats.total;
  const gateTotal = gateStats?.total ?? 0;
  const status: HudLongmaV3LaneStatus =
    issueCount > 0
      ? "needs_attention"
      : safeApplyEligible > 0 || promoteReady > 0
        ? "ready"
        : totalCandidates > 0 || gateTotal > 0
          ? "observe_only"
          : promotionCandidates.available || promoteGate.available
            ? "online"
            : "bootstrapping";
  return buildLongmaLane(
    "skill_distillation",
    "skill-distillation",
    status,
    totalCandidates + gateTotal,
    `${safeApplyEligible} safe candidate(s), ${promoteReady} promote-ready plan(s), ${issueCount} issue(s)`,
    promoteGate.reportPath ?? promotionCandidates.sourceFile,
  );
}

function buildLongmaV3EvolutionLane(
  autoEvolutionObserve: HudAutoEvolutionObserveSummary,
): HudLongmaV3Lane {
  const suggestions = autoEvolutionObserve.stats?.totalSuggestions ?? 0;
  const highPriority =
    numberFromRecord(autoEvolutionObserve.stats?.byPriority, "P0") +
    numberFromRecord(autoEvolutionObserve.stats?.byPriority, "P1");
  const constraintIssues = constraintViolationCount(autoEvolutionObserve.constraintsVerified, {
    MEMORYWritten: "no",
    ENGINEERING_RULESWritten: "no",
    codeWritten: "no",
    skillLibraryWritten: "no",
    caseLibraryWritten: "no",
    promoted: "none",
    applyPerformed: "no",
    autoEvolutionApplied: "no",
    continuousAutoLoopTriggered: "no",
  });
  const status: HudLongmaV3LaneStatus =
    highPriority > 0 || constraintIssues > 0
      ? "needs_attention"
      : suggestions > 0
        ? "observe_only"
        : autoEvolutionObserve.available
          ? "online"
          : "bootstrapping";
  return buildLongmaLane(
    "autonomous_evolution",
    "autonomous-evolution",
    status,
    suggestions,
    `${suggestions} suggestion(s), ${highPriority} high-priority`,
    autoEvolutionObserve.reportPath,
  );
}

function buildLongmaV3RecoveryLane(input: {
  pendingReturnItems: readonly HudPendingReturnItem[];
  recoveryCandidates: HudRecoveryCandidatesSummary;
  returnConsumerPlan: HudReturnConsumerPlanSummary;
  returnDiagnosis: HudReturnDiagnosisSummary;
  returnRepairDryRun: HudReturnRepairDryRunSummary;
  returnReconciliationApplyPlan: HudReturnReconciliationApplyPlanSummary;
}): HudLongmaV3Lane {
  const pendingReturns = input.pendingReturnItems.length;
  const readyCount =
    input.recoveryCandidates.candidateCount +
    input.returnConsumerPlan.processCount +
    input.returnDiagnosis.diagnosableCount +
    input.returnRepairDryRun.repairableCount +
    input.returnReconciliationApplyPlan.readyStepCount;
  const blockedCount =
    input.returnRepairDryRun.blockedCount + input.returnReconciliationApplyPlan.blockedStepCount;
  const signalCount = pendingReturns + readyCount + blockedCount;
  const status: HudLongmaV3LaneStatus =
    blockedCount > 0 ? "needs_attention" : signalCount > 0 ? "ready" : "online";
  return buildLongmaLane(
    "recovery_loop",
    "recovery-loop",
    status,
    signalCount,
    `${pendingReturns} return(s), ${input.recoveryCandidates.candidateCount} recovery candidate(s)`,
    input.returnRepairDryRun.inboxPath,
  );
}

function buildLongmaV3Summary(input: {
  generatedAt: string;
  pendingReturnItems: readonly HudPendingReturnItem[];
  semanticRebuild: HudSemanticRebuildSummary;
  autoEvolutionObserve: HudAutoEvolutionObserveSummary;
  recoveryCandidates: HudRecoveryCandidatesSummary;
  returnConsumerPlan: HudReturnConsumerPlanSummary;
  returnDiagnosis: HudReturnDiagnosisSummary;
  returnRepairDryRun: HudReturnRepairDryRunSummary;
  returnReconciliationApplyPlan: HudReturnReconciliationApplyPlanSummary;
  promotionCandidates: HudPromotionCandidatesSummary;
  promoteGate: HudPromoteGateSummary;
}): HudLongmaV3Summary {
  const lanes = {
    memoryContinuity: buildLongmaV3MemoryLane(input.semanticRebuild),
    skillDistillation: buildLongmaV3SkillLane(input.promotionCandidates, input.promoteGate),
    autonomousEvolution: buildLongmaV3EvolutionLane(input.autoEvolutionObserve),
    recoveryLoop: buildLongmaV3RecoveryLane(input),
  };
  const laneValues = Object.values(lanes);
  const status: HudLongmaV3Status = laneValues.some(
    (lane) => lane.status === "needs_attention" || lane.status === "blocked",
  )
    ? "attention_required"
    : laneValues.some((lane) => lane.status === "ready")
      ? "ready"
      : laneValues.some((lane) => lane.status === "bootstrapping")
        ? "bootstrapping"
        : "online";
  const nextActions: string[] = [];
  if (lanes.memoryContinuity.status === "ready") {
    nextActions.push("run approved semantic rebuild through the controlled execution gate");
  } else if (lanes.memoryContinuity.status === "bootstrapping") {
    nextActions.push("generate a semantic rebuild plan from current memory sources");
  }
  if (lanes.skillDistillation.status === "ready") {
    nextActions.push("review safe promotion candidates before controlled skill-library writes");
  } else if (lanes.skillDistillation.status === "needs_attention") {
    nextActions.push("repair invalid or inconsistent promotion candidates");
  }
  if (lanes.autonomousEvolution.status === "needs_attention") {
    nextActions.push("resolve high-priority auto-evolution observations before enabling apply loop");
  }
  if (lanes.recoveryLoop.status === "ready" || lanes.recoveryLoop.status === "needs_attention") {
    nextActions.push("drain return and recovery queues through dry-run gates");
  }
  if (nextActions.length === 0) {
    nextActions.push("keep V3 observe loop refreshing HUD state");
  }
  return {
    mode: "observe-only",
    status,
    generatedAt: input.generatedAt,
    lanes,
    nextActions,
    constraintsVerified: {
      readOnly: "yes",
      MEMORYWritten: "no",
      skillLibraryWritten: "no",
      codeWritten: "no",
      deviceAccessed: "no",
      autoApplyTriggered: "no",
      applied: "no",
    },
  };
}

function buildWatchdogConditions(
  mirrorObserve: HudMirrorObserveSummary,
  autoEvolutionObserve: HudAutoEvolutionObserveSummary,
  taskGraphItems: readonly HudTaskGraphItem[],
  controlSignals: HudControlSignalsSummary,
  positionConfigAudit: HudPositionConfigAuditSummary,
  positionConfigCleanupPlan: HudPositionConfigCleanupPlanSummary,
  positionConfigCleanupGate: HudPositionConfigCleanupGateSummary,
  recoveryCandidates: HudRecoveryCandidatesSummary,
  returnConsumerPlan: HudReturnConsumerPlanSummary,
  returnDiagnosis: HudReturnDiagnosisSummary,
  returnRepairDryRun: HudReturnRepairDryRunSummary,
  returnReconciliationGate: HudReturnReconciliationGateSummary,
  promotionCandidates: HudPromotionCandidatesSummary,
  schedulerTickPlan: HudSchedulerTickPlanSummary,
  taskGraphReturnPreview: HudTaskGraphReturnPreviewSummary,
  taskGraphReturnLinkDryRun: HudTaskGraphReturnLinkDryRunSummary,
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
  if (positionConfigAudit.configuredOnlyPositions.length > 0) {
    byCondition.positionConfigConfiguredOnly = positionConfigAudit.configuredOnlyPositions.length;
  }
  if (positionConfigAudit.nonV2EnabledPositions.length > 0) {
    byCondition.positionConfigNonV2Enabled = positionConfigAudit.nonV2EnabledPositions.length;
  }
  if (positionConfigCleanupPlan.readyForControlledApply) {
    byCondition.positionConfigCleanupReady = Math.max(
      1,
      positionConfigCleanupPlan.removalStepCount,
    );
  }
  if (
    positionConfigCleanupPlan.blockedStepCount > 0 ||
    positionConfigCleanupPlan.blockedReasons.length > 0
  ) {
    byCondition.positionConfigCleanupBlocked = Math.max(
      1,
      positionConfigCleanupPlan.blockedStepCount,
      positionConfigCleanupPlan.blockedReasons.length,
    );
  }
  if (positionConfigCleanupGate.applyBlockedReason === "frozen") {
    byCondition.positionConfigCleanupFrozenBlocked = 1;
  }
  if (positionConfigCleanupGate.applyBlockedReason === "cleanup_plan_blocked") {
    byCondition.positionConfigCleanupGateBlocked = Math.max(
      1,
      positionConfigCleanupGate.cleanup.blockedStepCount,
    );
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
  if (returnRepairDryRun.blockedCount > 0) {
    byCondition.returnRepairDryRunBlocked = returnRepairDryRun.blockedCount;
  }
  if (returnRepairDryRun.warningCount > 0) {
    byCondition.returnRepairDryRunWarning = returnRepairDryRun.warningCount;
  }
  if (returnReconciliationGate.applyBlockedReason === "dry_run_blocked") {
    byCondition.returnReconciliationDryRunBlocked = Math.max(
      1,
      returnReconciliationGate.repair.blockedCount +
        returnReconciliationGate.returnLink.blockedCount,
    );
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
  if (taskGraphReturnLinkDryRun.blockedCount > 0) {
    byCondition.taskGraphReturnLinkBlocked = taskGraphReturnLinkDryRun.blockedCount;
  }
  if (taskGraphReturnLinkDryRun.warningCount > 0) {
    byCondition.taskGraphReturnLinkWarning = taskGraphReturnLinkDryRun.warningCount;
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
  const positionConfigAudit =
    input.positionConfigAudit ?? defaultPositionConfigAuditSummary(input.generatedAt);
  const positionConfigCleanupPlan =
    input.positionConfigCleanupPlan ?? defaultPositionConfigCleanupPlanSummary(input.generatedAt);
  const positionConfigCleanupGate =
    input.positionConfigCleanupGate ?? defaultPositionConfigCleanupGateSummary(input.generatedAt);
  const recoveryCandidates = input.recoveryCandidates ?? defaultRecoveryCandidatesSummary();
  const returnConsumerPlan =
    input.returnConsumerPlan ?? defaultReturnConsumerPlanSummary(input.generatedAt);
  const returnDiagnosis = input.returnDiagnosis ?? defaultReturnDiagnosisSummary(input.generatedAt);
  const returnRepairDryRun =
    input.returnRepairDryRun ?? defaultReturnRepairDryRunSummary(input.generatedAt);
  const returnReconciliationGate =
    input.returnReconciliationGate ?? defaultReturnReconciliationGateSummary(input.generatedAt);
  const returnReconciliationApplyPlan =
    input.returnReconciliationApplyPlan ??
    defaultReturnReconciliationApplyPlanSummary(input.generatedAt);
  const promotionCandidates = input.promotionCandidates ?? defaultPromotionCandidatesSummary();
  const promoteGate = input.promoteGate ?? defaultPromoteGateSummary();
  const schedulerTickPlan =
    input.schedulerTickPlan ?? defaultSchedulerTickPlanSummary(input.generatedAt);
  const taskGraphReturnPreview =
    input.taskGraphReturnPreview ?? defaultTaskGraphReturnPreviewSummary(input.generatedAt);
  const taskGraphReturnLinkDryRun =
    input.taskGraphReturnLinkDryRun ?? defaultTaskGraphReturnLinkDryRunSummary(input.generatedAt);
  const longmaV3 =
    input.longmaV3 ??
    buildLongmaV3Summary({
      generatedAt: input.generatedAt,
      pendingReturnItems,
      semanticRebuild,
      autoEvolutionObserve,
      recoveryCandidates,
      returnConsumerPlan,
      returnDiagnosis,
      returnRepairDryRun,
      returnReconciliationApplyPlan,
      promotionCandidates,
      promoteGate,
    });
  const watchdogConditions = buildWatchdogConditions(
    mirrorObserve,
    autoEvolutionObserve,
    taskGraphItems,
    controlSignals,
    positionConfigAudit,
    positionConfigCleanupPlan,
    positionConfigCleanupGate,
    recoveryCandidates,
    returnConsumerPlan,
    returnDiagnosis,
    returnRepairDryRun,
    returnReconciliationGate,
    promotionCandidates,
    schedulerTickPlan,
    taskGraphReturnPreview,
    taskGraphReturnLinkDryRun,
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
    returnRepairDryRun,
    returnReconciliationGate,
    returnReconciliationApplyPlan,
    taskGraphs: {
      total: input.taskGraphItems?.length ?? 0,
      active: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus !== "completed")
        .length,
      blocked: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus === "blocked")
        .length,
      sourcePath: input.taskGraphSourcePath ?? "runtime/main/tmp/v2-task-graph-01/",
      items: taskGraphItems,
      returnPreview: taskGraphReturnPreview,
      returnLinkDryRun: taskGraphReturnLinkDryRun,
    },
    mirrorObserve,
    autoEvolutionObserve,
    semanticRebuild,
    controlSignals,
    positionConfigAudit,
    positionConfigCleanupPlan,
    positionConfigCleanupGate,
    recoveryCandidates,
    promotionCandidates,
    promoteGate,
    schedulerTickPlan,
    longmaV3,
    warnings,
  };
}
