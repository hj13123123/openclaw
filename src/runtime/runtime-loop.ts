import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_LANE_NESTED } from "../agents/lanes.js";
import { callGateway } from "../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { createRuntimeEvent, emitEvent, type RuntimeEvent } from "./event-bus.js";
import { evaluatePolicyForTask, loadPolicyRules, type RiskLevel } from "./policy-engine.js";
import { scanReturnInbox } from "./returns/return-inbox.js";
import { getTaskState, type TaskRecord, type TaskStatus, type TaskSummary } from "./task-state-machine.js";

const RUNTIME_LOOP_STATE_REL = "runtime/main/tmp/runtime-loop-state.json";
const SCHEDULER_STATE_REL = "runtime/main/tmp/task-scheduler-state.json";
const SCHEDULER_POLICY_REL = "runtime/scheduler/scheduler-policy.json";
const POLICY_RULES_REL = "runtime/policy/policy-rules.json";
type SchedulerSnapshot = {
  enabled: boolean;
  mode: "observe" | "apply" | string;
  status: string;
  intervalMs: number | null;
  maxTicks: number | null;
  policyPath: string | null;
  policyWarnings: string[];
  schedulerPolicy: SchedulerPolicyLite;
};

type SchedulerPolicyLite = {
  runtimeLoopMode: "observe";
  maxDispatchesPerTick: number;
  disableOldTrigger: boolean;
  enableContinuousApply: boolean;
};

export type DispatchPlanEntry = {
  taskId: string;
  dispatchTarget: string;
  policyDecision: string;
  riskLevel: string;
  would_dispatch: boolean;
  blocked_reason?: string;
};

export type ReturnPlanEntry = {
  file: string;
  would_process: boolean;
  blocked_reason: string;
};

export type ReturnProcessorState = {
  inbox_count: number;
  would_process: number;
  would_auto_close_L0: number;
  entries: ReturnPlanEntry[];
};

export type EventEmitPlan = {
  eventType: string;
  source: string;
  payload: Record<string, unknown>;
};

export type RuntimeLoopState = {
  tickId: string;
  tick_at: string;
  mode: "observe";
  scheduler: SchedulerSnapshot;
  tasks: TaskSummary & {
    dispatch_candidates: number;
  };
  dispatch_plan: DispatchPlanEntry[];
  return_processor: ReturnProcessorState;
  events: EventEmitPlan[];
  warnings: string[];
};

function statePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, RUNTIME_LOOP_STATE_REL);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readSchedulerPolicy(workspaceRoot: string): SchedulerPolicyLite {
  const policyRules = readJsonObject(path.join(workspaceRoot, POLICY_RULES_REL));
  const embedded = policyRules?.schedulerPolicy;
  const policy = embedded && typeof embedded === "object" && !Array.isArray(embedded) ? embedded as Record<string, unknown> : readJsonObject(path.join(workspaceRoot, SCHEDULER_POLICY_REL));
  return {
    runtimeLoopMode: "observe",
    maxDispatchesPerTick: typeof policy?.maxDispatchesPerTick === "number" ? Math.max(0, Math.floor(policy.maxDispatchesPerTick)) : 0,
    disableOldTrigger: typeof policy?.disableOldTrigger === "boolean" ? policy.disableOldTrigger : true,
    enableContinuousApply: typeof policy?.enableContinuousApply === "boolean" ? policy.enableContinuousApply : false,
  };
}

function readSchedulerSnapshot(workspaceRoot: string): SchedulerSnapshot {
  const state = readJsonObject(path.join(workspaceRoot, SCHEDULER_STATE_REL));
  const policyWarnings = Array.isArray(state?.policyWarnings) ? state.policyWarnings.filter((item): item is string => typeof item === "string") : [];
  return {
    enabled: state?.enabled === true,
    mode: typeof state?.mode === "string" ? state.mode : "observe",
    status: typeof state?.status === "string" ? state.status : "disabled",
    intervalMs: typeof state?.intervalMs === "number" ? state.intervalMs : null,
    maxTicks: typeof state?.maxTicks === "number" ? state.maxTicks : null,
    policyPath: typeof state?.policyPath === "string" ? state.policyPath : null,
    policyWarnings,
    schedulerPolicy: readSchedulerPolicy(workspaceRoot),
  };
}

