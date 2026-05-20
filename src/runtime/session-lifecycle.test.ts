import { describe, expect, it } from "vitest";
import {
  generateSessionLifecycleReport,
  type GenerateSessionLifecycleInput,
  type LifecycleTaskNode,
} from "./session-lifecycle.js";

const generatedAt = "2026-05-20T00:00:00.000Z";

function taskNode(overrides: Partial<LifecycleTaskNode> = {}): LifecycleTaskNode {
  return {
    graphId: "graph-a",
    nodeId: "node-a",
    taskId: "TASK-A",
    role: "engineering-executive",
    status: "running",
    sessionKey: "agent:engineering-executive:main",
    runId: null,
    ...overrides,
  };
}

function report(input: Omit<GenerateSessionLifecycleInput, "generatedAt" | "lifecycleId">) {
  return generateSessionLifecycleReport({
    ...input,
    generatedAt,
    lifecycleId: "slc-test",
  });
}

describe("session lifecycle core", () => {
  it("applies pause only through exact taskId match", () => {
    const result = report({
      taskGraphNodes: [
        taskNode({ nodeId: "node-a", taskId: "TASK-A", role: "engineering-executive", status: "running" }),
        taskNode({
          nodeId: "node-b",
          taskId: "TASK-B",
          role: "engineering-executive",
          status: "running",
          sessionKey: "agent:engineering-executive:secondary",
        }),
      ],
      controlSignals: [{
        signalId: "sig-pause-a",
        taskId: "TASK-A",
        targetRole: "engineering-executive",
        action: "pause",
        status: "acknowledged",
      }],
    });

    expect(result.sessions.find((session) => session.taskId === "TASK-A")?.lifecycleState).toBe("paused");
    expect(result.sessions.find((session) => session.taskId === "TASK-B")?.lifecycleState).toBe("running");
    expect(result.summary.ambiguousSignals).toEqual([]);
  });

  it("does not fallback to targetRole when taskId is missing", () => {
    const result = report({
      taskGraphNodes: [taskNode({ status: "running" })],
      controlSignals: [{
        signalId: "sig-missing-task",
        targetRole: "engineering-executive",
        action: "pause",
        status: "acknowledged",
      }],
    });

    expect(result.sessions[0]?.lifecycleState).toBe("running");
    expect(result.sessions[0]?.derivedFrom.controlSignal).toBeNull();
    expect(result.summary.ambiguousSignals).toEqual([expect.objectContaining({
      signalId: "sig-missing-task",
      reason: "taskId missing, cannot match to specific task node",
    })]);
  });

  it("records duplicate taskId signals as ambiguous without changing state", () => {
    const result = report({
      taskGraphNodes: [taskNode({ status: "running" })],
      controlSignals: [
        {
          signalId: "sig-pause-a",
          taskId: "TASK-A",
          action: "pause",
          status: "acknowledged",
        },
        {
          signalId: "sig-cancel-a",
          taskId: "TASK-A",
          action: "cancel",
          status: "executed",
        },
      ],
    });

    expect(result.sessions[0]?.lifecycleState).toBe("running");
    expect(result.sessions[0]?.derivedFrom.controlSignal).toBeNull();
    expect(result.summary.ambiguousSignals).toHaveLength(2);
    expect(result.summary.ambiguousSignals.map((signal) => signal.reason)).toEqual([
      "multiple control signals share the same taskId",
      "multiple control signals share the same taskId",
    ]);
  });

  it("keeps unknown taskId signals ambiguous and inert", () => {
    const result = report({
      taskGraphNodes: [taskNode({ taskId: "TASK-A", status: "ready" })],
      controlSignals: [{
        signalId: "sig-cancel-b",
        taskId: "TASK-B",
        action: "cancel",
        status: "executed",
      }],
    });

    expect(result.sessions[0]?.lifecycleState).toBe("active");
    expect(result.summary.ambiguousSignals).toEqual([expect.objectContaining({
      signalId: "sig-cancel-b",
      reason: "taskId has no matching lifecycle task node",
    })]);
  });

  it("applies lifecycle priority across lease, control, recovery, and session size signals", () => {
    const result = report({
      taskGraphNodes: [taskNode({ status: "completed" })],
      controlSignals: [{
        signalId: "sig-pause-a",
        taskId: "TASK-A",
        action: "pause",
        status: "acknowledged",
      }],
      recoveryDecisions: [{
        candidateId: "recov-a",
        nodeId: "node-a",
        action: "resume",
        status: "applied",
      }],
      sessionSizesBySessionKey: {
        "agent:engineering-executive:main": {
          lines: 2000,
          bytesEstimate: 100,
          thresholdExceeded: true,
        },
      },
      leaseStatesBySessionKey: {
        "agent:engineering-executive:main": {
          leaseActive: false,
          lastProgressAt: null,
          lifecycleState: "hard_stop",
        },
      },
    });

    expect(result.sessions[0]?.lifecycleState).toBe("hard_stop");
    expect(result.sessions[0]?.statePriority).toBe(1);
    expect(result.sessions[0]?.derivedFrom.recoveryDecision).toEqual(expect.objectContaining({ candidateId: "recov-a" }));
    expect(result.summary.leaseLevelStates).toEqual({
      stalled: "lease-level (R9)",
      hard_stop: "lease-level (R9)",
    });
  });
});
