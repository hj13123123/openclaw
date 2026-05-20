export type HudAgentStatus = "completed" | "running" | "failed" | "attention_required" | "unknown" | string;

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

export interface HudStateInput {
  generatedAt: string;
  positionStatesByAgentId?: Record<string, HudPositionState>;
  pendingReturnItems?: HudPendingReturnItem[];
  totalCaseFiles?: number;
  lastCaseAt?: string | null;
  taskGraphItems?: HudTaskGraphItem[];
  taskGraphSourcePath?: string;
  mirrorObserve?: HudMirrorObserveSummary;
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
  taskGraphs: {
    total: number;
    active: number;
    blocked: number;
    sourcePath: string;
    items: HudTaskGraphItem[];
  };
  mirrorObserve: HudMirrorObserveSummary;
  warnings: string[];
}

export const DEFAULT_HUD_AGENT_DEFAULTS: HudAgentDefault[] = [
  { agentId: "main", displayName: "main", role: "orchestrator" },
  { agentId: "engineering-executive", displayName: "Engineering Executive", role: "execution" },
  { agentId: "front-end-executive", displayName: "Front-End Executive", role: "execution" },
];

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstString(record: HudPositionState | undefined, names: Array<keyof HudPositionState>): string | null {
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

function firstNumber(record: HudPositionState | undefined, names: Array<keyof HudPositionState>): number | null {
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
  const agentIds = new Set<string>(defaults.map((item) => item.agentId));
  for (const agentId of Object.keys(statesByAgentId)) agentIds.add(agentId);
  const defaultsById = new Map(defaults.map((item) => [item.agentId, item]));

  return [...agentIds].map((agentId) => {
    const state = statesByAgentId[agentId];
    const defaultValue = defaultsById.get(agentId);
    const status = normalizeHudAgentStatus(firstString(state, ["status", "currentState", "state"]));
    return {
      agentId,
      displayName: defaultValue?.displayName ?? agentId,
      role: defaultValue?.role ?? "execution",
      status,
      currentTask: firstString(state, ["currentTask", "currentTaskId", "currentTicketId", "taskId"]),
      currentTaskTitle: firstString(state, ["currentTaskTitle", "currentTicketTitle", "taskTitle"]),
      progressPct: Math.max(0, Math.min(100, Math.floor(firstNumber(state, ["progressPct", "progress", "completionPct"]) ?? 0))),
      progressDerivation: state ? "position-state" : "unknown",
      hasAlerts: status === "failed" || status === "attention_required",
      lastProgressAt: firstString(state, ["lastProgressAt", "lastActivityAt", "last_activity_at", "updatedAt"]),
      lastCompletionAt: firstString(state, ["lastCompletionAt", "completedAt"]),
    };
  });
}

function numberFromRecord(record: Record<string, number> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function buildWatchdogConditions(mirrorObserve: HudMirrorObserveSummary): Record<string, number> {
  const byCondition: Record<string, number> = {};
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
  const violationCount = Object.entries(expectedConstraints)
    .filter(([key, expected]) => constraints[key] !== undefined && constraints[key] !== expected)
    .length;
  if (violationCount > 0) byCondition.mirrorObserveConstraintViolation = violationCount;
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
  const mirrorObserve = input.mirrorObserve ?? {
    available: false,
    reportPath: null,
    mirrorId: null,
    generatedAt: null,
    mode: null,
    stats: null,
    constraintsVerified: null,
    verdict: null,
  };
  const watchdogConditions = buildWatchdogConditions(mirrorObserve);
  const watchdogConditionAlertCount = Object.values(watchdogConditions).reduce((sum, count) => sum + count, 0);

  let globalStatus: HudState["globalStatus"]["status"] = "healthy";
  if (failedCount > 0 || pendingReturnItems.length > 0) {
    globalStatus = "attention_required";
  } else if (warnings.length > 0 || agentGroups.some((agent) => agent.status === "unknown")) {
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
    taskGraphs: {
      total: input.taskGraphItems?.length ?? 0,
      active: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus !== "completed").length,
      blocked: (input.taskGraphItems ?? []).filter((item) => item.aggregateStatus === "blocked").length,
      sourcePath: input.taskGraphSourcePath ?? "runtime/main/tmp/v2-task-graph-01/",
      items: taskGraphItems,
    },
    mirrorObserve,
    warnings,
  };
}
