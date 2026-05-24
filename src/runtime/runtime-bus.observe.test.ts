import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDispatchPlan, runAutoDispatcherDryRun } from "./auto-dispatcher.js";
import { createRuntimeEvent, emitEvent, getRecentEvents } from "./event-bus.js";
import { generateActionPlan, writeDryRunAudit } from "./policy-action-executor.js";
import {
  buildRuntimeLoopPreflight,
  buildRuntimeLoopAcceptanceRecordDryRun,
  checkRuntimeLoopProposalAcceptance,
  readLatestRuntimeLoopState,
  tick,
  writeRuntimeLoopDispatchProposal,
} from "./runtime-loop.js";
import { getTaskState, type TaskRecord } from "./task-state-machine.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-bus-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendTask(workspaceRoot: string, task: TaskRecord): void {
  const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
  ensureDir(tasksPath);
  appendFileSync(tasksPath, `${JSON.stringify(task)}\n`, "utf8");
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function task(
  taskId: string,
  status: TaskRecord["status"],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    taskId,
    status,
    sourceRole: "engineering-executive",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    summary: `test task ${taskId}`,
    metadata: {},
    ...overrides,
  };
}

const autoCloseDecision: TaskRecord["policyDecision"] = {
  decisionId: "decision-1",
  ruleId: "R001",
  riskLevel: "L0",
  action: "auto_close",
  reason: "unit test",
  timestamp: "2026-05-20T00:00:00.000Z",
};

