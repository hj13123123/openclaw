import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractReturnPackageIdentity,
  planReturnConsumption,
  scanReturnConsumerPlan,
  validateRoleReturnPackageV1,
  type RoleReturnPackageV1,
} from "./return-consumer-plan.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-consumer-plan-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): string {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function validReturnPackage(overrides: RoleReturnPackageV1 = {}): RoleReturnPackageV1 {
  return {
    packageId: "rrpkg-a",
    packageVersion: "1.0",
    returnType: "completion",
    producedAt: "2026-05-20T00:00:00.000Z",
    role: {
      roleId: "engineering-executive",
      roleType: "executor",
    },
    task: {
      ticketId: "TASK-A",
      taskTitle: "Task A",
    },
    deliveryReceipt: {
      receiptId: "delivery-a",
      deliveryStatus: "delivered",
      summary: "delivered",
    },
    returnSummary: {
      status: "completed",
      restartRequired: true,
    },
    candidateEligibility: {
      eligible: false,
    },
    recommendedNextAction: {
      action: "accept",
      target: "main",
      description: "accept result",
    },
    verificationChecklist: [{ item: "unit", status: "pass" }],
    ...overrides,
  };
}

describe("return consumer plan", () => {
  it("extracts canonical identity with V1 fallbacks", () => {
    expect(extractReturnPackageIdentity(validReturnPackage())).toEqual({
      returnId: "rrpkg-a",
      taskId: "TASK-A",
    });
    expect(
      extractReturnPackageIdentity({
        roleReturnPackageId: "legacy-return",
        taskId: "LEGACY-TASK",
      }),
    ).toEqual({
      returnId: "legacy-return",
      taskId: "LEGACY-TASK",
    });
  });

  it("plans a valid return for processing without writing anything", () => {
    expect(
      planReturnConsumption({
        sourceFile: "return-a.json",
        pkg: validReturnPackage(),
        receiptExists: false,
        processedFileExists: false,
      }),
    ).toEqual({
      status: "process",
      sourceFile: "return-a.json",
      returnId: "rrpkg-a",
      taskId: "TASK-A",
      actionRequired: true,
    });
  });

  it("keeps invalid, duplicate, and legacy returns out of processing", () => {
    expect(validateRoleReturnPackageV1({ packageId: "bad" })).toContain("task");
    expect(
      planReturnConsumption({
        sourceFile: "return-invalid.json",
        pkg: { packageId: "bad" },
        receiptExists: false,
        processedFileExists: false,
      }),
    ).toMatchObject({ status: "skip", reason: "schema-invalid" });
    expect(
      planReturnConsumption({
        sourceFile: "return-duplicate.json",
        pkg: validReturnPackage(),
        receiptExists: true,
        processedFileExists: false,
      }),
    ).toMatchObject({ status: "skip", reason: "receipt-exists" });
    expect(
      planReturnConsumption({
        sourceFile: "return-legacy.json",
        pkg: validReturnPackage({ packageId: "P2-P-old", task: { ticketId: "TASK-A" } }),
        receiptExists: false,
        processedFileExists: false,
      }),
    ).toMatchObject({ status: "skip", reason: "legacy-p2-p-skipped" });
  });

  it("scans consumer plans without consuming inbox files or writing receipts", () =>
    withTempRoot((workspaceRoot) => {
      const validPath = writeJson(
        workspaceRoot,
        "system/returns/inbox/return-a.json",
        validReturnPackage(),
      );
      writeJson(workspaceRoot, "system/returns/inbox/return-invalid.json", {
        packageId: "invalid",
      });
      writeJson(workspaceRoot, "system/returns/inbox/return.mock.skip.json", {
        packageId: "mock",
      });
      const before = readFileSync(validPath, "utf8");

      const result = scanReturnConsumerPlan(workspaceRoot, {
        scannedAt: "2026-05-22T09:00:00.000Z",
      });

      expect(result).toMatchObject({
        mode: "observe-only",
        scannedAt: "2026-05-22T09:00:00.000Z",
        inboxPath: "system/returns/inbox",
        processedPath: "system/returns/processed",
        totalCount: 2,
        processCount: 1,
        skipCount: 1,
        byReason: [{ reason: "schema-invalid", count: 1 }],
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      });
      expect(result.plans).toEqual([
        expect.objectContaining({
          status: "process",
          sourceFile: "return-a.json",
          returnId: "rrpkg-a",
          taskId: "TASK-A",
        }),
        expect.objectContaining({
          status: "skip",
          sourceFile: "return-invalid.json",
          reason: "schema-invalid",
        }),
      ]);
      expect(readFileSync(validPath, "utf8")).toBe(before);
      expect(existsSync(path.join(workspaceRoot, "system/returns/processed"))).toBe(false);
    }));
});
