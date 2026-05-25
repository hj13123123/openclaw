import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSemanticRebuildSummary } from "./kb-semantic-rebuild-state.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-kb-semantic-state-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("KB semantic rebuild state reader", () => {
  it("returns plan_missing without writing semantic artifacts", () => {
    withTempRoot((workspaceRoot) => {
      expect(readSemanticRebuildSummary(workspaceRoot)).toMatchObject({
        available: false,
        stage: "plan_missing",
        latestPlanPath: null,
        latestExecutionPath: null,
        executionStatus: null,
        constraintsVerified: null,
      });
    });
  });

  it("summarizes approved dry-run records as ready for implementation", () => {
    withTempRoot((workspaceRoot) => {
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
        {
          status: "ready",
          source: { totalItems: 3 },
          plannedBatches: 2,
          constraintsVerified: { embeddingCalls: "no", applied: "no" },
        },
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-acceptance-2026-05-20T00-01-55-000Z.json",
        {
          constraintsVerified: { recordWritten: "yes", applied: "no" },
        },
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-approval-2026-05-20T00-02-00-000Z.json",
        {
          constraintsVerified: { approvalRecordWritten: "yes", applied: "no" },
        },
      );

      expect(readSemanticRebuildSummary(workspaceRoot)).toMatchObject({
        available: true,
        stage: "ready_for_real_rebuild_implementation",
        totalItems: 3,
        plannedBatches: 2,
        readyForHumanGate: true,
        readyForExecution: true,
        readyForRealRebuildImplementation: true,
        constraintsVerified: { approvalRecordWritten: "yes", applied: "no" },
      });
    });
  });

  it("prefers applied execution reports over dry-run readiness", () => {
    withTempRoot((workspaceRoot) => {
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
        {
          status: "ready",
          source: { totalItems: 3 },
          plannedBatches: 2,
        },
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-approval-2026-05-20T00-02-00-000Z.json",
        {},
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-execution-run-semantic-rebuild-a.json",
        {
          status: "applied",
          totalItems: 14,
          constraintsVerified: {
            embeddingCalls: "yes",
            semanticIndexWritten: "yes",
            vectorIndexWritten: "yes",
            applied: "yes",
          },
        },
      );

      expect(readSemanticRebuildSummary(workspaceRoot)).toMatchObject({
        available: true,
        stage: "applied",
        latestExecutionPath:
          "runtime/main/tmp/kb-semantic-rebuild-execution-run-semantic-rebuild-a.json",
        executionStatus: "applied",
        totalItems: 14,
        readyForRealRebuildImplementation: false,
        constraintsVerified: {
          embeddingCalls: "yes",
          semanticIndexWritten: "yes",
          vectorIndexWritten: "yes",
          applied: "yes",
        },
      });
    });
  });
});
