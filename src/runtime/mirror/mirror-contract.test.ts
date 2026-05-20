import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHudStateSnapshot } from "../hud-state-refresh.js";
import { runMirrorObserve } from "./mirror-observe.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("mirror observe contract", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-mirror-contract-"));
    roots.push(root);
    return root;
  }

  function writeRuntimeInputs(root: string): void {
    writeJson(path.join(root, "system", "positions", "state", "main_workspace-main.json"), {
      agentId: "main",
      status: "running",
      currentTask: "DOMAIN10-MIRROR-CONTRACT",
      progressPct: 50,
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    writeJson(path.join(root, "system", "returns", "inbox", "return-a.json"), {
      routing: {
        taskId: "TASK-A",
        sourceRole: "engineering-executive",
        action: "complete",
      },
      outcome: {
        summary: "contract return",
      },
    });
    writeJson(path.join(root, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "task-scheduler-state.json"), {
      enabled: false,
      mode: "observe",
      status: "disabled",
      totalTicks: 0,
      observeOnlyTicks: 0,
      skippedBecauseDisabled: 1,
    });
    writeJson(path.join(root, "system", "kb-index", "index.json"), {
      generatedAt: "2026-05-20T00:01:00.000Z",
      totalItems: 1,
      sourceCaseCount: 1,
      sourceSkillCount: 0,
      keywords: { mirror: ["case-a"] },
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "d9-promote-gate-dryrun-2026-05-20T00-02-00-000Z.json"), {
      generatedAt: "2026-05-20T00:02:00.000Z",
      stats: {
        total: 1,
        byVerdict: {
          FROZEN_BLOCKED: 1,
        },
      },
      constraintsVerified: {
        promoted: "none",
      },
    });
  }

  it("keeps observe-only mirror evidence visible through HUD without applying or promoting", () => {
    const root = workspace();
    writeRuntimeInputs(root);

    const initialHud = writeHudStateSnapshot(root, "2026-05-20T00:03:00.000Z").state;
    expect(initialHud.mirrorObserve.available).toBe(false);

    const mirrorReport = runMirrorObserve(root, {
      generatedAt: "2026-05-20T00:04:00.000Z",
    });
    expect(mirrorReport.mode).toBe("observe-only");
    expect(mirrorReport.constraintsVerified).toEqual({
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      promoted: "none",
      autoLoopTriggered: "no",
      applyPerformed: "no",
    });

    const refreshedHud = writeHudStateSnapshot(root, "2026-05-20T00:05:00.000Z").state;
    expect(refreshedHud.mirrorObserve).toMatchObject({
      available: true,
      mirrorId: mirrorReport.mirrorId,
      generatedAt: "2026-05-20T00:04:00.000Z",
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
        MEMORYWritten: "no",
        ENGINEERING_RULESWritten: "no",
        promoted: "none",
        autoLoopTriggered: "no",
        applyPerformed: "no",
      },
    });
    expect(refreshedHud.watchdogSnapshot.byCondition).toEqual({
      mirrorObserveAttention: 2,
    });
    expect(existsSync(path.join(root, "MEMORY.md"))).toBe(false);
    expect(existsSync(path.join(root, "ENGINEERING_RULES.md"))).toBe(false);
    expect(existsSync(path.join(root, "system", "skill-library", "promoted"))).toBe(false);

    const writtenHud = JSON.parse(
      readFileSync(path.join(root, "runtime", "main", "tmp", "task-hud-state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(writtenHud).toMatchObject({
      mirrorObserve: {
        available: true,
        mirrorId: mirrorReport.mirrorId,
      },
      watchdogSnapshot: {
        byCondition: {
          mirrorObserveAttention: 2,
        },
      },
    });
  });
});
