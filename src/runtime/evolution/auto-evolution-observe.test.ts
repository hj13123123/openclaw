import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAutoEvolutionObserve } from "./auto-evolution-observe.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("auto-evolution observe planner", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-auto-evolution-observe-"));
    roots.push(root);
    return root;
  }

  function writeRuntimeEvidence(root: string): void {
    writeJson(path.join(root, "runtime", "main", "tmp", "mirror-observe-2026-05-20T00-01-00-000Z.json"), {
      generatedAt: "2026-05-20T00:01:00.000Z",
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
        promoted: "none",
        applyPerformed: "no",
      },
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "d9-promote-gate-dryrun-2026-05-20T00-02-00-000Z.json"), {
      generatedAt: "2026-05-20T00:02:00.000Z",
      mode: "dry-run",
      stats: {
        total: 2,
        byVerdict: {
          FROZEN_BLOCKED: 1,
          READY_FOR_PROMOTE_GATE: 1,
        },
      },
      constraintsVerified: {
        promoted: "none",
      },
    });
    writeJson(path.join(root, "system", "kb-index", "index.json"), {
      generatedAt: "2026-05-20T00:03:00.000Z",
      totalItems: 5,
      sourceCaseCount: 3,
      sourceSkillCount: 2,
      keywords: { mirror: ["case-a"] },
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "task-hud-state.json"), {
      generatedAt: "2026-05-20T00:04:00.000Z",
      watchdogSnapshot: {
        totalAlerts: 2,
        byCondition: {
          mirrorObserveAttention: 2,
        },
      },
    });
    writeJson(path.join(root, "runtime", "main", "tmp", "runtime-loop-state.json"), {
      mode: "observe",
      warnings: ["schedulerPolicy.maxDispatchesPerTick is non-zero, dispatch still suppressed by observe-only loop"],
      scheduler: {
        enabled: false,
        schedulerPolicy: {
          enableContinuousApply: false,
        },
      },
    });
  }

  it("plans recommendations from runtime evidence without applying or promoting", () => {
    const root = workspace();
    writeRuntimeEvidence(root);

    const report = runAutoEvolutionObserve(root, {
      generatedAt: "2026-05-20T00:05:00.000Z",
      outputPath: null,
    });

    expect(report.mode).toBe("observe-only");
    expect(report.stats).toEqual({
      totalSuggestions: 4,
      byPriority: {
        P1: 3,
        P2: 1,
      },
      bySource: {
        mirror: 1,
        promote_gate: 1,
        hud: 1,
        runtime_loop: 1,
      },
    });
    expect(report.suggestions.map((item) => item.source)).toEqual(["mirror", "promote_gate", "hud", "runtime_loop"]);
    expect(report.suggestions.every((item) => item.allowedAction === "OBSERVE_ONLY_RECOMMENDATION")).toBe(true);
    expect(report.suggestions.flatMap((item) => item.blockedBy)).toEqual(expect.arrayContaining([
      "human_review",
      "no_auto_promote",
      "no_auto_apply",
      "observe_mode_required",
    ]));
    expect(report.constraintsVerified).toEqual({
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      codeWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      promoted: "none",
      applyPerformed: "no",
      autoEvolutionApplied: "no",
      continuousAutoLoopTriggered: "no",
    });
    expect(existsSync(path.join(root, "MEMORY.md"))).toBe(false);
    expect(existsSync(path.join(root, "ENGINEERING_RULES.md"))).toBe(false);
  });

  it("fails closed into recommendations when required evidence is missing", () => {
    const report = runAutoEvolutionObserve(workspace(), {
      generatedAt: "2026-05-20T00:06:00.000Z",
      outputPath: null,
    });

    expect(report.stats.bySource).toMatchObject({
      mirror: 1,
      promote_gate: 1,
      kb: 1,
      hud: 1,
    });
    expect(report.suggestions.map((item) => item.blockedBy[0])).toEqual(expect.arrayContaining([
      "missing_mirror_observe_report",
      "missing_promote_gate_dry_run",
      "missing_kb_index",
      "missing_hud_state",
    ]));
    expect(report.constraintsVerified.autoEvolutionApplied).toBe("no");
  });

  it("writes only the observe report when output is enabled", () => {
    const root = workspace();
    writeRuntimeEvidence(root);

    const report = runAutoEvolutionObserve(root, {
      generatedAt: "2026-05-20T00:07:00.000Z",
    });

    expect(report.outputFile).toBe(path.join(root, "runtime", "main", "tmp", "auto-evolution-observe-2026-05-20T00-07-00-000Z.json"));
    expect(existsSync(report.outputFile!)).toBe(true);
    expect(JSON.parse(readFileSync(report.outputFile!, "utf8"))).toEqual(expect.objectContaining({
      taskId: "DOMAIN11-AUTO-EVOLUTION-OBSERVE-ONLY-A",
      mode: "observe-only",
      verdict: "PASS / AUTO-EVOLUTION OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
    }));
    expect(existsSync(path.join(root, "system", "skill-library", "promoted"))).toBe(false);
    expect(existsSync(path.join(root, "system", "case-library", "promoted"))).toBe(false);
  });
});
