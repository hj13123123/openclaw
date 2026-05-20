import type { TaskGraphStatus } from "./task-graph.js";

export const SESSION_LIFECYCLE_STATES = [
  "hard_stop",
  "cancelled",
  "interrupted",
  "stalled",
  "paused",
  "reset_required",
  "recovered",
  "running",
  "active",
  "completed",
] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

export const SESSION_LIFECYCLE_PRIORITY: Record<SessionLifecycleState, number> = {
  hard_stop: 1,
  cancelled: 2,
  interrupted: 3,
  stalled: 4,
  paused: 5,
  reset_required: 6,
  recovered: 7,
  running: 8,
  active: 9,
  completed: 10,
};

export interface LifecycleTaskNode {
  graphId: string;
  nodeId: string;
  taskId: string;
  role: string;
  status: TaskGraphStatus | string;
  sessionKey: string | null;
  runId: string | null;
}

export interface LifecycleControlSignal {
  signalId: string;
  taskId?: string | null;
  targetRole?: string | null;
  action: string;
  status: string;
  createdAt?: string | null;
}

export interface LifecycleRecoveryDecision {
  candidateId: string;
  nodeId: string;
  action: string;
  status: string;
  targetState?: string | null;
}

export interface LifecycleLeaseState {
  leaseActive: boolean;
  lastProgressAt: string | null;
  lifecycleState?: "stalled" | "hard_stop" | null;
}

export interface LifecycleSessionSize {
  lines: number;
  bytesEstimate: number;
  thresholdExceeded: boolean;
}

export interface AmbiguousLifecycleSignal {
  signalId: string;
  taskId: string | null;
  targetRole: string | null;
  action: string;
  status: string;
  reason: string;
}

export interface SessionLifecycleDerivedFrom {
  taskGraph: {
    graphId: string;
    nodeId: string;
    taskId: string;
    nodeStatus: string;
  } | null;
  controlSignal: {
    signalId: string;
    taskId: string | null;
    action: string;
    status: string;
  } | null;
  recoveryDecision: {
    candidateId: string;
    action: string;
    status: string;
  } | null;
  leaseState: LifecycleLeaseState;
  sessionSize: LifecycleSessionSize;
}

export interface SessionLifecycleEntry {
  sessionKey: string;
  agentId: string;
  graphId: string;
  nodeId: string;
  taskId: string;
  lifecycleState: SessionLifecycleState;
  statePriority: number;
  stateChangedAt: string;
  derivedFrom: SessionLifecycleDerivedFrom;
  nextExpectedAction: string;
  recommendations: string[];
}

export interface SessionLifecycleSummary {
  totalSessions: number;
  byState: Partial<Record<SessionLifecycleState, number>>;
  alerts: string[];
  ambiguousSignals: AmbiguousLifecycleSignal[];
  leaseLevelStates: {
    stalled: "lease-level (R9)";
    hard_stop: "lease-level (R9)";
  };
}

export interface SessionLifecycleReport {
  lifecycleId: string;
  generatedAt: string;
  frozen: boolean;
  sessions: SessionLifecycleEntry[];
  summary: SessionLifecycleSummary;
}

export interface GenerateSessionLifecycleInput {
  taskGraphNodes: LifecycleTaskNode[];
  controlSignals?: LifecycleControlSignal[];
  recoveryDecisions?: LifecycleRecoveryDecision[];
  sessionSizesBySessionKey?: Record<string, LifecycleSessionSize>;
  leaseStatesBySessionKey?: Record<string, LifecycleLeaseState>;
  frozen?: boolean;
  generatedAt?: string;
  lifecycleId?: string;
  sessionKeyFilter?: string;
  includeDefaultSessions?: boolean;
}

interface SessionAccumulator {
  sessionKey: string;
  agentId: string;
  nodeId: string;
  graphId: string;
  taskId: string;
  nodeStatus: string;
  controlSignal: LifecycleControlSignal | null;
  recoveryDecision: LifecycleRecoveryDecision | null;
  leaseState: LifecycleLeaseState;
  sessionSize: LifecycleSessionSize;
}

const DEFAULT_SESSION_SIZE: LifecycleSessionSize = {
  lines: 0,
  bytesEstimate: 0,
  thresholdExceeded: false,
};

const DEFAULT_LEASE_STATE: LifecycleLeaseState = {
  leaseActive: true,
  lastProgressAt: null,
};

function normalizeTaskId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultSessionKey(role: string): string {
  return `agent:${role}:main`;
}

function addAmbiguousSignal(
  ambiguousSignals: AmbiguousLifecycleSignal[],
  signal: LifecycleControlSignal,
  reason: string,
): void {
  ambiguousSignals.push({
    signalId: signal.signalId,
    taskId: signal.taskId ?? null,
    targetRole: signal.targetRole ?? null,
    action: signal.action,
    status: signal.status,
    reason,
  });
}

