import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMirrorObserveState, runMirrorObserve } from "./mirror-observe.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("mirror observe", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-mirror-observe-"));
    roots.push(root);
    return root;
  }

  function writeRuntimeInputs(root: string): void {
    writeJson(path.join(root, "runtime", "main", "tmp", "task-hud-state.json"), {
      generatedAt: "2026-05-20T00:00:00.000Z",
      globalStatus: {
        status: "attention_required",
        pendingReviewCount: 2,
        alertCount: 0,
      },
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "task-scheduler-state.json"), {
      enabled: false,
      mode: "observe",
      status: "disabled",
      totalTicks: 0,
      observeOnlyTicks: 0,
      skippedBecauseDisabled: 10,
    });
    writeJson(path.join(root, "system", "kb-index", "index.json"), {
      generatedAt: "2026-05-20T00:01:00.000Z",
      totalItems: 14,
      sourceCaseCount: 10,
      sourceSkillCount: 4,
      keywords: { mirror: ["case-a"], observe: ["skill-a"] },
    });
    writeJson(
      path.join(
        root,
        "runtime",
        "main",
        "tmp",
        "d9-promote-gate-dryrun-2026-05-20T00-02-00-000Z.json",
      ),
      {
        generatedAt: "2026-05-20T00:02:00.000Z",
        stats: {
          total: 5,
          byVerdict: {
            FROZEN_BLOCKED: 4,
            BLOCKED: 1,
          },
        },
        constraintsVerified: {
          promoted: "none",
        },
      },
    );
  }

  it("generates observe-only findings from D7/D8/D9 runtime state", () => {
    const root = workspace();
    writeRuntimeInputs(root);

    const report = runMirrorObserve(root, {
      generatedAt: "2026-05-20T10:30:00.000Z",
      outputPath: null,
    });

    expect(report.mode).toBe("observe-only");
    expect(report.observations).toHaveLength(4);
    expect(report.observations.map((item) => item.source)).toEqual([
      "hud",
      "scheduler",
      "kb",
      "promote_gate",
    ]);
    expect(report.stats).toEqual({
      observationCount: 4,
      findingCount: 4,
      bySeverity: {
        attention: 2,
        info: 2,
      },
    });
    expect(report.findings.find((finding) => finding.source === "promote_gate")).toEqual(
      expect.objectContaining({
        severity: "attention",
        deviation: "D9 candidates are not promotable under current gates",
      }),
    );
    expect(report.constraintsVerified).toEqual({
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      promoted: "none",
      autoLoopTriggered: "no",
      applyPerformed: "no",
    });
  });

  it("reports missing runtime inputs as warnings without applying changes", () => {
    const report = runMirrorObserve(workspace(), {
      generatedAt: "2026-05-20T10:31:00.000Z",
      outputPath: null,
    });

    expect(report.stats.bySeverity).toEqual({ warning: 4 });
    expect(
      report.findings.every((finding) =>
        finding.suggestedAction.includes("do not auto-apply changes from mirror observe"),
      ),
    ).toBe(true);
    expect(report.constraintsVerified.applyPerformed).toBe("no");
  });

  it("writes only the mirror observe report when output path is enabled", () => {
    const root = workspace();
    writeRuntimeInputs(root);
    const outputPath = path.join(root, "runtime", "main", "tmp", "mirror-observe-test.json");

    const report = runMirrorObserve(root, {
      generatedAt: "2026-05-20T10:32:00.000Z",
      outputPath,
    });
    const state = readMirrorObserveState(root);

    expect(existsSync(outputPath)).toBe(true);
    expect(state).toEqual(
      expect.objectContaining({
        available: true,
        reportPath: "runtime/main/tmp/mirror-observe-test.json",
        mirrorId: report.mirrorId,
      }),
    );
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(
      expect.objectContaining({
        mirrorId: report.mirrorId,
        mode: "observe-only",
        verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
      }),
    );
    expect(existsSync(path.join(root, "MEMORY.md"))).toBe(false);
    expect(existsSync(path.join(root, "ENGINEERING_RULES.md"))).toBe(false);
  });
});
