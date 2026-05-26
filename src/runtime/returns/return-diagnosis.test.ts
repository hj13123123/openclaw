import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanReturnDiagnosis } from "./return-diagnosis.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-diagnosis-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): string {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function validReturnPackage(taskId = "TASK-A"): Record<string, unknown> {
  return {
    packageId: `rrpkg-${taskId}`,
    packageVersion: "1.0",
    returnType: "completion",
    producedAt: timestamp,
    role: {
      roleId: "engineering-executive",
      roleType: "executor",
    },
    task: {
      ticketId: taskId,
      taskTitle: "Task A",
    },
    deliveryReceipt: {
      receiptId: `delivery-${taskId}`,
      deliveryStatus: "delivered",
      summary: "delivered",
    },
    returnSummary: {
      status: "completed",
    },
    candidateEligibility: {
      eligible: false,
    },
    recommendedNextAction: {
      action: "accept",
      target: "main",
      description: "accept result",
    },
  };
}

function taskGraph(): Record<string, unknown> {
  return {
    graphId: "graph-a",
    parentTaskId: "PARENT-A",
    title: "Task graph test",
    status: "running",
    nodes: [
      {
        nodeId: "a",
        role: "engineering-executive",
        taskId: "TASK-A",
        description: "task graph node a",
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
    aggregateStatus: "running",
    blockers: [],
    nextRunnable: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("return diagnosis scanner", () => {
  it("explains consumable, v2-shaped, and task graph mismatch states without writing", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(workspaceRoot, "runtime/main/tmp/v2-task-graph-01/task-graph-a.json", taskGraph());
      const validPath = writeJson(
        workspaceRoot,
        "system/returns/inbox/return-a.json",
        validReturnPackage(),
      );
      const v2Path = writeJson(workspaceRoot, "system/returns/inbox/return-v2-shape.json", {
        packageId: "rrpkg-v2-shape",
        packageVersion: "1.0",
        schema: "canonical-v2-return",
        returnType: "completion",
        producedAt: timestamp,
        role: {
          roleId: "engineering-executive",
          roleType: "executor",
        },
        task: {
          taskId: "TASK-X",
        },
        candidateEligibility: {
          eligible: true,
        },
        recommendedNextAction: {
          action: "main-verify",
          target: "main",
          description: "review result",
        },
      });
      const before = new Map([
        [validPath, readFileSync(validPath, "utf8")],
        [v2Path, readFileSync(v2Path, "utf8")],
      ]);

      const result = scanReturnDiagnosis(workspaceRoot, {
        scannedAt: "2026-05-22T09:00:00.000Z",
      });

      expect(result).toMatchObject({
        mode: "observe-only",
        scannedAt: "2026-05-22T09:00:00.000Z",
        inboxPath: "system/returns/inbox",
        totalCount: 2,
        diagnosableCount: 1,
        byCompatibility: [
          { compatibility: "v1-consumable", count: 1 },
          { compatibility: "v2-shaped", count: 1 },
        ],
        bySuggestedAction: [
          { action: "no-action", count: 1 },
          { action: "repair-to-v1-dry-run", count: 1 },
        ],
        constraintsVerified: {
          readOnly: "yes",
          returnWritten: "no",
          returnConsumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      });
      expect(result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: "return-a.json",
            taskId: "TASK-A",
            compatibility: "v1-consumable",
            taskGraphStatus: "matched",
            suggestedAction: "no-action",
            issues: [],
          }),
          expect.objectContaining({
            sourceFile: "return-v2-shape.json",
            taskId: "TASK-X",
            compatibility: "v2-shaped",
            taskGraphStatus: "unmatched",
            suggestedAction: "repair-to-v1-dry-run",
            planReason: "schema-invalid",
          }),
        ]),
      );
      expect(
        result.items
          .find((item) => item.sourceFile === "return-v2-shape.json")
          ?.issues.map((issue) => issue.code),
      ).toEqual([
        "consumer_schema_invalid",
        "consumer_schema_invalid",
        "v2_shape_not_consumer_v1",
        "task_graph_unmatched",
      ]);
      expect(result.byIssueCode).toEqual([
        { code: "consumer_schema_invalid", count: 2 },
        { code: "task_graph_unmatched", count: 1 },
        { code: "v2_shape_not_consumer_v1", count: 1 },
      ]);
      for (const [filePath, contents] of before) {
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe(contents);
      }
    }));
});
