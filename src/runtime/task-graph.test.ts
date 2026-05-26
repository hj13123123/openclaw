import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TASK_GRAPH_SOURCE_RELATIVE_PATH,
  buildTaskGraphReturnPreview,
  buildTaskGraphValidationSummary,
  listTaskGraphFiles,
  reconcileTaskGraph,
  resolveTaskGraphNextRunnable,
  runTaskGraphValidationObserve,
  taskGraphValidationReportPath,
  validateTaskGraph,
  validateTaskGraphFile,
  writeTaskGraphValidationReport,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphStatus,
} from "./task-graph.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function node(
  nodeId: string,
  status: TaskGraphStatus,
  overrides: Partial<TaskGraphNode> = {},
): TaskGraphNode {
  return {
    nodeId,
    role: "engineering-executive",
    taskId: `TASK-${nodeId.toUpperCase()}`,
    description: `task graph node ${nodeId}`,
    dependsOn: [],
    status,
    runId: null,
    sessionKey: null,
    returnId: null,
    humanGateRequired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    graphId: "graph-a",
    parentTaskId: "PARENT-A",
    title: "Task graph test",
    status: "planned",
    nodes: [node("a", "planned")],
    edges: [],
    aggregateStatus: "planned",
    blockers: [],
    nextRunnable: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function withTempWorkspace<T>(callback: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-task-graph-"));
  try {
    return callback(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("task graph core", () => {
  it("validates a graph and calculates hard-dependency runnable nodes", () => {
    const result = validateTaskGraph(
      graph({
        nodes: [
          node("a", "completed", { role: "main" }),
          node("b", "planned", { role: "patrol", dependsOn: ["a"] }),
        ],
        edges: [{ from: "a", to: "b", type: "hard" }],
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.calculatedAggregateStatus).toBe("planned");
    expect(result.calculatedNextRunnable).toEqual(["b"]);
    expect(result.calculatedBlockers).toEqual([]);
  });

  it("keeps legacy curator roles parseable while flagging them as non-V2 roles", () => {
    const result = validateTaskGraph(
      graph({
        nodes: [node("a", "planned", { role: "evolution-curator" })],
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toMatchObject([
      {
        check: "role_enum",
        field: "nodes[0].role",
        actual: "evolution-curator",
      },
    ]);
  });

  it("reconciles planned nodes to ready when hard dependencies are complete", () => {
    const result = reconcileTaskGraph(
      graph({
        nodes: [node("a", "completed"), node("b", "planned", { dependsOn: ["a"] })],
        edges: [{ from: "a", to: "b", type: "hard" }],
      }),
      "2026-05-20T00:01:00.000Z",
    );

    expect(result.changedNodeIds).toEqual(["b"]);
    expect(result.blockedNodeIds).toEqual([]);
    expect(result.graph.nodes.find((item) => item.nodeId === "b")?.status).toBe("ready");
    expect(result.graph.aggregateStatus).toBe("ready");
    expect(result.graph.nextRunnable).toEqual(["b"]);
  });

  it("blocks dispatchable nodes when a hard dependency failed", () => {
    const result = reconcileTaskGraph(
      graph({
        nodes: [node("a", "failed"), node("b", "planned", { dependsOn: ["a"] })],
      }),
    );

    expect(result.changedNodeIds).toEqual(["b"]);
    expect(result.blockedNodeIds).toEqual(["b"]);
    expect(result.graph.nodes.find((item) => item.nodeId === "b")?.status).toBe("blocked");
    expect(result.graph.aggregateStatus).toBe("blocked");
    expect(result.graph.nextRunnable).toEqual([]);
    expect(result.graph.blockers).toEqual(
      expect.arrayContaining([
        { nodeId: "a", reason: "status=failed" },
        { nodeId: "b", reason: "hard dependency a is failed" },
        { nodeId: "b", reason: "status=blocked" },
      ]),
    );
  });

  it("does not let soft or parallel edges block runnable nodes", () => {
    const sourceGraph = graph({
      nodes: [node("a", "planned"), node("b", "planned"), node("c", "ready")],
      edges: [
        { from: "a", to: "b", type: "soft" },
        { from: "a", to: "c", type: "parallel" },
      ],
    });

    expect(resolveTaskGraphNextRunnable(sourceGraph)).toEqual(["a", "b", "c"]);
  });

  it("reports duplicate ids, missing dependencies, invalid edge refs, and aggregate mismatch", () => {
    const result = validateTaskGraph(
      graph({
        nodes: [node("a", "completed"), node("a", "planned", { dependsOn: ["missing"] })],
        edges: [{ from: "missing-edge", to: "a", type: "hard" }],
        aggregateStatus: "completed",
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.check)).toEqual(
      expect.arrayContaining([
        "duplicate_node_id",
        "depends_on_reference",
        "edge_reference",
        "aggregate_status",
      ]),
    );
  });

  it("lists workspace task graph files and returns an observe-only pass report", () => {
    withTempWorkspace((workspaceRoot) => {
      const graphPath = path.join(
        workspaceRoot,
        TASK_GRAPH_SOURCE_RELATIVE_PATH,
        "task-graph-a.json",
      );
      writeJson(
        graphPath,
        graph({
          nodes: [node("a", "completed"), node("b", "planned", { dependsOn: ["a"] })],
          edges: [{ from: "a", to: "b", type: "hard" }],
        }),
      );

      expect(listTaskGraphFiles(workspaceRoot)).toEqual([graphPath]);

      const report = validateTaskGraphFile(graphPath, timestamp);
      expect(report).toMatchObject({
        graphId: "graph-a",
        graphPath,
        checkedAt: timestamp,
        status: "PASS",
        severity: "pass",
        valid: true,
        mode: "observe-only",
        wouldDispatch: false,
        applied: false,
        calculatedNextRunnable: ["b"],
      });
      expect(report.errors).toEqual([]);
    });
  });

  it("writes validation reports without mutating the source graph", () => {
    withTempWorkspace((workspaceRoot) => {
      const graphPath = path.join(
        workspaceRoot,
        TASK_GRAPH_SOURCE_RELATIVE_PATH,
        "task-graph-a.json",
      );
      const sourceGraph = graph();
      writeJson(graphPath, sourceGraph);

      const result = runTaskGraphValidationObserve(workspaceRoot, {
        checkedAt: timestamp,
        writeReports: true,
      });
      expect(result.reports).toHaveLength(1);
      expect(result.writtenReportPaths).toEqual([
        taskGraphValidationReportPath(workspaceRoot, result.reports[0]),
      ]);

      const writtenReport = JSON.parse(
        readFileSync(result.writtenReportPaths[0], "utf8"),
      ) as Record<string, unknown>;
      expect(writtenReport).toMatchObject({
        graphId: "graph-a",
        checkedAt: timestamp,
        severity: "pass",
        mode: "observe-only",
        wouldDispatch: false,
        applied: false,
      });
      expect(JSON.parse(readFileSync(graphPath, "utf8"))).toEqual(sourceGraph);
    });
  });

  it("builds a relative observe-only validation summary for API consumers", () => {
    withTempWorkspace((workspaceRoot) => {
      writeJson(
        path.join(workspaceRoot, TASK_GRAPH_SOURCE_RELATIVE_PATH, "task-graph-a.json"),
        graph(),
      );

      const summary = buildTaskGraphValidationSummary(workspaceRoot, { checkedAt: timestamp });

      expect(summary).toEqual(
        expect.objectContaining({
          ok: true,
          available: true,
          mode: "observe-only",
          observeOnly: true,
          applied: false,
          wouldDispatch: false,
          sourcePath: "runtime/main/tmp/v2-task-graph-01/",
          checkedAt: timestamp,
          total: 1,
          valid: true,
          bySeverity: { pass: 1, warning: 0, error: 0 },
        }),
      );
      expect(summary.reports[0]).toEqual(
        expect.objectContaining({
          graphPath: "runtime/main/tmp/v2-task-graph-01/task-graph-a.json",
          severity: "pass",
        }),
      );
    });
  });

  it("reports malformed graph files as ambiguous observe failures", () => {
    withTempWorkspace((workspaceRoot) => {
      const graphPath = path.join(
        workspaceRoot,
        TASK_GRAPH_SOURCE_RELATIVE_PATH,
        "task-graph-bad.json",
      );
      mkdirSync(path.dirname(graphPath), { recursive: true });
      writeFileSync(graphPath, "{ not json", "utf8");

      const report = validateTaskGraphFile(graphPath, timestamp);
      expect(report.graphId).toBeNull();
      expect(report.status).toBe("FAIL");
      expect(report.severity).toBe("error");
      expect(report.valid).toBe(false);
      expect(report.mode).toBe("observe-only");
      expect(report.wouldDispatch).toBe(false);
      expect(report.applied).toBe(false);
      expect(report.errors.map((error) => error.check)).toEqual(["json_parse"]);
    });
  });

  it("can write a single validation report path for HUD consumption", () => {
    withTempWorkspace((workspaceRoot) => {
      const graphPath = path.join(
        workspaceRoot,
        TASK_GRAPH_SOURCE_RELATIVE_PATH,
        "task-graph-a.json",
      );
      writeJson(graphPath, graph());

      const report = validateTaskGraphFile(graphPath, timestamp);
      const reportPath = writeTaskGraphValidationReport(workspaceRoot, report);

      expect(reportPath).toBe(
        path.join(
          workspaceRoot,
          "runtime/main/tmp/task-graph-validation-graph-a-2026-05-20T00-00-00.000Z.json",
        ),
      );
      const persisted = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
      expect(persisted.graphId).toBe("graph-a");
      expect(persisted.checkedAt).toBe(timestamp);
      expect(persisted.severity).toBe("pass");
    });
  });

  it("previews return-to-node matches without mutating graph or consuming returns", () => {
    withTempWorkspace((workspaceRoot) => {
      const graphPath = path.join(
        workspaceRoot,
        TASK_GRAPH_SOURCE_RELATIVE_PATH,
        "task-graph-a.json",
      );
      const sourceGraph = graph({
        status: "running",
        nodes: [
          node("a", "review_pending", { taskId: "TASK-A" }),
          node("b", "planned", { taskId: "TASK-B" }),
          node("c", "completed", { taskId: "TASK-C", returnId: "return-declared.json" }),
        ],
        aggregateStatus: "running",
      });
      writeJson(graphPath, sourceGraph);
      writeJson(path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json"), {
        routing: { taskId: "TASK-A", sourceRole: "engineering-executive", action: "complete" },
        outcome: { summary: "done" },
      });
      writeJson(path.join(workspaceRoot, "system", "returns", "inbox", "return-unmatched.json"), {
        routing: { taskId: "TASK-X", sourceRole: "engineering-executive", action: "complete" },
        outcome: { summary: "done" },
      });
      writeJson(
        path.join(workspaceRoot, "system", "returns", "inbox", "return-missing-task.json"),
        {
          routing: { sourceRole: "engineering-executive", action: "complete" },
          outcome: { summary: "done" },
        },
      );

      const preview = buildTaskGraphReturnPreview(workspaceRoot, {
        observedAt: "2026-05-22T12:00:00.000Z",
      });

      expect(preview).toEqual(
        expect.objectContaining({
          mode: "observe-only",
          observedAt: "2026-05-22T12:00:00.000Z",
          graphCount: 1,
          nodeCount: 3,
          pendingReturnCount: 3,
          matchedNodeCount: 1,
          missingNodeCount: 1,
          ambiguousNodeCount: 0,
          declaredReturnNodeCount: 1,
          unmatchedReturnCount: 2,
          constraintsVerified: {
            graphMutated: "no",
            returnConsumed: "no",
            receiptWritten: "no",
            dispatchTriggered: "no",
            applied: "no",
          },
        }),
      );
      expect(preview.nodePreviews).toEqual([
        expect.objectContaining({
          nodeId: "a",
          taskId: "TASK-A",
          matchStatus: "matched",
          matchedReturnIds: ["return-a.json"],
        }),
        expect.objectContaining({
          nodeId: "b",
          taskId: "TASK-B",
          matchStatus: "missing",
          matchedReturnIds: [],
        }),
        expect.objectContaining({
          nodeId: "c",
          taskId: "TASK-C",
          matchStatus: "declared_return_id",
          matchedReturnIds: ["return-declared.json"],
        }),
      ]);
      expect(preview.unmatchedReturns).toEqual([
        { returnId: "return-missing-task.json", taskId: null, reason: "missing_task_id" },
        { returnId: "return-unmatched.json", taskId: "TASK-X", reason: "no_matching_task_node" },
      ]);
      expect(JSON.parse(readFileSync(graphPath, "utf8"))).toEqual(sourceGraph);
      expect(
        readFileSync(
          path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json"),
          "utf8",
        ),
      ).toContain("TASK-A");
    });
  });
});