function buildSessionMap(input: GenerateSessionLifecycleInput): Map<string, SessionAccumulator> {
  const sessions = new Map<string, SessionAccumulator>();

  for (const node of input.taskGraphNodes) {
    const sessionKey = node.sessionKey?.trim() || defaultSessionKey(node.role);
    const sessionMapKey = node.taskId
      ? `${sessionKey}|task:${node.taskId}|node:${node.nodeId}`
      : `${sessionKey}|node:${node.nodeId}`;
    if (sessions.has(sessionMapKey)) continue;

    sessions.set(sessionMapKey, {
      sessionKey,
      agentId: node.role,
      nodeId: node.nodeId,
      graphId: node.graphId,
      taskId: node.taskId,
      nodeStatus: node.status,
      controlSignal: null,
      recoveryDecision: null,
      leaseState: input.leaseStatesBySessionKey?.[sessionKey] ?? DEFAULT_LEASE_STATE,
      sessionSize: input.sessionSizesBySessionKey?.[sessionKey] ?? DEFAULT_SESSION_SIZE,
    });
  }

  if (sessions.size === 0 && input.includeDefaultSessions) {
    for (const role of ["engineering-executive", "front-end-executive"]) {
      const sessionKey = defaultSessionKey(role);
      sessions.set(sessionKey, {
        sessionKey,
        agentId: role,
        nodeId: "",
        graphId: "",
        taskId: "",
        nodeStatus: "",
        controlSignal: null,
        recoveryDecision: null,
        leaseState: input.leaseStatesBySessionKey?.[sessionKey] ?? DEFAULT_LEASE_STATE,
        sessionSize: input.sessionSizesBySessionKey?.[sessionKey] ?? DEFAULT_SESSION_SIZE,
      });
    }
  }

  if (!input.sessionKeyFilter) return sessions;

  return new Map([...sessions].filter(([, session]) => session.sessionKey === input.sessionKeyFilter));
}

function attachControlSignals(
  sessions: Map<string, SessionAccumulator>,
  controlSignals: readonly LifecycleControlSignal[],
): AmbiguousLifecycleSignal[] {
  const ambiguousSignals: AmbiguousLifecycleSignal[] = [];
  const signalsByTaskId = new Map<string, LifecycleControlSignal[]>();
  const sessionKeysByTaskId = new Map<string, string[]>();

  for (const signal of controlSignals) {
    const taskId = normalizeTaskId(signal.taskId);
    if (!taskId) {
      addAmbiguousSignal(ambiguousSignals, signal, "taskId missing, cannot match to specific task node");
      continue;
    }
    signalsByTaskId.set(taskId, [...(signalsByTaskId.get(taskId) ?? []), signal]);
  }

  for (const [sessionKey, session] of sessions) {
    const taskId = normalizeTaskId(session.taskId);
    if (!taskId) continue;
    sessionKeysByTaskId.set(taskId, [...(sessionKeysByTaskId.get(taskId) ?? []), sessionKey]);
  }

  for (const [taskId, matchingSignals] of signalsByTaskId) {
    const matchingSessionKeys = sessionKeysByTaskId.get(taskId) ?? [];
    let ambiguityReason = "";
    if (matchingSessionKeys.length === 0) {
      ambiguityReason = "taskId has no matching lifecycle task node";
    } else if (matchingSessionKeys.length > 1) {
      ambiguityReason = "taskId matches multiple lifecycle task nodes";
    } else if (matchingSignals.length > 1) {
      ambiguityReason = "multiple control signals share the same taskId";
    }

    if (ambiguityReason) {
      for (const signal of matchingSignals) addAmbiguousSignal(ambiguousSignals, signal, ambiguityReason);
      continue;
    }

    const targetSessionKey = matchingSessionKeys[0];
    const targetSession = targetSessionKey ? sessions.get(targetSessionKey) : undefined;
    if (!targetSession) {
      for (const signal of matchingSignals) {
        addAmbiguousSignal(ambiguousSignals, signal, "taskId match resolved to missing session record");
      }
      continue;
    }
    targetSession.controlSignal = matchingSignals[0] ?? null;
    sessions.set(targetSessionKey, targetSession);
  }

  return ambiguousSignals;
}

function attachRecoveryDecisions(
  sessions: Map<string, SessionAccumulator>,
  recoveryDecisions: readonly LifecycleRecoveryDecision[],
): void {
  for (const [sessionKey, session] of sessions) {
    const recoveryDecision = recoveryDecisions.find((decision) => (
      decision.nodeId === session.nodeId && decision.status === "applied"
    ));
    if (recoveryDecision) {
      sessions.set(sessionKey, { ...session, recoveryDecision });
    }
  }
}

