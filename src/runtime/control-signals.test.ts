import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_SIGNALS_PENDING_RELATIVE_PATH, scanControlSignals } from "./control-signals.js";

let tempRoots: string[] = [];

function makeWorkspace(): string {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-control-signals-"));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pendingPath(workspaceRoot: string, fileName: string): string {
  return path.join(workspaceRoot, CONTROL_SIGNALS_PENDING_RELATIVE_PATH, fileName);
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("control signal scanner", () => {
  it("scans valid pending control signals without mutating runtime state", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(pendingPath(workspaceRoot, "ctrl-task-a-pause.json"), {
      signalId: "ctrl-task-a-pause",
      taskId: "TASK-A",
      targetRole: "engineering-executive",
      action: "pause",
      status: "pending",
      reason: "operator pause",
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
    });

    const result = scanControlSignals(workspaceRoot, {
      scannedAt: "2026-05-25T00:10:00.000Z",
      now: new Date("2026-05-25T00:10:00.000Z"),
    });

    expect(result.status).toBe("ok");
    expect(result.pendingCount).toBe(1);
    expect(result.expiredCount).toBe(1);
    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.byRole).toEqual([{ role: "engineering-executive", count: 1 }]);
    expect(result.byAction).toEqual([{ action: "pause", count: 1 }]);
    expect(result.signals[0]).toEqual(
      expect.objectContaining({
        signalId: "ctrl-task-a-pause",
        taskId: "TASK-A",
        expired: true,
        valid: true,
      }),
    );
    expect(result.constraintsVerified).toEqual({
      readOnly: "yes",
      signalWritten: "no",
      taskGraphMutated: "no",
      sessionsSent: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    });
  });

  it("requires taskId and does not accept role-only control signals", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(pendingPath(workspaceRoot, "ctrl-role-only.json"), {
      signalId: "ctrl-role-only",
      targetRole: "engineering-executive",
      action: "cancel",
      status: "pending",
    });

    const result = scanControlSignals(workspaceRoot, {
      scannedAt: "2026-05-25T00:00:00.000Z",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(result.pendingCount).toBe(1);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        file: "ctrl-role-only.json",
        field: "taskId",
        code: "missing_field",
      }),
    ]);
  });

  it("honors the frozen gate before reading pending signals", () => {
    const workspaceRoot = makeWorkspace();
    writeFileSync(path.join(workspaceRoot, "HEARTBEAT.md"), "frozen flag ACTIVE\n", "utf8");
    writeJson(pendingPath(workspaceRoot, "ctrl-task-a-pause.json"), {
      signalId: "ctrl-task-a-pause",
      taskId: "TASK-A",
      targetRole: "engineering-executive",
      action: "pause",
      status: "pending",
    });

    const result = scanControlSignals(workspaceRoot, {
      scannedAt: "2026-05-25T00:00:00.000Z",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(result.status).toBe("frozen");
    expect(result.frozen).toBe(true);
    expect(result.g2Approved).toBe(false);
    expect(result.pendingCount).toBe(0);
    expect(result.message).toContain("frozen flag is active");
  });

  it("allows observe-only scanning when frozen has a G2 approval marker", () => {
    const workspaceRoot = makeWorkspace();
    writeFileSync(path.join(workspaceRoot, "SESSION_SUMMARY.md"), "frozen flag active\n", "utf8");
    writeJson(path.join(workspaceRoot, "runtime/main/tmp/G2-APPROVED-test.json"), {
      approval: "G2",
    });
    writeJson(pendingPath(workspaceRoot, "ctrl-task-a-interrupt.json"), {
      signalId: "ctrl-task-a-interrupt",
      taskId: "TASK-A",
      targetRole: "front-end-executive",
      action: "interrupt",
      status: "acknowledged",
    });

    const result = scanControlSignals(workspaceRoot, {
      targetRole: "front-end-executive",
      scannedAt: "2026-05-25T00:00:00.000Z",
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(result.status).toBe("ok");
    expect(result.frozen).toBe(true);
    expect(result.g2Approved).toBe(true);
    expect(result.pendingCount).toBe(1);
    expect(result.signals[0]?.targetRole).toBe("front-end-executive");
  });
});
