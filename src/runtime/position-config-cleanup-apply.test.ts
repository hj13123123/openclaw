import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
  applyPositionConfigCleanup,
} from "./position-config-cleanup-apply.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-cleanup-apply-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writePositionsConfig(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, ".claw", "positions.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

function readPositionsConfig(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

describe("position config cleanup apply", () => {
  it("requires an exact confirmation string before evaluating writes", () =>
    withTempRoot((workspaceRoot) => {
      const filePath = writePositionsConfig(workspaceRoot);

      expect(
        applyPositionConfigCleanup(workspaceRoot, {
          requestedAt: "2026-05-26T12:00:00.000Z",
          confirm: "apply",
        }),
      ).toMatchObject({
        status: "invalid_request",
        applyBlockedReason: "confirmation_required",
        constraintsVerified: {
          positionConfigWritten: "no",
          applied: "no",
        },
      });
      expect(JSON.stringify(readPositionsConfig(filePath))).toContain("evolution-curator");
    }));

  it("does not write when the cleanup gate is frozen-blocked", () =>
    withTempRoot((workspaceRoot) => {
      const filePath = writePositionsConfig(workspaceRoot);
      writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "frozen flag ACTIVE\n", "utf8");

      expect(
        applyPositionConfigCleanup(workspaceRoot, {
          requestedAt: "2026-05-26T12:01:00.000Z",
          confirm: POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
        }),
      ).toMatchObject({
        status: "blocked",
        readyForControlledApply: false,
        applyBlockedReason: "frozen",
        removals: [
          { positionId: "evolution-curator", target: "positionModelMapping" },
          { positionId: "evolution-curator", target: "positionOverrides" },
        ],
        constraintsVerified: {
          positionConfigWritten: "no",
          applied: "no",
        },
      });
      expect(JSON.stringify(readPositionsConfig(filePath))).toContain("evolution-curator");
    }));

  it("supports dry-run without writing when the cleanup gate is ready", () =>
    withTempRoot((workspaceRoot) => {
      const filePath = writePositionsConfig(workspaceRoot);

      expect(
        applyPositionConfigCleanup(workspaceRoot, {
          requestedAt: "2026-05-26T12:02:00.000Z",
          confirm: POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
          dryRun: true,
        }),
      ).toMatchObject({
        status: "dry_run",
        readyForControlledApply: true,
        removals: [
          { positionId: "evolution-curator", target: "positionModelMapping" },
          { positionId: "evolution-curator", target: "positionOverrides" },
        ],
        constraintsVerified: {
          positionConfigWritten: "no",
          applied: "no",
        },
      });
      expect(JSON.stringify(readPositionsConfig(filePath))).toContain("evolution-curator");
    }));

  it("removes only stale configured-only entries when the gate is ready", () =>
    withTempRoot((workspaceRoot) => {
      const filePath = writePositionsConfig(workspaceRoot);

      expect(
        applyPositionConfigCleanup(workspaceRoot, {
          requestedAt: "2026-05-26T12:03:00.000Z",
          confirm: POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
        }),
      ).toMatchObject({
        status: "applied",
        readyForControlledApply: true,
        constraintsVerified: {
          positionConfigWritten: "yes",
          applied: "yes",
        },
      });

      const written = readPositionsConfig(filePath);
      expect(JSON.stringify(written)).not.toContain("evolution-curator");
      expect(written.enabledPositions).toEqual([
        "main",
        "engineering-executive",
        "front-end-executive",
        "patrol",
      ]);
    }));
});
