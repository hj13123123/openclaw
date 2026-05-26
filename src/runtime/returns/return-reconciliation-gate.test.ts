import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReturnReconciliationGate } from "./return-reconciliation-gate.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-reconciliation-gate-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("return reconciliation gate", () => {
  it("reports ready dry-runs as frozen-blocked when the workspace freeze flag is active", () =>
    withTempRoot((workspaceRoot) => {
      writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "FROZEN\n", "utf8");
      writeJson(workspaceRoot, "runtime/main/tmp/v2-task-graph-01/task-graph-a.json", {
        graphId: "graph-a",
        parentTaskId: "PARENT-A",
        title: "Task graph",
        status: "running",
        aggregateStatus: "running",
        nodes: [
          {
            nodeId: "a",
            role: "engineering-executive",
            taskId: "TASK-A",
            description: "Task A",
            dependsOn: [],
            status: "running",
            runId: null,
            sessionKey: null,
            returnId: null,
            humanGateRequired: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        edges: [],
        blockers: [],
        nextRunnable: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      writeJson(workspaceRoot, "system/returns/inbox/return-v2.json", {
        packageId: "rrpkg-v2",
        packageVersion: "2.0",
        returnType: "completion",
        producedAt: timestamp,
        role: {
          roleId: "engineering-executive",
          roleType: "executor",
        },
        taskId: "TASK-B",
        deliveryReceipt: {
          receiptId: "delivery-b",
          deliveryStatus: "delivered",
          summary: "done",
        },
        returnSummary: {
          status: "completed",
        },
        recommendedNextAction: {
          action: "main-verify",
          target: "main",
          description: "verify result",
        },
      });

      const result = evaluateReturnReconciliationGate(workspaceRoot, {
        checkedAt: "2026-05-22T09:00:00.000Z",
      });

      expect(result).toEqual({
        mode: "observe-only",
        checkedAt: "2026-05-22T09:00:00.000Z",
        status: "ready",
        frozen: true,
        readyForControlledApply: false,
        applyBlockedReason: "frozen",
        nextAction: "await_unfreeze_or_human_approval",
        repair: {
          candidateCount: 1,
          repairableCount: 1,
          blockedCount: 0,
        },
        returnLink: {
          candidateCount: 1,
          linkableCount: 1,
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
      });
    }));

  it("reports empty workspaces as no-action", () =>
    withTempRoot((workspaceRoot) => {
      expect(
        evaluateReturnReconciliationGate(workspaceRoot, {
          checkedAt: "2026-05-22T09:00:00.000Z",
        }),
      ).toMatchObject({
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
      });
    }));
});
