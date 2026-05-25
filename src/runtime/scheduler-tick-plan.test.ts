import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSchedulerTickPlan,
  SCHEDULER_MARKER_RELATIVE_PATH,
  SCHEDULER_STATE_RELATIVE_PATH,
} from "./scheduler-tick-plan.js";

let tempRoots: string[] = [];

function makeWorkspace(): string {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-scheduler-tick-plan-"));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("scheduler tick planner", () => {
  it("defaults to disabled without writing marker or state files", () => {
    const workspaceRoot = makeWorkspace();

    const result = buildSchedulerTickPlan(workspaceRoot, {
      plannedAt: "2026-05-26T01:00:00.000Z",
    });

    expect(result).toEqual(
      expect.objectContaining({
        mode: "observe-only",
        plannedAt: "2026-05-26T01:00:00.000Z",
        decision: "disabled",
        enabled: false,
        markerMode: "observe",
        totalTicks: 0,
        nextTickIndex: null,
      }),
    );
    expect(result.constraintsVerified).toEqual({
      readOnly: "yes",
      markerWritten: "no",
      stateWritten: "no",
      eventEmitted: "no",
      scriptInvoked: "no",
      childProcessSpawned: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    });
    expect(existsSync(path.join(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH))).toBe(false);
    expect(existsSync(path.join(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH))).toBe(false);
  });

  it("keeps enabled observe mode as observe-only", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH, {
      enabled: true,
      mode: "observe",
    });
    writeJson(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH, {
      status: "idle",
      running: false,
      totalTicks: 2,
    });

    const result = buildSchedulerTickPlan(workspaceRoot);

    expect(result.decision).toBe("observe_only");
    expect(result.reason).toBe("scheduler marker is enabled in observe mode");
    expect(result.totalTicks).toBe(2);
    expect(result.nextTickIndex).toBeNull();
  });

  it("does not plan a tick when scheduler state is already running", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH, {
      enabled: true,
      mode: "apply",
    });
    writeJson(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH, {
      status: "running",
      running: true,
      totalTicks: 3,
    });

    const result = buildSchedulerTickPlan(workspaceRoot);

    expect(result.decision).toBe("already_running");
    expect(result.running).toBe(true);
    expect(result.nextTickIndex).toBeNull();
  });

  it("honors per-task maxTicks before apply mode can tick again", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH, {
      enabled: true,
      mode: "apply",
    });
    writeJson(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH, {
      status: "idle",
      running: false,
      totalTicks: 2,
    });
    writeJson(workspaceRoot, "runtime/scheduler/scheduler-policy.json", {
      policyVersion: "test",
      tickIntervalMs: 5000,
      maxTicksPerApply: 5,
      tickTimeoutMs: 120000,
      cooldownMs: 1000,
      taskSelectionRule: "lifo",
      failBehavior: "stop",
      fallbackToOldTrigger: true,
    });
    const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "TASK-A",
        status: "running",
        maxTicks: 2,
        updatedAt: "2026-05-26T01:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const result = buildSchedulerTickPlan(workspaceRoot);

    expect(result.decision).toBe("max_ticks_reached");
    expect(result.maxTicks).toEqual({
      effective: 2,
      reason: "per_task_max_ticks",
      global: 5,
      perTask: 2,
      perTaskId: "TASK-A",
      reached: true,
    });
  });

  it("dry-runs the legacy apply spawn decision without invoking the script", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(workspaceRoot, SCHEDULER_MARKER_RELATIVE_PATH, {
      enabled: true,
      mode: "apply",
    });
    writeJson(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH, {
      status: "idle",
      running: false,
      totalTicks: 1,
    });
    writeJson(workspaceRoot, "runtime/scheduler/scheduler-policy.json", {
      policyVersion: "test",
      tickIntervalMs: 5000,
      maxTicksPerApply: 5,
      tickTimeoutMs: 120000,
      cooldownMs: 1000,
      taskSelectionRule: "lifo",
      failBehavior: "stop",
      fallbackToOldTrigger: true,
    });

    const result = buildSchedulerTickPlan(workspaceRoot);

    expect(result.decision).toBe("would_spawn_apply_tick");
    expect(result.nextTickIndex).toBe(2);
    expect(result.sourceFiles.tickScriptExists).toBe(false);
    expect(result.constraintsVerified.scriptInvoked).toBe("no");
    expect(result.constraintsVerified.childProcessSpawned).toBe("no");
    expect(result.constraintsVerified.applied).toBe("no");
  });
});
