import { describe, expect, it } from "vitest";
import { generateHudState, normalizeHudAgentStatus, type HudPendingReturnItem, type HudTaskGraphItem } from "./hud-state.js";

const generatedAt = "2026-05-20T00:00:00.000Z";

function pendingReturn(overrides: Partial<HudPendingReturnItem> = {}): HudPendingReturnItem {
  return {
    returnId: "return-a.json",
    taskId: "TASK-A",
    sourceRole: "engineering-executive",
    action: "complete",
    status: "pending",
    createdAt: generatedAt,
    needsReview: true,
    summary: "pending return",
    ...overrides,
  };
}

function taskGraph(overrides: Partial<HudTaskGraphItem> = {}): HudTaskGraphItem {
  return {
    graphId: "graph-a",
    title: "Graph A",
    aggregateStatus: "running",
    nodeSummary: {
      total: 2,
      completed: 1,
      running: 1,
      ready: 0,
      planned: 0,
      blocked: 0,
      failed: 0,
    },
    blockers: [],
    nextRunnable: [],
    lastValidatedAt: null,
    validationSeverity: null,
    ...overrides,
  };
}

describe("HUD state core", () => {
  it("normalizes agent status aliases", () => {
    expect(normalizeHudAgentStatus("available")).toBe("completed");
    expect(normalizeHudAgentStatus("in_progress")).toBe("running");
    expect(normalizeHudAgentStatus("blocked")).toBe("attention_required");
    expect(normalizeHudAgentStatus("error")).toBe("failed");
    expect(normalizeHudAgentStatus(null)).toBe("unknown");
  });

  it("builds default agent groups and derives healthy counters", () => {
    const state = generateHudState({
      generatedAt,
      positionStatesByAgentId: {
        main: { status: "idle", progress: "50", currentTask: "TASK-MAIN" },
        "engineering-executive": { status: "running", progressPct: 30 },
        "front-end-executive": { status: "completed", progressPct: 100 },
      },
    });

    expect(state.generator).toBe("runtime-hud-state");
    expect(state.agentGroups).toHaveLength(3);
    expect(state.globalStatus).toMatchObject({
      status: "healthy",
      runningCount: 1,
      completedCount: 2,
      failedCount: 0,
      alertCount: 0,
    });
    expect(state.agentGroups.find((agent) => agent.agentId === "main")).toMatchObject({
      status: "completed",
      currentTask: "TASK-MAIN",
      progressPct: 50,
      progressDerivation: "position-state",
    });
  });

  it("marks pending returns as attention_required", () => {
    const state = generateHudState({
      generatedAt,
      positionStatesByAgentId: {
        main: { status: "running" },
      },
      pendingReturnItems: [pendingReturn()],
    });

    expect(state.globalStatus.status).toBe("attention_required");
    expect(state.globalStatus.pendingReviewCount).toBe(1);
    expect(state.returnInbox.pendingItems[0]?.returnId).toBe("return-a.json");
  });

  it("marks warnings or unknown agent state as degraded", () => {
    const state = generateHudState({
      generatedAt,
      warnings: ["positions state directory missing"],
    });

    expect(state.globalStatus.status).toBe("degraded");
    expect(state.warnings).toEqual(["positions state directory missing"]);
  });

  it("summarizes task graph totals while capping visible items", () => {
    const state = generateHudState({
      generatedAt,
      taskGraphItems: [
        taskGraph({ graphId: "graph-a", aggregateStatus: "running" }),
        taskGraph({ graphId: "graph-b", aggregateStatus: "blocked" }),
        taskGraph({ graphId: "graph-c", aggregateStatus: "completed" }),
        taskGraph({ graphId: "graph-d", aggregateStatus: "planned" }),
        taskGraph({ graphId: "graph-e", aggregateStatus: "ready" }),
        taskGraph({ graphId: "graph-f", aggregateStatus: "running" }),
      ],
    });

    expect(state.taskGraphs.total).toBe(6);
    expect(state.taskGraphs.active).toBe(5);
    expect(state.taskGraphs.blocked).toBe(1);
    expect(state.taskGraphs.items.map((item) => item.graphId)).toEqual(["graph-a", "graph-b", "graph-c", "graph-d", "graph-e"]);
  });

  it("carries mirror observe visibility without changing global health", () => {
    const state = generateHudState({
      generatedAt,
      mirrorObserve: {
        available: true,
        reportPath: "runtime/main/tmp/mirror-observe-a.json",
        mirrorId: "mirror-a",
        generatedAt,
        mode: "observe-only",
        stats: {
          observationCount: 4,
          findingCount: 4,
          bySeverity: {
            attention: 2,
            info: 2,
          },
        },
        constraintsVerified: {
          promoted: "none",
          applyPerformed: "no",
        },
        verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
      },
    });

    expect(state.globalStatus.status).toBe("degraded");
    expect(state.mirrorObserve).toMatchObject({
      available: true,
      reportPath: "runtime/main/tmp/mirror-observe-a.json",
      mirrorId: "mirror-a",
      mode: "observe-only",
      constraintsVerified: {
        promoted: "none",
        applyPerformed: "no",
      },
    });
  });
});