describe("runtime bus observe-only validation", () => {
  it("persists runtime events and returns the requested recent tail", () =>
    withTempRoot((workspaceRoot) => {
      emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_started", { tick: 1 }));
      emitEvent(workspaceRoot, createRuntimeEvent("scheduler_tick_completed", { tick: 2 }));

      const recent = getRecentEvents(workspaceRoot, 1);

      expect(recent).toHaveLength(1);
      expect(recent[0]?.eventType).toBe("scheduler_tick_completed");
      expect(recent[0]?.payload).toEqual({ tick: 2 });
    }));

  it("builds task state with last record winning for duplicate task ids", () =>
    withTempRoot((workspaceRoot) => {
      appendTask(
        workspaceRoot,
        task("TASK-1", "queued", { updatedAt: "2026-05-20T00:00:00.000Z" }),
      );
      appendTask(
        workspaceRoot,
        task("TASK-1", "completed", { updatedAt: "2026-05-20T00:01:00.000Z" }),
      );
      appendTask(workspaceRoot, task("TASK-2", "blocked_by_policy"));
      appendTask(workspaceRoot, task("TASK-3", "running"));

      const state = getTaskState(workspaceRoot);

      expect(state.summary).toMatchObject({
        total: 3,
        completed: 1,
        blocked: 1,
        running: 1,
        queued: 0,
      });
      expect(state.tasks.map((item) => [item.taskId, item.status])).toContainEqual([
        "TASK-1",
        "completed",
      ]);
    }));

  it("keeps auto-dispatch in dry-run and records generic queued candidates", () =>
    withTempRoot((workspaceRoot) => {
      appendTask(
        workspaceRoot,
        task("GENERIC-QUEUED-A", "queued", { policyDecision: autoCloseDecision }),
      );
      appendTask(
        workspaceRoot,
        task("GENERIC-QUEUED-B", "queued", { policyDecision: autoCloseDecision }),
      );
      appendTask(
        workspaceRoot,
        task("COMPLETED-A", "completed", { policyDecision: autoCloseDecision }),
      );

      const plan = runAutoDispatcherDryRun(workspaceRoot, 5);
      const planPath = path.join(workspaceRoot, "runtime", "dispatch", "dispatch-plan.jsonl");

      expect(plan.mode).toBe("dry_run");
      expect(plan.items).toEqual([
        expect.objectContaining({
          taskId: "GENERIC-QUEUED-A",
          wouldDispatch: true,
        }),
        expect.objectContaining({
          taskId: "GENERIC-QUEUED-B",
          wouldDispatch: true,
        }),
      ]);
      expect(plan.candidates).toMatchObject({
        total: 2,
        eligible: 2,
        skipped: 0,
        wouldDispatch: 2,
      });
      expect(readJsonl(planPath)).toHaveLength(1);
      expect(getRecentEvents(workspaceRoot, 2).map((event) => event.eventType)).toContain(
        "dispatch_plan_completed",
      );
      expect(generateDispatchPlan(workspaceRoot, 0).items).toEqual([]);
    }));

  it("writes dry-run policy action audit without moving source files", () =>
    withTempRoot((workspaceRoot) => {
      const sourcePath = path.join("system", "returns", "inbox", "return-a.json");
      const absoluteSourcePath = path.join(workspaceRoot, sourcePath);
      ensureDir(absoluteSourcePath);
      writeFileSync(absoluteSourcePath, '{"ok":true}\n', "utf8");
      appendTask(
        workspaceRoot,
        task("RETURN-A", "queued", {
          metadata: { sourcePath },
          policyDecision: autoCloseDecision,
        }),
      );

      const report = generateActionPlan(workspaceRoot);
      writeDryRunAudit(workspaceRoot, report);

      expect(report).toMatchObject({ mode: "dry_run", totalCandidates: 1, wouldExecute: 1 });
      expect(existsSync(absoluteSourcePath)).toBe(true);
      expect(
        readJsonl(path.join(workspaceRoot, "runtime", "policy", "action-audit.jsonl")),
      ).toHaveLength(1);
      expect(getRecentEvents(workspaceRoot, 2).map((event) => event.eventType)).toContain(
        "policy_action_dry_run_completed",
      );
    }));

  it("runs runtime loop tick in observe mode without writing dispatch requests", () =>
    withTempRoot((workspaceRoot) => {
      const returnPath = path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json");
      ensureDir(returnPath);
      writeFileSync(returnPath, '{"returnId":"return-a"}\n', "utf8");
      writeFileSync(
        path.join(workspaceRoot, "system", "returns", "inbox", "return.mock.skip.json"),
        '{"returnId":"mock"}\n',
        "utf8",
      );
      appendTask(
        workspaceRoot,
        task("RUNTIME-A", "queued", {
          metadata: { dispatchTarget: "/main" },
          policyDecision: autoCloseDecision,
        }),
      );
      const policyPath = path.join(workspaceRoot, "runtime", "policy", "policy-rules.json");
      ensureDir(policyPath);
      writeFileSync(
        policyPath,
        `${JSON.stringify({
          $schema: "policy-rules-v1",
          schedulerPolicy: {
            runtimeLoopMode: "observe",
            maxDispatchesPerTick: 1,
            disableOldTrigger: true,
            enableContinuousApply: false,
          },
          rules: [],
        })}\n`,
        "utf8",
      );

      const state = tick(workspaceRoot);
      const latestState = readLatestRuntimeLoopState(workspaceRoot);

      expect(state.mode).toBe("observe");
      expect(state.dispatch_plan).toEqual([
        expect.objectContaining({
          taskId: "RUNTIME-A",
          would_dispatch: false,
          blocked_reason: "observe_only_runtime_loop",
        }),
      ]);
      expect(state.return_processor).toMatchObject({ inbox_count: 1, would_process: 0 });
      expect(state.warnings).toContain(
        "schedulerPolicy.maxDispatchesPerTick is non-zero, dispatch still suppressed by observe-only loop",
      );
      expect(latestState?.tickId).toBe(state.tickId);
      expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch"))).toBe(false);
      expect(getRecentEvents(workspaceRoot, 2).map((event) => event.eventType)).toEqual([
        "runtime_loop_tick_started",
        "runtime_loop_tick_completed",
      ]);
    }));

  it("builds runtime loop preflight without writing runtime state or dispatch requests", () =>
    withTempRoot((workspaceRoot) => {
      const returnPath = path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json");
      ensureDir(returnPath);
      writeFileSync(
        returnPath,
        `${JSON.stringify({
          routing: {
            taskId: "PREFLIGHT-A",
            sourceRole: "engineering-executive",
            action: "complete",
          },
          outcome: { summary: "preflight return" },
        })}\n`,
        "utf8",
      );
      appendTask(
        workspaceRoot,
        task("PREFLIGHT-A", "queued", {
          metadata: { dispatchTarget: "/engineering-executive" },
          policyDecision: autoCloseDecision,
        }),
      );
      appendTask(workspaceRoot, task("PREFLIGHT-B", "queued"));
      const schedulerStatePath = path.join(
        workspaceRoot,
        "runtime",
        "main",
        "tmp",
        "task-scheduler-state.json",
      );
      ensureDir(schedulerStatePath);
      writeFileSync(
        schedulerStatePath,
        `${JSON.stringify({
          enabled: true,
          mode: "observe",
          status: "idle",
          intervalMs: 60_000,
          maxTicks: null,
          policyWarnings: [],
        })}\n`,
        "utf8",
      );
      const policyPath = path.join(workspaceRoot, "runtime", "policy", "policy-rules.json");
      ensureDir(policyPath);
      writeFileSync(
        policyPath,
        `${JSON.stringify({
          $schema: "policy-rules-v1",
          schedulerPolicy: {
            runtimeLoopMode: "observe",
            maxDispatchesPerTick: 1,
            disableOldTrigger: true,
            enableContinuousApply: false,
          },
          rules: [],
        })}\n`,
        "utf8",
      );

      const beforeReturn = readFileSync(returnPath, "utf8");
      const preflight = buildRuntimeLoopPreflight(workspaceRoot);

      expect(preflight).toEqual(
        expect.objectContaining({
          mode: "observe-only",
          tasks: expect.objectContaining({
            queued: 2,
            queued_candidates: 2,
            policy_eligible_candidates: 1,
            would_dispatch_if_apply_enabled: 1,
            would_dispatch: 0,
          }),
          blocked_reasons: expect.arrayContaining([
            "observe_only_preflight",
            "continuous_apply_disabled",
            "policy_action_human_gate",
          ]),
          human_gate_required: true,
          constraintsVerified: {
            stateWritten: "no",
            eventEmitted: "no",
            dispatchTriggered: "no",
            sessionsSpawnCalled: "no",
            taskGraphMutated: "no",
            returnConsumed: "no",
            receiptWritten: "no",
            applied: "no",
          },
        }),
      );
      expect(preflight.dispatch_plan).toEqual([
        expect.objectContaining({
          taskId: "PREFLIGHT-A",
          policy_eligible: true,
          would_dispatch_if_apply_enabled: true,
          would_dispatch: false,
          blocked_reasons: expect.arrayContaining([
            "observe_only_preflight",
            "continuous_apply_disabled",
          ]),
        }),
        expect.objectContaining({
          taskId: "PREFLIGHT-B",
          policy_eligible: false,
          would_dispatch_if_apply_enabled: false,
          blocked_reasons: expect.arrayContaining(["policy_action_human_gate", "risk_level_L2"]),
        }),
      ]);
      expect(preflight.return_processor).toMatchObject({ inbox_count: 1, would_process: 0 });
      expect(readFileSync(returnPath, "utf8")).toBe(beforeReturn);
      expect(
        existsSync(path.join(workspaceRoot, "runtime", "main", "tmp", "runtime-loop-state.json")),
      ).toBe(false);
      expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch"))).toBe(false);
      expect(getRecentEvents(workspaceRoot, 10)).toEqual([]);
    }));

  it("writes a controlled dispatch proposal artifact without dispatching", () =>
    withTempRoot((workspaceRoot) => {
      appendTask(
        workspaceRoot,
        task("PROPOSAL-A", "queued", {
          metadata: { dispatchTarget: "/engineering-executive" },
          policyDecision: autoCloseDecision,
        }),
      );
      const schedulerStatePath = path.join(
        workspaceRoot,
        "runtime",
        "main",
        "tmp",
        "task-scheduler-state.json",
      );
      ensureDir(schedulerStatePath);
      writeFileSync(
        schedulerStatePath,
        `${JSON.stringify({
          enabled: true,
          mode: "observe",
          status: "idle",
          intervalMs: 60_000,
          maxTicks: null,
          policyWarnings: [],
        })}\n`,
        "utf8",
      );
      const policyPath = path.join(workspaceRoot, "runtime", "policy", "policy-rules.json");
      ensureDir(policyPath);
      writeFileSync(
        policyPath,
        `${JSON.stringify({
          $schema: "policy-rules-v1",
          schedulerPolicy: {
            runtimeLoopMode: "observe",
            maxDispatchesPerTick: 1,
            disableOldTrigger: true,
            enableContinuousApply: false,
          },
          rules: [],
        })}\n`,
        "utf8",
      );

      const proposal = writeRuntimeLoopDispatchProposal(workspaceRoot);
      const proposalPath = path.join(workspaceRoot, proposal.proposalPath);
      const persisted = JSON.parse(readFileSync(proposalPath, "utf8")) as typeof proposal;

      expect(proposal).toEqual(
        expect.objectContaining({
          mode: "proposal-only",
          proposalPath: expect.stringMatching(
            /^runtime\/dispatch\/proposals\/runtime-loop-dispatch-proposal-.*\.json$/u,
          ),
          selectedCandidates: [
            expect.objectContaining({
              taskId: "PROPOSAL-A",
              would_dispatch: false,
              would_dispatch_if_apply_enabled: true,
            }),
          ],
          summary: {
            queuedCandidates: 1,
            policyEligibleCandidates: 1,
            proposedDispatches: 1,
            humanGateRequired: true,
          },
          constraintsVerified: {
            artifactWritten: "yes",
            stateWritten: "no",
            eventEmitted: "no",
            dispatchTriggered: "no",
            sessionsSpawnCalled: "no",
            taskGraphMutated: "no",
            returnConsumed: "no",
            receiptWritten: "no",
            applied: "no",
          },
        }),
      );
      expect(persisted.proposalId).toBe(proposal.proposalId);
      expect(
        existsSync(path.join(workspaceRoot, "runtime", "main", "tmp", "runtime-loop-state.json")),
      ).toBe(false);
      expect(getRecentEvents(workspaceRoot, 10)).toEqual([]);
    }));

  it("checks dispatch proposal acceptance without executing dispatch", () =>
    withTempRoot((workspaceRoot) => {
      appendTask(
        workspaceRoot,
        task("ACCEPTANCE-A", "queued", {
          metadata: { dispatchTarget: "/engineering-executive" },
          policyDecision: autoCloseDecision,
        }),
      );
      const schedulerStatePath = path.join(
        workspaceRoot,
        "runtime",
        "main",
        "tmp",
        "task-scheduler-state.json",
      );
      ensureDir(schedulerStatePath);
      writeFileSync(
        schedulerStatePath,
        `${JSON.stringify({
          enabled: true,
          mode: "observe",
          status: "idle",
          intervalMs: 60_000,
          maxTicks: null,
          policyWarnings: [],
        })}\n`,
        "utf8",
      );
      const policyPath = path.join(workspaceRoot, "runtime", "policy", "policy-rules.json");
      ensureDir(policyPath);
      writeFileSync(
        policyPath,
        `${JSON.stringify({
          $schema: "policy-rules-v1",
          schedulerPolicy: {
            runtimeLoopMode: "observe",
            maxDispatchesPerTick: 1,
            disableOldTrigger: true,
            enableContinuousApply: false,
          },
          rules: [],
        })}\n`,
        "utf8",
      );
      const proposal = writeRuntimeLoopDispatchProposal(workspaceRoot);
      const beforeProposal = readFileSync(path.join(workspaceRoot, proposal.proposalPath), "utf8");

      const readyCheck = checkRuntimeLoopProposalAcceptance(workspaceRoot, proposal.proposalPath);

      expect(readyCheck).toEqual(
        expect.objectContaining({
          mode: "acceptance-stub",
          proposalPath: proposal.proposalPath,
          status: "ready_for_human_gate",
          readyForHumanGate: true,
          blockReasons: [],
          proposalSummary: expect.objectContaining({ proposedDispatches: 1 }),
          selectedCandidateTaskIds: ["ACCEPTANCE-A"],
          currentCandidateTaskIds: ["ACCEPTANCE-A"],
          constraintsVerified: {
            artifactWritten: "no",
            stateWritten: "no",
            eventEmitted: "no",
            dispatchTriggered: "no",
            sessionsSpawnCalled: "no",
            taskGraphMutated: "no",
            returnConsumed: "no",
            receiptWritten: "no",
            applied: "no",
          },
        }),
      );
      appendTask(
        workspaceRoot,
        task("ACCEPTANCE-A", "completed", {
          updatedAt: "2026-05-20T00:01:00.000Z",
          policyDecision: autoCloseDecision,
        }),
      );

      const driftCheck = checkRuntimeLoopProposalAcceptance(workspaceRoot, proposal.proposalPath);

      expect(driftCheck).toEqual(
        expect.objectContaining({
          status: "blocked",
          readyForHumanGate: false,
          blockReasons: ["current_preflight_drift"],
          selectedCandidateTaskIds: ["ACCEPTANCE-A"],
          currentCandidateTaskIds: [],
        }),
      );
      expect(readFileSync(path.join(workspaceRoot, proposal.proposalPath), "utf8")).toBe(
        beforeProposal,
      );
      expect(getRecentEvents(workspaceRoot, 10)).toEqual([]);
    }));

  it("builds acceptance record dry-run preview without writing approval state", () =>
    withTempRoot((workspaceRoot) => {
      appendTask(
        workspaceRoot,
        task("ACCEPTANCE-DRY-RUN-A", "queued", {
          metadata: { dispatchTarget: "/engineering-executive" },
          policyDecision: autoCloseDecision,
        }),
      );
      const schedulerStatePath = path.join(
        workspaceRoot,
        "runtime",
        "main",
        "tmp",
        "task-scheduler-state.json",
      );
      ensureDir(schedulerStatePath);
      writeFileSync(
        schedulerStatePath,
        `${JSON.stringify({
          enabled: true,
          mode: "observe",
          status: "idle",
          intervalMs: 60_000,
          maxTicks: null,
          policyWarnings: [],
        })}\n`,
        "utf8",
      );
      const policyPath = path.join(workspaceRoot, "runtime", "policy", "policy-rules.json");
      ensureDir(policyPath);
      writeFileSync(
        policyPath,
        `${JSON.stringify({
          $schema: "policy-rules-v1",
          schedulerPolicy: {
            runtimeLoopMode: "observe",
            maxDispatchesPerTick: 1,
            disableOldTrigger: true,
            enableContinuousApply: false,
          },
          rules: [],
        })}\n`,
        "utf8",
      );
      const proposal = writeRuntimeLoopDispatchProposal(workspaceRoot);
      const proposalPath = path.join(workspaceRoot, proposal.proposalPath);
      const beforeProposal = readFileSync(proposalPath, "utf8");

      const dryRun = buildRuntimeLoopAcceptanceRecordDryRun(workspaceRoot, proposal.proposalPath);

      expect(dryRun).toEqual(
        expect.objectContaining({
          mode: "acceptance-record-dry-run",
          proposalPath: proposal.proposalPath,
          wouldWrite: false,
          wouldWritePath: expect.stringMatching(
            /^runtime\/dispatch\/acceptance-records\/runtime-loop-acceptance-.*\.json$/u,
          ),
          acceptance: expect.objectContaining({
            status: "ready_for_human_gate",
            readyForHumanGate: true,
          }),
          recordPreview: expect.objectContaining({
            proposalId: proposal.proposalId,
            proposalPath: proposal.proposalPath,
            selectedCandidateTaskIds: ["ACCEPTANCE-DRY-RUN-A"],
            proposedDispatches: 1,
            requiredApproval: "human",
            nextAction: "await_human_approval",
            approved: false,
            dispatchTriggered: false,
          }),
          constraintsVerified: {
            recordWritten: "no",
            stateWritten: "no",
            eventEmitted: "no",
            dispatchTriggered: "no",
            sessionsSpawnCalled: "no",
            taskGraphMutated: "no",
            returnConsumed: "no",
            receiptWritten: "no",
            applied: "no",
          },
        }),
      );
      expect(
        existsSync(path.join(workspaceRoot, "runtime", "dispatch", "acceptance-records")),
      ).toBe(false);
      expect(readFileSync(proposalPath, "utf8")).toBe(beforeProposal);
      expect(getRecentEvents(workspaceRoot, 10)).toEqual([]);
    }));
});
