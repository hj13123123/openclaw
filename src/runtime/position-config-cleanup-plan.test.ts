import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPositionConfigCleanupPlan } from "./position-config-cleanup-plan.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-cleanup-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writePositionsConfig(workspaceRoot: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, ".claw", "positions.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("position config cleanup plan", () => {
  it("plans removal for disabled non-V2 configured positions without mutating config", () =>
    withTempRoot((workspaceRoot) => {
      writePositionsConfig(workspaceRoot, {
        enabledPositions: ["main", "engineering-executive", "front-end-executive", "patrol"],
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

      expect(
        buildPositionConfigCleanupPlan(workspaceRoot, {
          plannedAt: "2026-05-26T10:10:00.000Z",
        }),
      ).toEqual({
        mode: "observe-only",
        dryRun: true,
        plannedAt: "2026-05-26T10:10:00.000Z",
        status: "ready",
        configPath: ".claw/positions.json",
        available: true,
        officialPositionIds: ["main", "engineering-executive", "front-end-executive", "patrol"],
        enabledPositions: ["engineering-executive", "front-end-executive", "main", "patrol"],
        staleConfiguredOnlyPositions: ["evolution-curator"],
        retainedConfiguredOnlyOfficialPositions: [],
        nonV2EnabledPositions: [],
        removalStepCount: 2,
        readyStepCount: 2,
        blockedStepCount: 0,
        readyForControlledApply: true,
        blockedReasons: [],
        steps: [
          {
            stepId: "remove-evolution-curator-positionModelMapping",
            order: 1,
            positionId: "evolution-curator",
            target: "positionModelMapping",
            action: "remove-configured-only-entry",
            ready: true,
            blockedReasons: [],
            summary: "Remove disabled non-V2 position entry from positionModelMapping.",
          },
          {
            stepId: "remove-evolution-curator-positionOverrides",
            order: 2,
            positionId: "evolution-curator",
            target: "positionOverrides",
            action: "remove-configured-only-entry",
            ready: true,
            blockedReasons: [],
            summary: "Remove disabled non-V2 position entry from positionOverrides.",
          },
        ],
        constraintsVerified: {
          readOnly: "yes",
          positionConfigWritten: "no",
          agentsListMutated: "no",
          sessionsSent: "no",
          applied: "no",
        },
      });
    }));

  it("retains disabled official position config for manual operator intent", () =>
    withTempRoot((workspaceRoot) => {
      writePositionsConfig(workspaceRoot, {
        enabledPositions: ["main"],
        positionModelMapping: {
          main: {},
          patrol: {},
        },
        positionOverrides: {
          main: {},
          patrol: {},
        },
      });

      expect(buildPositionConfigCleanupPlan(workspaceRoot)).toMatchObject({
        status: "clean",
        staleConfiguredOnlyPositions: [],
        retainedConfiguredOnlyOfficialPositions: ["patrol"],
        removalStepCount: 0,
        readyForControlledApply: false,
      });
    }));

  it("blocks cleanup when a non-V2 position is enabled", () =>
    withTempRoot((workspaceRoot) => {
      writePositionsConfig(workspaceRoot, {
        enabledPositions: ["main", "evolution-curator"],
        positionModelMapping: {
          main: {},
          "evolution-curator": {},
        },
        positionOverrides: {
          main: {},
          "evolution-curator": {},
        },
      });

      expect(buildPositionConfigCleanupPlan(workspaceRoot)).toMatchObject({
        status: "blocked",
        staleConfiguredOnlyPositions: [],
        nonV2EnabledPositions: ["evolution-curator"],
        readyForControlledApply: false,
        blockedReasons: ["non_v2_position_enabled"],
      });
    }));

  it("fails soft when the positions config is missing", () =>
    withTempRoot((workspaceRoot) => {
      expect(buildPositionConfigCleanupPlan(workspaceRoot)).toMatchObject({
        status: "missing",
        available: false,
        readyForControlledApply: false,
        blockedReasons: ["positions_config_missing"],
        constraintsVerified: {
          readOnly: "yes",
          positionConfigWritten: "no",
          agentsListMutated: "no",
          sessionsSent: "no",
          applied: "no",
        },
      });
    }));
});
