import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditPositionConfig } from "./position-config-audit.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-audit-"));
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

describe("position config audit", () => {
  it("reports configured-only legacy positions without mutating config", () =>
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
        auditPositionConfig(workspaceRoot, {
          auditedAt: "2026-05-26T09:30:00.000Z",
        }),
      ).toMatchObject({
        mode: "observe-only",
        available: true,
        enabledPositions: ["engineering-executive", "front-end-executive", "main", "patrol"],
        officialPositionIds: ["main", "engineering-executive", "front-end-executive", "patrol"],
        nonV2EnabledPositions: [],
        configuredOnlyPositions: ["evolution-curator"],
        missingEnabledModelMappings: [],
        missingEnabledOverrides: [],
        positionModelMappingCount: 5,
        positionOverrideCount: 5,
        warnings: ["configured_only_positions_present"],
        constraintsVerified: {
          readOnly: "yes",
          positionConfigWritten: "no",
          agentsListMutated: "no",
          sessionsSent: "no",
          applied: "no",
        },
      });
    }));

  it("fails soft when the positions config is missing", () =>
    withTempRoot((workspaceRoot) => {
      expect(auditPositionConfig(workspaceRoot)).toMatchObject({
        available: false,
        enabledPositions: [],
        warnings: ["positions_config_missing"],
      });
    }));
});
