import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HUD_STATE_RELATIVE_PATH, writeHudStateSnapshot } from "./hud-state-refresh.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-hud-refresh-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBomJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `\uFEFF${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("HUD state refresh", () => {
  it("generates and writes HUD state from workspace files", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(workspaceRoot, "system/positions/state/main_workspace-main.json", {
        agentId: "main",
        status: "running",
        currentTask: "TASK-MAIN",
        progressPct: 25,
        updatedAt: "2026-05-20T00:00:00.000Z",
      });
      writeJson(workspaceRoot, "system/positions/state/engineering-executive_workspace-main.json", {
        agentId: "engineering-executive",
        status: "idle",
        progressPct: 100,
      });
      writeBomJson(workspaceRoot, "system/positions/state/evolution-curator_workspace-main.json", {
        positionId: "evolution-curator",
        positionType: "curator",
        currentState: "available",
        updatedAt: "2026-05-20T00:00:00.000Z",
      });
      writeJson(workspaceRoot, "system/returns/inbox/return-a.json", {
        routing: {
          taskId: "TASK-A",
          sourceRole: "engineering-executive",
          action: "complete",
        },
        outcome: {
          summary: "return summary",
        },
      });
      writeJson(workspaceRoot, "system/returns/inbox/return.mock.skip.json", {
        taskId: "MOCK",
      });
      writeJson(workspaceRoot, "system/case-library/case-a.json", {
        caseId: "case-a",
      });
      writeJson(workspaceRoot, "system/control-signals/pending/ctrl-a.json", {
        signalId: "ctrl-a",
        taskId: "TASK-B",
        targetRole: "engineering-executive",
        action: "pause",
        status: "pending",
      });
      writeJson(workspaceRoot, "runtime/main/tmp/v2-task-graph-01/task-graph-a.json", {
        graphId: "graph-a",
        parentTaskId: "TASK-PARENT",
        title: "Graph A",
        status: "blocked",
        aggregateStatus: "blocked",
        nodes: [
          {
            nodeId: "a",
            role: "engineering-executive",
            taskId: "TASK-A",
            description: "Task A",
            dependsOn: [],
            status: "completed",
            runId: null,
            sessionKey: null,
            returnId: null,
            humanGateRequired: false,
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
          {
            nodeId: "b",
            role: "engineering-executive",
            taskId: "TASK-B",
            description: "Task B",
            dependsOn: [],
            status: "blocked",
            runId: null,
            sessionKey: null,
            returnId: null,
            humanGateRequired: false,
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
        ],
        edges: [],
        blockers: [{ nodeId: "b", reason: "unit test" }],
        nextRunnable: ["c"],
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
      });
      writeJson(workspaceRoot, "runtime/main/tmp/mirror-observe-2026-05-20T00-01-30-000Z.json", {
        taskId: "DOMAIN10-MIRROR-OBSERVE-ONLY-A",
        mirrorId: "mirror-20260520-000130000Z",
        generatedAt: "2026-05-20T00:01:30.000Z",
        mode: "observe-only",
        workspaceRoot,
        outputFile: path.join(
          workspaceRoot,
          "runtime/main/tmp/mirror-observe-2026-05-20T00-01-30-000Z.json",
        ),
        observations: [],
        findings: [],
        stats: {
          observationCount: 4,
          findingCount: 4,
          bySeverity: {
            attention: 2,
            info: 2,
          },
        },
        constraintsVerified: {
          MEMORYWritten: "no",
          ENGINEERING_RULESWritten: "no",
          skillLibraryWritten: "no",
          caseLibraryWritten: "no",
          promoted: "none",
          autoLoopTriggered: "no",
          applyPerformed: "no",
        },
        verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
      });
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/auto-evolution-observe-2026-05-20T00-01-40-000Z.json",
        {
          taskId: "DOMAIN11-AUTO-EVOLUTION-OBSERVE-ONLY-A",
          generatedAt: "2026-05-20T00:01:40.000Z",
          status: "PASS",
          mode: "observe-only",
          workspaceRoot,
          outputFile: path.join(
            workspaceRoot,
            "runtime/main/tmp/auto-evolution-observe-2026-05-20T00-01-40-000Z.json",
          ),
          stats: {
            totalSuggestions: 3,
            byPriority: {
              P1: 2,
              P2: 1,
            },
            bySource: {
              mirror: 1,
              promote_gate: 1,
              hud: 1,
            },
          },
          inputs: {
            mirrorReportPath: "runtime/main/tmp/mirror-observe-2026-05-20T00-01-30-000Z.json",
            promoteGateReportPath: null,
            hudStatePath: "runtime/main/tmp/task-hud-state.json",
            kbIndexPath: null,
            runtimeLoopStatePath: null,
          },
          suggestions: [],
          constraintsVerified: {
            MEMORYWritten: "no",
            ENGINEERING_RULESWritten: "no",
            codeWritten: "no",
            skillLibraryWritten: "no",
            caseLibraryWritten: "no",
            promoted: "none",
            applyPerformed: "no",
            autoEvolutionApplied: "no",
            continuousAutoLoopTriggered: "no",
          },
          verdict: "PASS / AUTO-EVOLUTION OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
        },
      );

      const result = writeHudStateSnapshot(workspaceRoot, "2026-05-20T00:02:00.000Z");
      const statePath = path.join(workspaceRoot, HUD_STATE_RELATIVE_PATH);
      const written = JSON.parse(readFileSync(statePath, "utf8")) as typeof result.state;

      expect(existsSync(statePath)).toBe(true);
      expect(result.statePath).toBe(HUD_STATE_RELATIVE_PATH);
      expect(written.generator).toBe("runtime-hud-state");
      expect(written.globalStatus.status).toBe("attention_required");
      expect(written.agentGroups.map((agent) => agent.agentId)).toEqual([
        "main",
        "engineering-executive",
        "patrol",
      ]);
      expect(written.agentGroups.find((agent) => agent.agentId === "patrol")).toMatchObject({
        role: "observability",
        status: "unknown",
        source: "configured",
      });
      expect(
        written.agentGroups.find((agent) => agent.agentId === "evolution-curator"),
      ).toBeUndefined();
      expect(written.returnInbox.pendingCount).toBe(1);
      expect(written.returnInbox.pendingItems[0]).toMatchObject({
        returnId: "return-a.json",
        taskId: "TASK-A",
        sourceRole: "engineering-executive",
        summary: "return summary",
      });
      expect(written.returnConsumerPlan).toMatchObject({
        mode: "observe-only",
        inboxPath: "system/returns/inbox",
        processedPath: "system/returns/processed",
        totalCount: 1,
        processCount: 0,
        skipCount: 1,
        byReason: [{ reason: "schema-invalid", count: 1 }],
        warningCount: 0,
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      });
      expect(written.caseLibrary.totalCases).toBe(1);
      expect(written.taskGraphs).toMatchObject({
        total: 1,
        active: 1,
        blocked: 1,
      });
      expect(written.taskGraphs.items[0]).toMatchObject({
        graphId: "graph-a",
        lastValidatedAt: "2026-05-20T00:02:00.000Z",
        validationSeverity: "pass",
        nodeSummary: {
          total: 2,
          completed: 1,
          blocked: 1,
        },
        nextRunnable: ["c"],
      });
      expect(
        readdirSync(path.join(workspaceRoot, "runtime/main/tmp")).some((name) =>
          name.startsWith("task-graph-validation-"),
        ),
      ).toBe(false);
      expect(written.controlSignals).toMatchObject({
        mode: "observe-only",
        status: "ok",
        pendingCount: 1,
        validCount: 1,
        invalidCount: 0,
        byRole: [{ role: "engineering-executive", count: 1 }],
        byAction: [{ action: "pause", count: 1 }],
      });
      expect(written.recoveryCandidates).toMatchObject({
        mode: "observe-only",
        graphCount: 1,
        candidateCount: 1,
        byStatus: [{ status: "blocked", count: 1 }],
        bySuggestedAction: [{ action: "unblock", count: 1 }],
        errorCount: 0,
      });
      expect(written.mirrorObserve).toMatchObject({
        available: true,
        reportPath: "runtime/main/tmp/mirror-observe-2026-05-20T00-01-30-000Z.json",
        mirrorId: "mirror-20260520-000130000Z",
        generatedAt: "2026-05-20T00:01:30.000Z",
        mode: "observe-only",
        constraintsVerified: {
          MEMORYWritten: "no",
          ENGINEERING_RULESWritten: "no",
          promoted: "none",
          applyPerformed: "no",
        },
      });
      expect(written.autoEvolutionObserve).toMatchObject({
        available: true,
        reportPath: "runtime/main/tmp/auto-evolution-observe-2026-05-20T00-01-40-000Z.json",
        generatedAt: "2026-05-20T00:01:40.000Z",
        mode: "observe-only",
        stats: {
          totalSuggestions: 3,
          byPriority: {
            P1: 2,
            P2: 1,
          },
        },
        constraintsVerified: {
          MEMORYWritten: "no",
          ENGINEERING_RULESWritten: "no",
          codeWritten: "no",
          promoted: "none",
          applyPerformed: "no",
          autoEvolutionApplied: "no",
          continuousAutoLoopTriggered: "no",
        },
      });
      expect(written.watchdogSnapshot.byCondition).toMatchObject({
        mirrorObserveAttention: 2,
        autoEvolutionObserveP1: 2,
        pendingControlSignals: 1,
        recoveryCandidates: 1,
        returnConsumerSkipped: 1,
      });
    }));

  it("keeps missing optional runtime directories as warnings instead of throwing", () =>
    withTempRoot((workspaceRoot) => {
      const result = writeHudStateSnapshot(workspaceRoot, "2026-05-20T00:03:00.000Z");

      expect(result.refreshed).toBe(true);
      expect(result.state.globalStatus.status).toBe("degraded");
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "case library directory missing",
          "positions state directory missing",
          "return inbox directory missing",
        ]),
      );
    }));
});
