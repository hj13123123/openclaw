import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTaskGraphReturnLinkDryRun } from "./task-graph-return-link-dry-run.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-link-dry-run-"));
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

describe("task graph return link dry-run", () => {
  it("plans task graph nodes for unmatched returns without mutating files", () =>
    withTempRoot((workspaceRoot) => {
      const graphPath = writeJson(
        workspaceRoot,
        "runtime/main/tmp/v2-task-graph-01/task-graph-a.json",
        {
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
        },
      );
      const matchedPath = writeJson(workspaceRoot, "system/returns/inbox/return-a.json", {
        routing: {
          taskId: "TASK-A",
          sourceRole: "engineering-executive",
          action: "complete",
        },
        outcome: {
          summary: "matched",
        },
      });
      const unmatchedPath = writeJson(workspaceRoot, "system/returns/inbox/return-b.json", {
        routing: {
          taskId: "TASK-B",
          sourceRole: "front-end-executive",
          action: "complete",
        },
        outcome: {
          summary: "unmatched",
        },
      });
      const missingTaskPath = writeJson(
        workspaceRoot,
        "system/returns/inbox/return-missing-task.json",
        {
          routing: {
            sourceRole: "engineering-executive",
            action: "complete",
          },
          outcome: {
            summary: "missing task",
          },
        },
      );
      const before = new Map([
        [graphPath, readFileSync(graphPath, "utf8")],
        [matchedPath, readFileSync(matchedPath, "utf8")],
        [unmatchedPath, readFileSync(unmatchedPath, "utf8")],
        [missingTaskPath, readFileSync(missingTaskPath, "utf8")],
      ]);

      const result = buildTaskGraphReturnLinkDryRun(workspaceRoot, {
        plannedAt: "2026-05-22T09:00:00.000Z",
      });

      expect(result).toMatchObject({
        mode: "observe-only",
        dryRun: true,
        unmatchedReturnCount: 2,
        candidateCount: 2,
        linkableCount: 1,
        blockedCount: 1,
        graphErrorCount: 0,
        constraintsVerified: {
          readOnly: "yes",
          taskGraphWritten: "no",
          returnConsumed: "no",
          receiptWritten: "no",
          dispatchTriggered: "no",
          applied: "no",
        },
      });
      expect(result.plans).toEqual([
        expect.objectContaining({
          returnId: "return-b.json",
          taskId: "TASK-B",
          reason: "no_matching_task_node",
          linkable: true,
          proposedNode: {
            nodeId: "return-link-task-b",
            taskId: "TASK-B",
            role: "front-end-executive",
            status: "review_pending",
            returnId: "return-b.json",
            humanGateRequired: true,
          },
        }),
        expect.objectContaining({
          returnId: "return-missing-task.json",
          taskId: null,
          reason: "missing_task_id",
          linkable: false,
          blockedReasons: ["task_id_missing", "return_missing_task_id"],
          proposedNode: null,
        }),
      ]);
      for (const [filePath, contents] of before) {
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe(contents);
      }
    }));
});