function buildDispatchPlan(workspaceRoot: string, tasks: TaskRecord[], maxDispatchesPerTick: number): DispatchPlanEntry[] {
  const rules = loadPolicyRules(workspaceRoot);
  return tasks
    .filter((task) => task.status === "queued")
    .slice(0, 50)
    .map((task) => {
      const decision = task.policyDecision ?? evaluatePolicyForTask(task, rules);
      const riskLevel = decision.riskLevel as RiskLevel;
      const eligible = decision.action === "auto_close" && riskLevel === "L0" && maxDispatchesPerTick > 0;
      return {
        taskId: task.taskId,
        dispatchTarget: typeof task.metadata.dispatchTarget === "string" ? task.metadata.dispatchTarget : "/main",
        policyDecision: decision.action,
        riskLevel,
        would_dispatch: false,
        blocked_reason: eligible ? "observe_only_runtime_loop" : `policy_action_${decision.action}`,
      };
    });
}

function buildReturnProcessorState(workspaceRoot: string): ReturnProcessorState {
  const scan = scanReturnInbox(workspaceRoot, { limit: 50 });
  return {
    inbox_count: scan.pendingCount,
    would_process: 0,
    would_auto_close_L0: 0,
    entries: scan.pendingItems.map((item) => ({
      file: item.returnId,
      would_process: false,
      blocked_reason: "observe_only_runtime_loop",
    })),
  };
}

function emitRuntimeLoopEvent(workspaceRoot: string, eventType: string, payload: Record<string, unknown>): RuntimeEvent {
  const event = createRuntimeEvent(eventType, payload, "gateway-runtime-loop");
  emitEvent(workspaceRoot, event);
  return event;
}

export function tick(workspaceRoot: string): RuntimeLoopState {
  const tickAt = new Date().toISOString();
  const tickId = `tick-${tickAt.replace(/[-:.]/gu, "").replace(/\d{3}Z$/u, "Z")}`;
  const events: EventEmitPlan[] = [];
  const started = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_tick_started", { tickId, mode: "observe" });
  events.push({ eventType: started.eventType, source: started.source, payload: started.payload });

  try {
    const scheduler = readSchedulerSnapshot(workspaceRoot);
    const taskState = getTaskState(workspaceRoot);
    const dispatchPlan = buildDispatchPlan(workspaceRoot, taskState.tasks, scheduler.schedulerPolicy.maxDispatchesPerTick);
    const returnProcessor = buildReturnProcessorState(workspaceRoot);
    const warnings: string[] = [];
    if (scheduler.enabled) warnings.push("scheduler marker is enabled, runtime loop remains observe-only");
    if (scheduler.schedulerPolicy.maxDispatchesPerTick !== 0) warnings.push("schedulerPolicy.maxDispatchesPerTick is non-zero, dispatch still suppressed by observe-only loop");
    const state: RuntimeLoopState = {
      tickId,
      tick_at: tickAt,
      mode: "observe",
      scheduler,
      tasks: {
        ...taskState.summary,
        dispatch_candidates: dispatchPlan.length,
      },
      dispatch_plan: dispatchPlan,
      return_processor: returnProcessor,
      events,
      warnings,
    };

    const outputPath = statePath(workspaceRoot);
    const outputDir = path.dirname(outputPath);
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");

    const completed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_tick_completed", {
      tickId,
      mode: state.mode,
      totalTasks: state.tasks.total,
      dispatchPlanCount: state.dispatch_plan.length,
      inboxCount: state.return_processor.inbox_count,
      warnings: state.warnings,
    });
    state.events.push({ eventType: completed.eventType, source: completed.source, payload: completed.payload });
    writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
    return state;
  } catch (error) {
    const failed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_tick_failed", {
      tickId,
      mode: "observe",
      error: error instanceof Error ? error.message : String(error),
    });
    events.push({ eventType: failed.eventType, source: failed.source, payload: failed.payload });
    throw error;
  }
}

export function readLatestRuntimeLoopState(workspaceRoot: string): RuntimeLoopState | null {
  const parsed = readJsonObject(statePath(workspaceRoot));
  return parsed as RuntimeLoopState | null;
}

