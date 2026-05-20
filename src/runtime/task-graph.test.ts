import { describe, expect, it } from "vitest";
import {
  reconcileTaskGraph,
  resolveTaskGraphNextRunnable,
  validateTaskGraph,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphStatus,
} from "./task-graph.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function node(nodeId: string, status: TaskGraphStatus, overrides: Partial<TaskGraphNode> = {}): TaskGraphNode {
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

describe("task graph core", () => {
  it("validates a graph and calculates hard-dependency runnable nodes", () => {
    const result = validateTaskGraph(graph({
      nodes: [
        node("a", "completed", { role: "main" }),
        node("b", "planned", { role: "evolution-curator", dependsOn: ["a"] }),
      ],
      edges: [{ from: "a", to: "b", type: "hard" }],
    }));

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.calculatedAggregateStatus).toBe("planned");
    expect(result.calculatedNextRunnable).toEqual(["b"]);
    expect(result.calculatedBlockers).toEqual([]);
  });

  it("reconciles planned nodes to ready when hard dependencies are complete", () => {
    const result = reconcileTaskGraph(graph({
      nodes: [
        node("a", "completed"),
        node("b", "planned", { dependsOn: ["a"] }),
      ],
      edges: [{ from: "a", to: "b", type: "hard" }],
    }), "2026-05-20T00:01:00.000Z");

    expect(result.changedNodeIds).toEqual(["b"]);
    expect(result.blockedNodeIds).toEqual([]);
    expect(result.graph.nodes.find((item) => item.nodeId === "b")?.status).toBe("ready");
    expect(result.graph.aggregateStatus).toBe("ready");
    expect(result.graph.nextRunnable).toEqual(["b"]);
  });

  it("blocks dispatchable nodes when a hard dependency failed", () => {
    const result = reconcileTaskGraph(graph({
      nodes: [
        node("a", "failed"),
        node("b", "planned", { dependsOn: ["a"] }),
      ],
    }));

    expect(result.changedNodeIds).toEqual(["b"]);
    expect(result.blockedNodeIds).toEqual(["b"]);
    expect(result.graph.nodes.find((item) => item.nodeId === "b")?.status).toBe("blocked");
    expect(result.graph.aggregateStatus).toBe("blocked");
    expect(result.graph.nextRunnable).toEqual([]);
    expect(result.graph.blockers).toEqual(expect.arrayContaining([
      { nodeId: "a", reason: "status=failed" },
      { nodeId: "b", reason: "hard dependency a is failed" },
      { nodeId: "b", reason: "status=blocked" },
    ]));
  });

  it("does not let soft or parallel edges block runnable nodes", () => {
    const sourceGraph = graph({
      nodes: [
        node("a", "planned"),
        node("b", "planned"),
        node("c", "ready"),
      ],
      edges: [
        { from: "a", to: "b", type: "soft" },
        { from: "a", to: "c", type: "parallel" },
      ],
    });

    expect(resolveTaskGraphNextRunnable(sourceGraph)).toEqual(["a", "b", "c"]);
  });

  it("reports duplicate ids, missing dependencies, invalid edge refs, and aggregate mismatch", () => {
    const result = validateTaskGraph(graph({
      nodes: [
        node("a", "completed"),
        node("a", "planned", { dependsOn: ["missing"] }),
      ],
      edges: [{ from: "missing-edge", to: "a", type: "hard" }],
      aggregateStatus: "completed",
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.check)).toEqual(expect.arrayContaining([
      "duplicate_node_id",
      "depends_on_reference",
      "edge_reference",
      "aggregate_status",
    ]));
  });
});
