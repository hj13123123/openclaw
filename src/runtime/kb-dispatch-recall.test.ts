import { describe, expect, it } from "vitest";
import {
  buildDispatchRecallQuery,
  dispatchRecallPreviewConstraints,
  dispatchRecallPreviewConstraintsValid,
  normalizeDispatchRecallPreviewLimit,
  normalizeDispatchRecallResultLimit,
} from "./kb-dispatch-recall.js";
import type { RuntimeLoopPreflightDispatchPlanEntry } from "./runtime-loop.js";
import type { TaskRecord } from "./task-state-machine.js";

function candidate(
  overrides: Partial<RuntimeLoopPreflightDispatchPlanEntry> = {},
): RuntimeLoopPreflightDispatchPlanEntry {
  return {
    taskId: "TASK-A",
    dispatchTarget: "engineering-executive",
    policyDecision: "allow",
    riskLevel: "L1",
    would_dispatch: false,
    policy_eligible: true,
    would_dispatch_if_apply_enabled: true,
    blocked_reasons: [],
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "TASK-A",
    status: "queued",
    sourceRole: "main",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    summary: "dispatch summary",
    metadata: {
      title: "Build HUD recall",
      description: "Use semantic evidence",
      blank: "   ",
    },
    ...overrides,
  };
}

describe("KB dispatch recall runtime helpers", () => {
  it("normalizes preview and recall limits", () => {
    expect(normalizeDispatchRecallPreviewLimit(undefined)).toBe(5);
    expect(normalizeDispatchRecallPreviewLimit(Number.NaN)).toBe(5);
    expect(normalizeDispatchRecallPreviewLimit(-2)).toBe(0);
    expect(normalizeDispatchRecallPreviewLimit(12.8)).toBe(10);
    expect(normalizeDispatchRecallResultLimit(undefined)).toBe(3);
    expect(normalizeDispatchRecallResultLimit(Number.NaN)).toBe(3);
    expect(normalizeDispatchRecallResultLimit(0)).toBe(1);
    expect(normalizeDispatchRecallResultLimit(12.8)).toBe(10);
  });

  it("builds dispatch recall queries from task state and candidate policy context", () => {
    expect(buildDispatchRecallQuery(candidate(), task())).toBe(
      [
        "TASK-A",
        "dispatch summary",
        "main",
        "engineering-executive",
        "allow",
        "L1",
        "Build HUD recall",
        "Use semantic evidence",
      ].join("\n"),
    );
  });

  it("falls back to the candidate task id when task state is missing", () => {
    expect(buildDispatchRecallQuery(candidate({ taskId: "TASK-FALLBACK" }), undefined)).toBe(
      ["TASK-FALLBACK", "engineering-executive", "allow", "L1"].join("\n"),
    );
  });

  it("validates observe-only preview constraints", () => {
    const constraints = dispatchRecallPreviewConstraints("yes");
    expect(dispatchRecallPreviewConstraintsValid({ constraintsVerified: constraints })).toBe(true);
    expect(
      dispatchRecallPreviewConstraintsValid({
        constraintsVerified: { ...constraints, dispatchTriggered: "yes" } as never,
      }),
    ).toBe(false);
  });
});
