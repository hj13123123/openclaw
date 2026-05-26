import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReturnRepairDryRun } from "./return-repair-dry-run.js";

const timestamp = "2026-05-20T00:00:00.000Z";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-repair-dry-run-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): string {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

describe("return repair dry-run planner", () => {
  it("plans V2-shaped return repair without writing packages or receipts", () =>
    withTempRoot((workspaceRoot) => {
      const flatV2Path = writeJson(workspaceRoot, "system/returns/inbox/return-flat-v2.json", {
        packageId: "rrpkg-flat-v2",
        packageVersion: "2.0",
        returnType: "completion",
        producedAt: timestamp,
        role: {
          roleId: "engineering-executive",
          roleType: "executor",
        },
        taskId: "TASK-FLAT",
        deliveryReceipt: {
          receiptId: "delivery-flat",
          deliveryStatus: "delivered",
          summary: "delivered",
        },
        returnSummary: {
          status: "completed",
        },
        recommendedNextAction: {
          action: "main-verify",
          target: "main",
          description: "verify flat return",
        },
      });
      const canonicalV2Path = writeJson(
        workspaceRoot,
        "system/returns/inbox/return-canonical-v2.json",
        {
          packageId: "rrpkg-canonical-v2",
          packageVersion: "1.0",
          schema: "canonical-v2-return",
          returnType: "completion",
          producedAt: timestamp,
          role: {
            roleId: "engineering-executive",
            roleType: "executor",
          },
          task: {
            taskId: "TASK-CANONICAL",
            title: "Canonical task",
          },
          status: "PASS",
          candidateEligibility: {
            eligible: true,
          },
          recommendedNextAction: {
            action: "main-verify",
            target: "main",
            description: "verify canonical return",
          },
        },
      );
      const before = new Map([
        [flatV2Path, readFileSync(flatV2Path, "utf8")],
        [canonicalV2Path, readFileSync(canonicalV2Path, "utf8")],
      ]);

      const result = buildReturnRepairDryRun(workspaceRoot, {
        plannedAt: "2026-05-22T09:00:00.000Z",
      });

      expect(result).toMatchObject({
        mode: "observe-only",
        dryRun: true,
        plannedAt: "2026-05-22T09:00:00.000Z",
        inboxPath: "system/returns/inbox",
        totalDiagnosed: 2,
        candidateCount: 2,
        repairableCount: 2,
        blockedCount: 0,
        constraintsVerified: {
          readOnly: "yes",
          returnWritten: "no",
          originalReturnMutated: "no",
          archived: "no",
          receiptWritten: "no",
          consumerTriggered: "no",
          applied: "no",
        },
      });
      expect(result.plans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: "return-flat-v2.json",
            taskId: "TASK-FLAT",
            repairable: true,
            remainingValidationErrors: [],
            fieldActions: expect.arrayContaining([
              "set-package-version",
              "normalize-task",
              "synthesize-candidate-eligibility",
              "preserve-recommended-next-action",
            ]),
            proposedPackagePreview: expect.objectContaining({
              packageId: "rrpkg-flat-v2",
              packageVersion: "1.0",
              taskTicketId: "TASK-FLAT",
              roleId: "engineering-executive",
              recommendedNextAction: "main-verify",
            }),
          }),
          expect.objectContaining({
            sourceFile: "return-canonical-v2.json",
            taskId: "TASK-CANONICAL",
            repairable: true,
            remainingValidationErrors: [],
            fieldActions: expect.arrayContaining([
              "normalize-task",
              "synthesize-delivery-receipt",
              "synthesize-return-summary",
              "preserve-recommended-next-action",
            ]),
          }),
        ]),
      );
      for (const [filePath, contents] of before) {
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe(contents);
      }
      expect(existsSync(path.join(workspaceRoot, "system/returns/processed"))).toBe(false);
    }));
});