// ---- P1-BATCH10 Phase C: Apply Smoke types ----

export type ApplySmokeDispatchRequest = {
  requestId: string;
  runId: string;
  idempotencyKey: string;
  generatedAt: string;
  mode: "dispatch_request_dry_run";
  phase: string;
  dryRun: boolean;
  validationOnly: true;
  spawnSuppressed: boolean;
  taskId: string;
  targetRole: string;
  riskLevel: string;
  policyAction: string;
  payload: {
    task: string;
    dispatchTarget: string;
    agentId: string;
    model: string;
    timeoutSeconds: number;
    interruptBeforeDispatch: true;
    autoDispatch: false;
    requiresHumanGate: false;
  };
  constraints: {
    forbiddenActions: string[];
    forbiddenTasks: string[];
    allowedActions: string[];
    maxDurationMinutes: number;
    noSpawn: boolean;
    noRealDispatch: boolean;
  };
  returnSink: string;
  returnSchema: string;
  audit: {
    dispatchRequested: true;
    sessionsSpawnCalled: false;
    realDispatchExecuted: false;
    dryRun: boolean;
    spawnSuppressed: boolean;
    dispatchTimestamp: string;
  };
};

export type ApplySmokeState = RuntimeLoopState & {
  phase: string;
  selectedTask: string | null;
  wouldDispatch: boolean;
  dispatchRequestPath: string | null;
  spawnEnabled: boolean;
  spawnSuppressed: boolean;
  sessionsSpawnAccepted: boolean;
  spawnApiBoundaryBlocked: boolean;
  blockReason: string | null;
  sessionId: string | null;
  sessionKey: string | null;
  runId: string | null;
  targetRole: string | null;
  dispatchTarget: string | null;
};

const APPLY_SMOKE_MARKER_REL = "runtime/main/tmp/runtime-loop-apply-smoke-marker.json";
const DISPATCH_REQUEST_DIR_REL = "runtime/dispatch";
const GATEWAY_UNAVAILABLE = "GATEWAY_UNAVAILABLE";
const CALL_GATEWAY_FAILED = "CALL_GATEWAY_FAILED";
const CALL_GATEWAY_TIMEOUT = "CALL_GATEWAY_TIMEOUT";
const configuredGatewayRpcTimeoutMs = Number.parseInt(process.env.OPENCLAW_GATEWAY_RPC_TIMEOUT_MS ?? "15000", 10);
const GATEWAY_RPC_TIMEOUT_MS = Number.isFinite(configuredGatewayRpcTimeoutMs) && configuredGatewayRpcTimeoutMs > 0
  ? configuredGatewayRpcTimeoutMs
  : 15_000;


function readApplySmokeMarker(workspaceRoot: string): {
  phase: string;
  maxDispatches: number;
  spawnEnabled: boolean;
  mockTask: boolean;
  idempotencyKey: string;
  runId: string;
} | null {
  const markerPath = path.join(workspaceRoot, APPLY_SMOKE_MARKER_REL);
  if (!existsSync(markerPath)) return null;
  try {
    const m = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    // Already consumed → no-op
    if (m.consumed === true) return null;
    const idempotencyKey = typeof m.idempotencyKey === "string" && m.idempotencyKey.trim().length > 0 ? m.idempotencyKey : randomUUID();
    const runId = typeof m.runId === "string" && m.runId.trim().length > 0 ? m.runId : randomUUID();
    return {
      phase: typeof m.phase === "string" ? m.phase : "P1-BATCH10-PhaseC",
      maxDispatches: typeof m.maxDispatches === "number" ? Math.min(1, Math.max(0, Math.floor(m.maxDispatches))) : 1,
      spawnEnabled: m.spawnEnabled === true,
      mockTask: m.mockTask !== false,
      idempotencyKey,
      runId,
    };
  } catch {
    return null;
  }
}

function consumeApplySmokeMarker(workspaceRoot: string): void {
  const markerPath = path.join(workspaceRoot, APPLY_SMOKE_MARKER_REL);
  try {
    const dir = path.dirname(markerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({
      consumed: true,
      consumedAt: new Date().toISOString(),
      note: "apply smoke marker consumed after successful smoke run",
    }, null, 2) + "\n", "utf8");
  } catch {
    // fail soft — marker consumption is best-effort
  }
}

