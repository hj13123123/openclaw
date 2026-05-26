import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePositionConfigCleanupGate } from "./position-config-cleanup-gate.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-cleanup-gate-"));
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

function writePositionsConfig(workspaceRoot: string, enabledPositions: string[]): void {
  writeJson(workspaceRoot, ".claw/positions.json", {
    enabledPositions,
    positionModelMapping: {
      main: {},
      "engineering-executive": {},
      "front-end-executive": {},
      patrol: {},
      "evolution-curator": {},
    },
    positionOverrides: {
      main: {},
      "engineering-executive": {},
      "front-end-executive": {},
      patrol: {},
      "evolution-curator": {},
    },
  });
}

describe("position config cleanup gate", () => {
  it("reports ready cleanup plans as frozen-blocked when the frozen flag is active", () =>
    withTempRoot((workspaceRoot) => {
      writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "frozen flag ACTIVE\n", "utf8");
      writePositionsConfig(workspaceRoot, [
        "main",
        "engineering-executive",
        "front-end-executive",
        "patrol",
      ]);

      expect(
        evaluatePositionConfigCleanupGate(workspaceRoot, {
          checkedAt: "2026-05-26T11:10:00.000Z",
        }),
      ).toEqual({
        mode: "observe-only",
        checkedAt: "2026-05-26T11:10:00.000Z",
        status: "ready",
        frozen: true,
        g2Approved: false,
        readyForControlledApply: false,
        applyBlockedReason: "frozen",
        nextAction: "await_unfreeze_or_human_approval",
        cleanup: {
          staleConfiguredOnlyCount: 1,
          removalStepCount: 2,
          readyStepCount: 2,
          blockedStepCount: 0,
        },
        constraintsVerified: {
          readOnly: "yes",
          positionConfigWritten: "no",
          agentsListMutated: "no",
          sessionsSent: "no",
          applied: "no",
        },
      });
    }));

  it("allows a ready cleanup plan when frozen has a G2 approval marker", () =>
    withTempRoot((workspaceRoot) => {
      writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "frozen flag ACTIVE\n", "utf8");
      writeJson(workspaceRoot, "runtime/main/tmp/G2-APPROVED-position-cleanup.json", {
        approval: "G2",
      });
      writePositionsConfig(workspaceRoot, [
        "main",
        "engineering-executive",
        "front-end-executive",
        "patrol",
      ]);

      expect(evaluatePositionConfigCleanupGate(workspaceRoot)).toMatchObject({
        status: "ready",
        frozen: true,
        g2Approved: true,
        readyForControlledApply: true,
        applyBlockedReason: null,
        nextAction: "controlled_apply_can_be_planned",
      });
    }));

  it("reports clean configs as no-action", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(workspaceRoot, ".claw/positions.json", {
        enabledPositions: ["main"],
        positionModelMapping: { main: {} },
        positionOverrides: { main: {} },
      });

      expect(evaluatePositionConfigCleanupGate(workspaceRoot)).toMatchObject({
        status: "empty",
        frozen: false,
        readyForControlledApply: false,
        applyBlockedReason: null,
        nextAction: "no_action",
        cleanup: {
          staleConfiguredOnlyCount: 0,
          removalStepCount: 0,
          readyStepCount: 0,
          blockedStepCount: 0,
        },
      });
    }));

  it("blocks when cleanup plan itself is blocked", () =>
    withTempRoot((workspaceRoot) => {
      writePositionsConfig(workspaceRoot, ["main", "evolution-curator"]);

      expect(evaluatePositionConfigCleanupGate(workspaceRoot)).toMatchObject({
        status: "blocked",
        readyForControlledApply: false,
        applyBlockedReason: "cleanup_plan_blocked",
        nextAction: "resolve_blockers",
      });
    }));
});
