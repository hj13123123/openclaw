import { describe, expect, it } from "vitest";
import {
  buildReturnConsumptionArtifacts,
  safeReturnFilePart,
} from "./return-consumer-artifacts.js";

describe("return consumer artifacts", () => {
  it("builds deterministic receipt and bridge marker payloads for a process plan", () => {
    expect(
      buildReturnConsumptionArtifacts({
        plan: {
          status: "process",
          sourceFile: "return-a.json",
          returnId: "rrpkg-a",
          taskId: "TASK-A",
          actionRequired: true,
        },
        pkg: {
          verificationChecklist: [{ item: "unit", status: "pass" }],
        },
        consumedAt: "2026-05-26T02:00:00.000Z",
        stamp: "20260526T020000",
      }),
    ).toEqual({
      receiptId: "receipt-rrpkg-TASK-A-20260526T020000",
      receiptFileName: "receipt-rrpkg-TASK-A-20260526T020000.json",
      receipt: {
        receiptId: "receipt-rrpkg-TASK-A-20260526T020000",
        consumedAt: "2026-05-26T02:00:00.000Z",
        sourcePackage: "return-a.json",
        sourceReturnId: "rrpkg-a",
        taskId: "TASK-A",
        consumer: "gateway-return-consumer-v1",
        status: "consumed",
        verificationChecklist: [{ item: "unit", status: "pass" }],
        processedBy: "system",
      },
      bridgeMarkerFileName: "rrpkg-a.json",
      bridgeMarker: {
        packageId: "rrpkg-a",
        taskId: "TASK-A",
        returnFile: "return-a.json",
        receiptFile: "receipt-rrpkg-TASK-A-20260526T020000.json",
        writtenAt: "2026-05-26T02:00:00.000Z",
      },
    });
  });

  it("sanitizes unsafe receipt and marker file parts", () => {
    expect(safeReturnFilePart("TASK: A / B")).toBe("TASK__A___B");
    expect(safeReturnFilePart("")).toBe("unknown");
  });
});
