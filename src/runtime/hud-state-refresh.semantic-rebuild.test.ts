import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HUD_STATE_RELATIVE_PATH, writeHudStateSnapshot } from "./hud-state-refresh.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-hud-semantic-rebuild-"));
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

describe("HUD semantic rebuild refresh", () => {
  it("adds semantic rebuild visibility from dry-run records without rebuilding vectors", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
        {
          status: "ready",
          mode: "dry-run",
          generatedAt: "2026-05-20T00:01:50.000Z",
          source: {
            totalItems: 1,
          },
          plannedBatches: 1,
          constraintsVerified: {
            embeddingCalls: "no",
            vectorIndexWritten: "no",
            applied: "no",
          },
        },
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-acceptance-2026-05-20T00-01-55-000Z.json",
        {
          mode: "acceptance-record",
          createdAt: "2026-05-20T00:01:55.000Z",
          proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
          plannedBatches: 1,
          totalItems: 1,
          approved: false,
          rebuildTriggered: false,
          constraintsVerified: {
            recordWritten: "yes",
            embeddingCalls: "no",
            vectorIndexWritten: "no",
            realRebuildTriggered: "no",
            applied: "no",
          },
        },
      );
      writeJson(
        workspaceRoot,
        "runtime/main/tmp/kb-semantic-rebuild-approval-2026-05-20T00-02-00-000Z.json",
        {
          mode: "rebuild-approval-record",
          createdAt: "2026-05-20T00:02:00.000Z",
          proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
          plannedBatches: 1,
          totalItems: 1,
          approved: true,
          rebuildTriggered: false,
          constraintsVerified: {
            approvalRecordWritten: "yes",
            embeddingCalls: "no",
            vectorIndexWritten: "no",
            realRebuildTriggered: "no",
            applied: "no",
          },
        },
      );

      const result = writeHudStateSnapshot(workspaceRoot, "2026-05-20T00:02:10.000Z");
      const statePath = path.join(workspaceRoot, HUD_STATE_RELATIVE_PATH);
      const written = JSON.parse(readFileSync(statePath, "utf8")) as typeof result.state;

      expect(written.semanticRebuild).toMatchObject({
        available: true,
        stage: "ready_for_real_rebuild_implementation",
        latestPlanPath: "runtime/main/tmp/kb-semantic-rebuild-plan-2026-05-20T00-01-50-000Z.json",
        latestAcceptancePath:
          "runtime/main/tmp/kb-semantic-rebuild-acceptance-2026-05-20T00-01-55-000Z.json",
        latestApprovalPath:
          "runtime/main/tmp/kb-semantic-rebuild-approval-2026-05-20T00-02-00-000Z.json",
        totalItems: 1,
        plannedBatches: 1,
        readyForHumanGate: true,
        readyForExecution: true,
        readyForRealRebuildImplementation: true,
        constraintsVerified: {
          approvalRecordWritten: "yes",
          embeddingCalls: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      });
      expect(() =>
        readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
      ).toThrow();
      expect(() =>
        readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
      ).toThrow();
    }));
});
