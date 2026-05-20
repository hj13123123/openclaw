import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPromoteGateDryRun } from "./promote-gate-dry-run.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "cand-skill",
    candidateType: "skill",
    title: "Reusable notice dedup skill",
    confidence: 0.9,
    occurrenceCount: 2,
    sources: [{ sourceType: "case", sourceId: "case-a" }],
    gates: {
      duplicateCheck: "passed",
      conflictCheck: "passed",
      minimumOccurrence: "passed",
      confidenceThreshold: "passed",
    },
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: "review-skill",
    candidateId: "cand-skill",
    reviewStatus: "approved",
    checklistResults: {
      evidenceSufficient: true,
      noDuplicate: true,
      noConflict: true,
      notOverfit: true,
      noPrivilegeExpansion: true,
      needsMoreEvidence: false,
      noTruthFileTouch: true,
    },
    ...overrides,
  };
}

describe("promote gate dry-run", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-promote-gate-"));
    roots.push(root);
    writeJson(path.join(root, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Notice dedup case",
    });
    return root;
  }

  it("marks a reviewed skill candidate ready without promoting it", () => {
    const root = workspace();
    writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-skill.json"), candidate());
    writeJson(path.join(root, "runtime", "main", "tmp", "review-candidates", "review-skill.json"), review());

    const report = runPromoteGateDryRun(root, { generatedAt: "2026-05-20T10:00:00.000Z", outputPath: null });

    expect(report.stats).toEqual({
      total: 1,
      byVerdict: { READY_FOR_PROMOTE_GATE: 1 },
      byType: { skill: 1 },
    });
    expect(report.plans[0]).toEqual(expect.objectContaining({
      candidateId: "cand-skill",
      verdict: "READY_FOR_PROMOTE_GATE",
      dryRunAction: "NO_WRITE_NO_PROMOTE",
      promoteTarget: "system/skill-library",
    }));
    expect(report.constraintsVerified).toEqual(expect.objectContaining({
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      promoted: "none",
      autoPromote: "disabled",
    }));
  });

  it("blocks candidates that do not have a matching review", () => {
    const root = workspace();
    writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-skill.json"), candidate());

    const report = runPromoteGateDryRun(root, { generatedAt: "2026-05-20T10:01:00.000Z", outputPath: null });

    expect(report.plans[0]?.verdict).toBe("WAITING_REVIEW");
    expect(report.plans[0]?.blockers).toContain("missing_review_candidate");
  });

  it("routes memory and engineering_rule candidates to explicit gates", () => {
    const root = workspace();
    writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-memory.json"), candidate({
      candidateId: "cand-memory",
      candidateType: "memory",
    }));
    writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-rule.json"), candidate({
      candidateId: "cand-rule",
      candidateType: "engineering_rule",
    }));
    writeJson(path.join(root, "runtime", "main", "tmp", "review-candidates", "review-memory.json"), review({
      reviewId: "review-memory",
      candidateId: "cand-memory",
      checklistResults: {
        evidenceSufficient: true,
        noDuplicate: true,
        noConflict: true,
        notOverfit: true,
        noPrivilegeExpansion: true,
        needsMoreEvidence: false,
        noTruthFileTouch: false,
      },
    }));
    writeJson(path.join(root, "runtime", "main", "tmp", "review-candidates", "review-rule.json"), review({
      reviewId: "review-rule",
      candidateId: "cand-rule",
    }));

    const report = runPromoteGateDryRun(root, { generatedAt: "2026-05-20T10:02:00.000Z", outputPath: null });

    expect(report.plans.find((plan) => plan.candidateId === "cand-memory")).toEqual(expect.objectContaining({
      verdict: "ROUTE_D1_CONTROLLED_APPLY",
      requiredGate: "D1_CONTROLLED_APPLY_REQUIRED",
    }));
    expect(report.plans.find((plan) => plan.candidateId === "cand-rule")).toEqual(expect.objectContaining({
      verdict: "WAITING_SEPARATE_ENGINEERING_RULE_APPROVAL",
      requiredGate: "SEPARATE_ENGINEERING_RULE_APPROVAL_REQUIRED",
    }));
  });

  it("writes only the dry-run report when an output path is provided and frozen blocks auto promote", () => {
    const root = workspace();
    writeFileSync(path.join(root, "SESSION_SUMMARY.md"), "D10 runtime frozen; auto-evolution frozen\n", "utf8");
    writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-skill.json"), candidate());
    writeJson(path.join(root, "runtime", "main", "tmp", "review-candidates", "review-skill.json"), review());
    const outputPath = path.join(root, "runtime", "main", "tmp", "report.json");

    const report = runPromoteGateDryRun(root, { generatedAt: "2026-05-20T10:03:00.000Z", outputPath });

    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(expect.objectContaining({
      mode: "dry-run",
      frozenActive: true,
    }));
    expect(report.plans[0]?.verdict).toBe("FROZEN_BLOCKED");
    expect(existsSync(path.join(root, "MEMORY.md"))).toBe(false);
    expect(existsSync(path.join(root, "ENGINEERING_RULES.md"))).toBe(false);
  });
});