function findSmokeTask(workspaceRoot: string): {
  taskId: string;
  summary: string;
  targetRole: string;
  riskLevel: string;
  policyAction: string;
  dispatchTarget: string;
  agentId: string;
  model: string;
} {
  // Find a real queued task that's not EP-8/EP-9/A1
  const taskState = getTaskState(workspaceRoot);
  const candidate = taskState.tasks.find(
    (task) =>
      task.status === "queued" &&
      !/^(EP-8|EP-9|A1.*)$/u.test(task.taskId),
  );

  if (candidate) {
    const dispatchTarget =
      typeof candidate.metadata.dispatchTarget === "string"
        ? candidate.metadata.dispatchTarget
        : "/main";
    const agentId =
      typeof candidate.metadata.agentId === "string"
        ? candidate.metadata.agentId
        : typeof candidate.sourceRole === "string"
          ? candidate.sourceRole
          : "engineering-executive";
    const model =
      typeof candidate.metadata.model === "string"
        ? candidate.metadata.model
        : "openai-codex/gpt-5.5";
    return {
      taskId: candidate.taskId,
      summary:
        typeof candidate.summary === "string" && candidate.summary.trim()
          ? candidate.summary
          : `Apply smoke validation task: ${candidate.taskId}`,
      targetRole: typeof candidate.sourceRole === "string" ? candidate.sourceRole : "engineering-executive",
      riskLevel: "L0",
      policyAction: "auto_close",
      dispatchTarget,
      agentId,
      model,
    };
  }

  // Fallback: generate a mock validation-only task
  return {
    taskId: "P1-BATCH10-SMOKE-TASK-001",
    summary: "runtime-loop apply smoke validation task (mock, validationOnly, noSpawn)",
    targetRole: "engineering-executive",
    riskLevel: "L0",
    policyAction: "auto_close",
    dispatchTarget: "/main",
    agentId: "engineering-executive",
    model: "openai-codex/gpt-5.5",
  };
}

function appendSmokeTaskRecord(
  workspaceRoot: string,
  task: ReturnType<typeof findSmokeTask>,
  status: TaskStatus,
  metadata: Record<string, unknown>,
  createdAt?: string,
): void {
  const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
  const tasksDir = path.dirname(tasksPath);
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const record: TaskRecord = {
    taskId: task.taskId,
    status,
    sourceRole: "system",
    createdAt: createdAt ?? timestamp,
    updatedAt: timestamp,
    summary: task.summary,
    metadata: {
      validationOnly: true,
      riskLevel: task.riskLevel,
      policyAction: task.policyAction,
      targetRole: task.targetRole,
      source: "tickApplySmoke",
      ...metadata,
    },
  };
  appendFileSync(tasksPath, `${JSON.stringify(record)}\n`, "utf8");
}

function registerSmokeTask(workspaceRoot: string, task: ReturnType<typeof findSmokeTask>, marker: { phase: string; spawnEnabled: boolean; idempotencyKey: string; runId: string }): boolean {
  const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
  const tasksDir = path.dirname(tasksPath);
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });

  const existing = getTaskState(workspaceRoot);
  const existingTask = existing.tasks.find((candidate) => candidate.taskId === task.taskId);

  if (existingTask) {
    const nonTerminal: TaskStatus[] = ["queued", "dispatched", "running", "return_received", "processing_return"];
    const sameRun = existingTask.metadata?.idempotencyKey === marker.idempotencyKey || existingTask.metadata?.runId === marker.runId;
    if (sameRun && nonTerminal.includes(existingTask.status)) {
      emitRuntimeLoopEvent(workspaceRoot, "smoke_task_registration_skipped", {
        taskId: task.taskId,
        reason: "duplicate_non_terminal",
        existingStatus: existingTask.status,
        phase: marker.phase,
        runId: marker.runId,
        idempotencyKey: marker.idempotencyKey,
      });
      return false;
    }
  }

  appendSmokeTaskRecord(workspaceRoot, task, "queued", {
    phase: marker.phase,
    spawnEnabled: marker.spawnEnabled,
    runId: marker.runId,
    idempotencyKey: marker.idempotencyKey,
    ...(existingTask ? { newRun: true, previousStatus: existingTask.status } : {}),
  });

  emitRuntimeLoopEvent(workspaceRoot, "smoke_task_registered", {
    taskId: task.taskId,
    status: "queued",
    phase: marker.phase,
    runId: marker.runId,
    idempotencyKey: marker.idempotencyKey,
    newRun: existingTask ? true : false,
    previousStatus: existingTask ? existingTask.status : null,
  });

  return true;
}

