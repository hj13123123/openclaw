import { describe, expect, it } from "vitest";
import {
  extractReturnPackageIdentity,
  planReturnConsumption,
  validateRoleReturnPackageV1,
  type RoleReturnPackageV1,
} from "./return-consumer-plan.js";

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
});
