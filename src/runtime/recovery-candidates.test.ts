import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRecoveryCandidates, suggestRecoveryAction } from "./recovery-candidates.js";
import { TASK_GRAPH_SOURCE_RELATIVE_PATH } from "./task-graph.js";

let tempRoots: string[] = [];

function makeWorkspace(): string {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-recovery-candidates-"));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function graphPath(workspaceRoot: string, fileName = "task-graph-a.json"): string {
  return path.join(workspaceRoot, TASK_GRAPH_SOURCE_RELATIVE_PATH, fileName);
}

function taskGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graphId: "graph-a",
    nodes: [
      {
        nodeId: "a",
        taskId: "TASK-A",
        status: "failed",
        description: "Task A failed",
        dependsOn: [],
        runId: "run-a",
      },
      {
        nodeId: "b",
        taskId: "TASK-B",
        status: "planned",
        description: "Task B",
        dependsOn: ["a"],
        runId: null,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("recovery candidates scanner", () => {
  it("maps recovery-eligible task graph nodes to observe-only candidates", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(graphPath(workspaceRoot), taskGraph());

    const result = scanRecoveryCandidates(workspaceRoot, {
      scannedAt: "2026-05-25T00:00:00.000Z",
    });

    expect(result).toEqual(
      expect.objectContaining({
        mode: "observe-only",
        sourcePath: "runtime/main/tmp/v2-task-graph-01/",
        frozen: false,
        graphCount: 1,
        candidateCount: 1,
        byStatus: [{ status: "failed", count: 1 }],
        bySuggestedAction: [{ action: "retry", count: 1 }],
        errors: [],
        constraintsVerified: {
          readOnly: "yes",
          recoveryDecisionWritten: "no",
          taskGraphMutated: "no",
          sessionsSent: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(result.candidates).toEqual([
      {
        graphId: "graph-a",
        graphPath: "runtime/main/tmp/v2-task-graph-01/task-graph-a.json",
        nodeId: "a",
        taskId: "TASK-A",
        nodeStatus: "failed",
        suggestedAction: "retry",
        description: "Task A failed",
        dependsOn: [],
        runId: "run-a",
        affectedDownstream: ["b"],
      },
    ]);
  });

  it("keeps frozen workspaces scan-only instead of suppressing candidates", () => {
    const workspaceRoot = makeWorkspace();
    writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "FROZEN flag active\n", "utf8");
    writeJson(
      graphPath(workspaceRoot),
      taskGraph({
        nodes: [
          {
            nodeId: "a",
            taskId: "TASK-A",
            status: "paused",
            description: "Paused task",
            dependsOn: [],
            runId: null,
          },
        ],
      }),
    );

    const result = scanRecoveryCandidates(workspaceRoot);

    expect(result.frozen).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        nodeStatus: "paused",
        suggestedAction: "resume",
      }),
    );
    expect(result.message).toContain("Frozen: apply blocked");
  });

  it("filters by graphId after parsing graph contents", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(graphPath(workspaceRoot, "task-graph-a.json"), taskGraph({ graphId: "graph-a" }));
    writeJson(graphPath(workspaceRoot, "task-graph-b.json"), taskGraph({ graphId: "graph-b" }));

    const result = scanRecoveryCandidates(workspaceRoot, { graphId: "graph-b" });

    expect(result.graphCount).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]?.graphId).toBe("graph-b");
  });

  it("reports malformed task graphs without mutating anything", () => {
    const workspaceRoot = makeWorkspace();
    mkdirSync(path.dirname(graphPath(workspaceRoot)), { recursive: true });
    writeFileSync(graphPath(workspaceRoot), "{ bad json", "utf8");

    const result = scanRecoveryCandidates(workspaceRoot);

    expect(result.graphCount).toBe(0);
    expect(result.candidateCount).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        graphPath: "runtime/main/tmp/v2-task-graph-01/task-graph-a.json",
        code: "parse_failed",
      }),
    ]);
  });

  it("uses stable action mapping for every eligible status", () => {
    expect(suggestRecoveryAction("paused")).toBe("resume");
    expect(suggestRecoveryAction("blocked")).toBe("unblock");
    expect(suggestRecoveryAction("failed")).toBe("retry");
    expect(suggestRecoveryAction("cancelled")).toBe("skip");
    expect(suggestRecoveryAction("interrupted")).toBe("skip");
  });
});