function generateDispatchRequestDryRun(
  workspaceRoot: string,
  task: ReturnType<typeof findSmokeTask>,
  phase: string,
  options: { spawnEnabled?: boolean; idempotencyKey?: string; runId?: string } = {},
): { requestId: string; requestPath: string; request: ApplySmokeDispatchRequest } {
  const requestId = randomUUID();
  const runId = options.runId ?? randomUUID();
  const generatedAt = new Date().toISOString();
  const requestDir = path.join(workspaceRoot, DISPATCH_REQUEST_DIR_REL);
  if (!existsSync(requestDir)) mkdirSync(requestDir, { recursive: true });

  const request: ApplySmokeDispatchRequest = {
    requestId,
    runId,
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    generatedAt,
    mode: "dispatch_request_dry_run",
    phase,
    dryRun: true,
    validationOnly: true,
    spawnSuppressed: options.spawnEnabled === true ? false : true,
    taskId: task.taskId,
    targetRole: task.targetRole,
    riskLevel: task.riskLevel,
    policyAction: task.policyAction,
    payload: {
      task: task.summary,
      dispatchTarget: task.dispatchTarget,
      agentId: task.agentId,
      model: task.model,
      timeoutSeconds: 600,
      interruptBeforeDispatch: true,
      autoDispatch: false,
      requiresHumanGate: false,
    },
    constraints: {
      forbiddenActions: [
        "edit SRC",
        "write SRC",
        "exec_build",
        "exec_restart",
        "config_patch",
        "config_apply",
        "gateway_restart",
        "sessions_spawn",
        "real dispatch EE",
        "real dispatch FE",
      ],
      forbiddenTasks: ["EP-8", "EP-9", "A1"],
      allowedActions: ["read", "exec_readonly"],
      maxDurationMinutes: 10,
      noSpawn: options.spawnEnabled === true ? false : true,
      noRealDispatch: options.spawnEnabled === true ? false : true,
    },
    returnSink: "system/returns/inbox/",
    returnSchema: "ROLE_RETURN_PACKAGE_V1",
    audit: {
      dispatchRequested: true,
      sessionsSpawnCalled: false,
      realDispatchExecuted: false,
      dryRun: options.spawnEnabled === true ? false : true,
      spawnSuppressed: options.spawnEnabled === true ? false : true,
      dispatchTimestamp: generatedAt,
    },
  };

  const fileName = `dispatch-request-smoke-${phase.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;
  const requestPath = path.join(requestDir, fileName);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  return { requestId, requestPath, request };
}

export async function tickApplySmoke(workspaceRoot: string): Promise<ApplySmokeState | null> {
  const marker = readApplySmokeMarker(workspaceRoot);
  if (!marker) return null;

  const tickAt = new Date().toISOString();
  const tickId = `smoke-${tickAt.replace(/[-:.]/gu, "").replace(/\d{3}Z$/u, "Z")}`;
  const events: EventEmitPlan[] = [];

  // Emit smoke started event
  const started = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_started", {
    tickId,
    phase: marker.phase,
    maxDispatches: marker.maxDispatches,
    spawnEnabled: marker.spawnEnabled,
    mockTask: marker.mockTask,
  });
  events.push({ eventType: started.eventType, source: started.source, payload: started.payload });

  try {
    const scheduler = readSchedulerSnapshot(workspaceRoot);
    const taskState = getTaskState(workspaceRoot);
    const dispatchPlan = buildDispatchPlan(workspaceRoot, taskState.tasks, marker.maxDispatches);
    const returnProcessor = buildReturnProcessorState(workspaceRoot);

    // Select task
    const task = findSmokeTask(workspaceRoot);
    const registeredTask = registerSmokeTask(workspaceRoot, task, marker);

    // Generate dispatch request dry-run
    const { requestId, requestPath, request: dispatchRequest } = generateDispatchRequestDryRun(
      workspaceRoot,
      task,
      marker.phase,
      { spawnEnabled: marker.spawnEnabled, idempotencyKey: marker.idempotencyKey, runId: marker.runId },
    );
    if (registeredTask) {
      appendSmokeTaskRecord(workspaceRoot, task, "queued", {
        phase: marker.phase,
        spawnEnabled: marker.spawnEnabled,
        requestId,
        runId: dispatchRequest.runId,
        idempotencyKey: dispatchRequest.idempotencyKey,
        requestPath,
      });
    }

    // Emit dispatch request planned event
    const planned = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_dispatch_request_planned", {
      tickId,
      phase: marker.phase,
      taskId: task.taskId,
      targetRole: task.targetRole,
      requestId,
      requestPath,
      runId: dispatchRequest.runId,
      idempotencyKey: dispatchRequest.idempotencyKey,
      spawnSuppressed: marker.spawnEnabled ? false : true,
      wouldDispatch: true,
      riskLevel: task.riskLevel,
      policyAction: task.policyAction,
    });
    events.push({ eventType: planned.eventType, source: planned.source, payload: planned.payload });

    const warnings: string[] = [];
    if (!marker.spawnEnabled) warnings.push("apply_smoke: spawn suppressed (spawnEnabled=false)");

    if (marker.spawnEnabled) {
      const targetSessionKey = `agent:${task.targetRole}:smoke-${dispatchRequest.runId}`;
      const taskDescription = task.summary || JSON.stringify(dispatchRequest.payload.task);
      const returnId = `${task.taskId}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
      const dispatchMessage = `## Runtime Smoke Validation Task

Task: ${taskDescription}
Task ID: ${task.taskId}
Phase: ${marker.phase}
Return Sink: ${path.join(workspaceRoot, "system", "returns", "inbox")}

### Required Output

After completing this task, you MUST output a structured ROLE_RETURN_PACKAGE in the following format at the end of your response:

\`\`\`json
ROLE_RETURN_PACKAGE_START
{
  "returnPackageVersion": "v1",
  "returnId": "${returnId}",
  "taskId": "${task.taskId}",
  "runId": "${dispatchRequest.runId}",
  "idempotencyKey": "${dispatchRequest.idempotencyKey}",
  "phase": "${marker.phase}",
  "role": "engineering-executive",
  "status": "completed",
  "summary": "Read-only validation smoke: [brief summary]",
  "filesChanged": [],
  "buildRequired": false,
  "restartRequired": false
}
ROLE_RETURN_PACKAGE_END
\`\`\`

Required fields: returnPackageVersion, returnId, taskId, runId, phase, role, status, summary, filesChanged, buildRequired, restartRequired.
This return will be saved to system/returns/inbox/ by the system for automatic processing.
`;
      const outputPath = statePath(workspaceRoot);
      const outputDir = path.dirname(outputPath);
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

      try {
        const response = await callGateway<Record<string, unknown>>({
          method: "agent",
          params: {
            message: dispatchMessage,
            sessionKey: targetSessionKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            idempotencyKey: dispatchRequest.idempotencyKey,
            extraSystemPrompt: "[runtime-loop dispatch] 来自 runtime 自动派发的岗位任务",
          } as Record<string, unknown>,
          timeoutMs: GATEWAY_RPC_TIMEOUT_MS,
        });
        const dispatchedRunId = response && typeof response === "object" && "runId" in response
          ? String(response.runId)
          : null;

        if (registeredTask) {
          appendSmokeTaskRecord(workspaceRoot, task, "dispatched", {
            phase: marker.phase,
            spawnEnabled: true,
            requestId,
            runId: dispatchRequest.runId,
            gatewayRunId: dispatchedRunId,
            idempotencyKey: dispatchRequest.idempotencyKey,
            requestPath,
            sessionKey: targetSessionKey,
          });
          appendSmokeTaskRecord(workspaceRoot, task, "running", {
            phase: marker.phase,
            spawnEnabled: true,
            requestId,
            runId: dispatchRequest.runId,
            gatewayRunId: dispatchedRunId,
            idempotencyKey: dispatchRequest.idempotencyKey,
            requestPath,
            sessionKey: targetSessionKey,
          });
        }
        const executed = emitRuntimeLoopEvent(workspaceRoot, "task_dispatch_executed", {
          tickId,
          phase: marker.phase,
          taskId: task.taskId,
          requestId,
          runId: dispatchRequest.runId,
          gatewayRunId: dispatchedRunId,
          idempotencyKey: dispatchRequest.idempotencyKey,
          sessionKey: targetSessionKey,
        });
        events.push({ eventType: executed.eventType, source: executed.source, payload: executed.payload });

        const dispatched = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_dispatched", {
          tickId,
          phase: marker.phase,
          selectedTask: task.taskId,
          requestId,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: true,
          sessionKey: targetSessionKey,
          runId: dispatchRequest.runId,
          gatewayRunId: dispatchedRunId,
          idempotencyKey: dispatchRequest.idempotencyKey,
          targetRole: task.targetRole,
          dispatchTarget: task.dispatchTarget,
        });
        events.push({ eventType: dispatched.eventType, source: dispatched.source, payload: dispatched.payload });

        const state: ApplySmokeState = {
          tickId,
          tick_at: tickAt,
          mode: "observe",
          phase: marker.phase,
          selectedTask: task.taskId,
          wouldDispatch: true,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: true,
          spawnApiBoundaryBlocked: false,
          blockReason: null,
          sessionId: dispatchedRunId,
          sessionKey: targetSessionKey,
          runId: dispatchRequest.runId,
          targetRole: task.targetRole,
          dispatchTarget: task.dispatchTarget,
          scheduler,
          tasks: {
            ...taskState.summary,
            dispatch_candidates: dispatchPlan.length,
          },
          dispatch_plan: dispatchPlan,
          return_processor: returnProcessor,
          events,
          warnings,
        };

        writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");

        const completed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_completed", {
          tickId,
          phase: marker.phase,
          selectedTask: task.taskId,
          wouldDispatch: true,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: true,
          spawnApiBoundaryBlocked: false,
          blockReason: null,
          sessionKey: targetSessionKey,
          runId: dispatchRequest.runId,
          gatewayRunId: dispatchedRunId,
          idempotencyKey: dispatchRequest.idempotencyKey,
          dispatchPlanCount: dispatchPlan.length,
          inboxCount: returnProcessor.inbox_count,
          warnings: state.warnings,
        });
        state.events.push({ eventType: completed.eventType, source: completed.source, payload: completed.payload });
        writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
        consumeApplySmokeMarker(workspaceRoot);
        return state;
      } catch (gatewayError) {
        const errorMessage = gatewayError instanceof Error ? gatewayError.message : String(gatewayError);
        const blockCode = /gateway timeout|timeout after|AbortError|ETIMEDOUT/iu.test(errorMessage)
          ? CALL_GATEWAY_TIMEOUT
          : /ECONNREFUSED|not connected|gateway unavailable/iu.test(errorMessage)
            ? GATEWAY_UNAVAILABLE
            : CALL_GATEWAY_FAILED;
        const reason = blockCode === CALL_GATEWAY_TIMEOUT ? "rpc_timeout" : "gateway_dispatch_failed";
        const blockReason = `${blockCode}: ${errorMessage}`;
        warnings.push(`apply_smoke: gateway dispatch failed (${blockCode}): ${errorMessage}`);

        if (registeredTask) {
          appendSmokeTaskRecord(workspaceRoot, task, "failed", {
            phase: marker.phase,
            spawnEnabled: true,
            requestId,
            runId: dispatchRequest.runId,
            idempotencyKey: dispatchRequest.idempotencyKey,
            requestPath,
            sessionKey: targetSessionKey,
            error: errorMessage,
            blockCode,
            reason,
            gatewayRpcTimeoutMs: GATEWAY_RPC_TIMEOUT_MS,
          });
        }
        const dispatchFailed = emitRuntimeLoopEvent(workspaceRoot, "task_dispatch_failed", {
          tickId,
          phase: marker.phase,
          taskId: task.taskId,
          requestId,
          runId: dispatchRequest.runId,
          error: errorMessage,
          blockCode,
          reason,
          idempotencyKey: dispatchRequest.idempotencyKey,
          gatewayRpcTimeoutMs: GATEWAY_RPC_TIMEOUT_MS,
        });
        events.push({ eventType: dispatchFailed.eventType, source: dispatchFailed.source, payload: dispatchFailed.payload });

        const blocked = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_blocked", {
          tickId,
          phase: marker.phase,
          selectedTask: task.taskId,
          requestId,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: false,
          blockReason,
          reason,
          runId: dispatchRequest.runId,
          idempotencyKey: dispatchRequest.idempotencyKey,
          gatewayRpcTimeoutMs: GATEWAY_RPC_TIMEOUT_MS,
        });
        events.push({ eventType: blocked.eventType, source: blocked.source, payload: blocked.payload });

        const state: ApplySmokeState = {
          tickId,
          tick_at: tickAt,
          mode: "observe",
          phase: marker.phase,
          selectedTask: task.taskId,
          wouldDispatch: true,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: false,
          spawnApiBoundaryBlocked: true,
          blockReason,
          sessionId: null,
          sessionKey: targetSessionKey,
          runId: dispatchRequest.runId,
          targetRole: task.targetRole,
          dispatchTarget: task.dispatchTarget,
          scheduler,
          tasks: {
            ...taskState.summary,
            dispatch_candidates: dispatchPlan.length,
          },
          dispatch_plan: dispatchPlan,
          return_processor: returnProcessor,
          events,
          warnings,
        };

        writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");

        const completed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_completed", {
          tickId,
          phase: marker.phase,
          selectedTask: task.taskId,
          wouldDispatch: true,
          dispatchRequestPath: requestPath,
          spawnEnabled: true,
          spawnSuppressed: false,
          sessionsSpawnAccepted: false,
          spawnApiBoundaryBlocked: true,
          blockReason,
          sessionKey: targetSessionKey,
          runId: dispatchRequest.runId,
          dispatchPlanCount: dispatchPlan.length,
          inboxCount: returnProcessor.inbox_count,
          warnings: state.warnings,
        });
        state.events.push({ eventType: completed.eventType, source: completed.source, payload: completed.payload });
        writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
        consumeApplySmokeMarker(workspaceRoot);
        return state;
      }
    }

    warnings.push("apply_smoke: dispatch request dry-run only, no real sessions_spawn");

    const state: ApplySmokeState = {
      tickId,
      tick_at: tickAt,
      mode: "observe",
      phase: marker.phase,
      selectedTask: task.taskId,
      wouldDispatch: true,
      dispatchRequestPath: requestPath,
      spawnEnabled: false,
      spawnSuppressed: true,
      sessionsSpawnAccepted: false,
      spawnApiBoundaryBlocked: false,
      blockReason: null,
      sessionId: null,
      sessionKey: null,
      runId: dispatchRequest.runId,
      targetRole: task.targetRole,
      dispatchTarget: task.dispatchTarget,
      scheduler,
      tasks: {
        ...taskState.summary,
        dispatch_candidates: dispatchPlan.length,
      },
      dispatch_plan: dispatchPlan,
      return_processor: returnProcessor,
      events,
      warnings,
    };

    const outputPath = statePath(workspaceRoot);
    const outputDir = path.dirname(outputPath);
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");

    const completed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_apply_smoke_completed", {
      tickId,
      phase: marker.phase,
      selectedTask: task.taskId,
      wouldDispatch: true,
      dispatchRequestPath: requestPath,
      spawnEnabled: false,
      spawnSuppressed: true,
      sessionsSpawnAccepted: false,
      dispatchPlanCount: dispatchPlan.length,
      inboxCount: returnProcessor.inbox_count,
      warnings: state.warnings,
    });
    state.events.push({ eventType: completed.eventType, source: completed.source, payload: completed.payload });
    writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}
`, "utf8");

    consumeApplySmokeMarker(workspaceRoot);

    return state;
  } catch (error) {
    const failed = emitRuntimeLoopEvent(workspaceRoot, "runtime_loop_tick_failed", {
      tickId,
      mode: "apply_smoke",
      phase: marker.phase,
      error: error instanceof Error ? error.message : String(error),
    });
    events.push({ eventType: failed.eventType, source: failed.source, payload: failed.payload });
    consumeApplySmokeMarker(workspaceRoot);
    throw error;
  }
}
