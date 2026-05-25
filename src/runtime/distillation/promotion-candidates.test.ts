import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanPromotionCandidates } from "./promotion-candidates.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    targetFile: "NEXT_ACTION.md",
    changeType: "append_staleness_note",
    risk: "low",
    proposedSnippet: "<!-- truth-crosscheck: source-only -->",
    rollback: "Remove the exact truth-crosscheck line",
    ...overrides,
  };
}

describe("promotion candidate scanner", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-promotion-candidates-"));
    roots.push(root);
    return root;
  }

  it("summarizes candidate lifecycle and never mutates gate state", () => {
    const root = workspace();
    writeJson(path.join(root, "evolution", "promotion-candidates.json"), {
      generatedAt: "2026-05-26T01:00:00.000Z",
      candidates: [
        candidate({ proposedSnippet: "<!-- pending -->" }),
        candidate({ proposedSnippet: "<!-- approved -->" }),
        candidate({ proposedSnippet: "<!-- rejected -->" }),
        candidate({ proposedSnippet: "<!-- applied -->" }),
        candidate({ proposedSnippet: "<!-- rolledback -->" }),
      ],
    });
    writeJson(path.join(root, "evolution", "candidate-gate-state.json"), {
      lastSyncedAt: "2026-05-26T01:05:00.000Z",
      candidates: [
        { index: 1, approvedAt: "2026-05-26T01:06:00.000Z" },
        { index: 2, rejectedAt: "2026-05-26T01:07:00.000Z", rejectReason: "duplicate" },
        { index: 3, appliedAt: "2026-05-26T01:08:00.000Z" },
        { index: 4, rolledBackAt: "2026-05-26T01:09:00.000Z" },
      ],
    });

    const scan = scanPromotionCandidates(root);

    expect(scan.status).toBe("ok");
    expect(scan.stats.byState).toEqual({
      pending: 1,
      approved: 1,
      rejected: 1,
      applied: 1,
      rolledback: 1,
    });
    expect(scan.candidates.map((item) => item.state)).toEqual([
      "pending",
      "approved",
      "rejected",
      "applied",
      "rolledback",
    ]);
    expect(scan.constraintsVerified).toEqual({
      readOnly: "yes",
      candidateStateWritten: "no",
      truthFilesWritten: "no",
      applied: "none",
      rolledBack: "none",
      autoPromote: "disabled",
    });
  });

  it("detects orphan state and orphan writes by exact snippet matching", () => {
    const root = workspace();
    writeFileSync(path.join(root, "NEXT_ACTION.md"), "<!-- pending -->\n", "utf8");
    writeJson(path.join(root, "evolution", "promotion-candidates.json"), {
      candidates: [
        candidate({ proposedSnippet: "<!-- pending -->" }),
        candidate({ proposedSnippet: "<!-- applied-missing -->" }),
      ],
    });
    writeJson(path.join(root, "evolution", "candidate-gate-state.json"), {
      candidates: [{ index: 1, appliedAt: "2026-05-26T01:08:00.000Z" }],
    });

    const scan = scanPromotionCandidates(root);

    expect(scan.candidates[0]).toEqual(
      expect.objectContaining({
        state: "pending",
        consistency: "orphan-write",
      }),
    );
    expect(scan.candidates[1]).toEqual(
      expect.objectContaining({
        state: "applied",
        consistency: "orphan-state",
      }),
    );
    expect(scan.stats.byConsistency).toEqual({
      "orphan-write": 1,
      "orphan-state": 1,
    });
  });

  it("marks invalid candidates without throwing or opening an apply path", () => {
    const root = workspace();
    writeJson(path.join(root, "evolution", "promotion-candidates.json"), {
      candidates: [
        candidate({
          targetFile: "UNSAFE.md",
          changeType: "replace_file",
          risk: "critical",
          proposedSnippet: "not a comment",
        }),
      ],
    });

    const scan = scanPromotionCandidates(root);

    expect(scan.candidates[0]).toEqual(
      expect.objectContaining({
        state: "invalid",
        consistency: "invalid",
        blockers: [
          "target_not_allowed",
          "invalid_risk",
          "change_type_not_append_only",
          "snippet_not_single_line_html_comment",
        ],
      }),
    );
    expect(scan.stats.invalid).toBe(1);
    expect(scan.stats.safeApplyEligible).toBe(0);
  });

  it("reports missing and invalid input as scan state", () => {
    const missingRoot = workspace();
    expect(scanPromotionCandidates(missingRoot)).toEqual(
      expect.objectContaining({
        available: false,
        status: "missing",
        candidates: [],
      }),
    );

    const invalidRoot = workspace();
    mkdirSync(path.join(invalidRoot, "evolution"), { recursive: true });
    writeFileSync(path.join(invalidRoot, "evolution", "promotion-candidates.json"), "{bad", "utf8");

    expect(scanPromotionCandidates(invalidRoot)).toEqual(
      expect.objectContaining({
        available: false,
        status: "error",
        errors: [expect.stringContaining("Expected property name")],
      }),
    );
  });
});