function collectCandidateStates(session: SessionAccumulator): SessionLifecycleState[] {
  const candidateStates: SessionLifecycleState[] = [];

  if (session.nodeStatus === "running") candidateStates.push("running");
  if (session.nodeStatus === "dispatched" || session.nodeStatus === "ready") candidateStates.push("active");
  if (session.nodeStatus === "completed") candidateStates.push("completed");

  const signal = session.controlSignal;
  if (signal?.action === "pause" && signal.status === "acknowledged") candidateStates.push("paused");
  if (signal?.action === "cancel" && signal.status === "executed") candidateStates.push("cancelled");
  if (signal?.action === "interrupt" && signal.status === "acknowledged") candidateStates.push("interrupted");

  if (session.recoveryDecision) candidateStates.push("recovered");
  if (session.leaseState.lifecycleState === "stalled") candidateStates.push("stalled");
  if (session.leaseState.lifecycleState === "hard_stop") candidateStates.push("hard_stop");
  if (session.sessionSize.thresholdExceeded) candidateStates.push("reset_required");

  return candidateStates;
}

function pickLifecycleState(candidateStates: readonly SessionLifecycleState[]): {
  state: SessionLifecycleState;
  priority: number;
} {
  let state: SessionLifecycleState = "active";
  let priority = SESSION_LIFECYCLE_PRIORITY[state];

  for (const candidateState of candidateStates) {
    const candidatePriority = SESSION_LIFECYCLE_PRIORITY[candidateState];
    if (candidatePriority < priority) {
      state = candidateState;
      priority = candidatePriority;
    }
  }

  return { state, priority };
}

function nextExpectedAction(state: SessionLifecycleState): string {
  switch (state) {
    case "paused": return "resume or cancel";
    case "stalled": return "human gate review";
    case "hard_stop": return "human gate review";
    case "cancelled": return "archive or re-dispatch";
    case "interrupted": return "resume or skip";
    case "reset_required": return "/new session recommended";
    case "recovered": return "continue or verify";
    case "active": return "monitor progress";
    case "running": return "monitor progress";
    case "completed": return "archive";
  }
}

function toLifecycleEntry(session: SessionAccumulator, generatedAt: string): SessionLifecycleEntry {
  const { state, priority } = pickLifecycleState(collectCandidateStates(session));

  return {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    graphId: session.graphId,
    nodeId: session.nodeId,
    taskId: session.taskId,
    lifecycleState: state,
    statePriority: priority,
    stateChangedAt: generatedAt,
    derivedFrom: {
      taskGraph: session.graphId
        ? {
            graphId: session.graphId,
            nodeId: session.nodeId,
            taskId: session.taskId,
            nodeStatus: session.nodeStatus,
          }
        : null,
      controlSignal: session.controlSignal
        ? {
            signalId: session.controlSignal.signalId,
            taskId: session.controlSignal.taskId ?? null,
            action: session.controlSignal.action,
            status: session.controlSignal.status,
          }
        : null,
      recoveryDecision: session.recoveryDecision
        ? {
            candidateId: session.recoveryDecision.candidateId,
            action: session.recoveryDecision.action,
            status: session.recoveryDecision.status,
          }
        : null,
      leaseState: session.leaseState,
      sessionSize: session.sessionSize,
    },
    nextExpectedAction: nextExpectedAction(state),
    recommendations: [],
  };
}

function summarizeLifecycle(
  sessions: readonly SessionLifecycleEntry[],
  ambiguousSignals: AmbiguousLifecycleSignal[],
): SessionLifecycleSummary {
  const byState: Partial<Record<SessionLifecycleState, number>> = {};
  const alerts: string[] = [];

  for (const session of sessions) {
    byState[session.lifecycleState] = (byState[session.lifecycleState] ?? 0) + 1;
    if (["paused", "stalled", "interrupted", "reset_required"].includes(session.lifecycleState)) {
      alerts.push(`${session.agentId}: ${session.lifecycleState}`);
    }
  }

  return {
    totalSessions: sessions.length,
    byState,
    alerts,
    ambiguousSignals,
    leaseLevelStates: {
      stalled: "lease-level (R9)",
      hard_stop: "lease-level (R9)",
    },
  };
}

export function generateSessionLifecycleReport(input: GenerateSessionLifecycleInput): SessionLifecycleReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sessions = buildSessionMap(input);
  const ambiguousSignals = attachControlSignals(sessions, input.controlSignals ?? []);
  attachRecoveryDecisions(sessions, input.recoveryDecisions ?? []);

  const lifecycleSessions = [...sessions.values()].map((session) => toLifecycleEntry(session, generatedAt));

  return {
    lifecycleId: input.lifecycleId ?? `slc-${generatedAt.replace(/[-:.TZ]/gu, "").slice(0, 14)}`,
    generatedAt,
    frozen: input.frozen ?? false,
    sessions: lifecycleSessions,
    summary: summarizeLifecycle(lifecycleSessions, ambiguousSignals),
  };
}
