import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  processReturnInbox,
  resolveReturnConsumerWorkspaceRoot,
} from "./server-return-consumer.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-consumer-"));
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

function validReturnPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

describe("server return consumer", () => {
  it("falls back to patrol workspace when main is not configured", () => {
    expect(
      resolveReturnConsumerWorkspaceRoot({
        agents: {
          list: [
            {
              id: "patrol",
              workspace: "C:\\openclaw\\workspace-main",
            },
          ],
        },
      }),
    ).toBe("C:\\openclaw\\workspace-main");
  });

  it("processes a valid return package into processed, receipt, bridge marker, and notice", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(workspaceRoot, "system/returns/inbox/return-a.json", validReturnPackage());

      const log = { info: vi.fn(), warn: vi.fn() };
      const results = processReturnInbox(workspaceRoot, log);
      const processedPath = path.join(workspaceRoot, "system/returns/processed/return-a.json");
      const processedDir = path.join(workspaceRoot, "system/returns/processed");
      const bridgeMarkerPath = path.join(
        workspaceRoot,
        "runtime/main/tmp/bridge-queue/rrpkg-a.json",
      );
      const noticeDir = path.join(workspaceRoot, "runtime/notifications/inbox");

      expect(results).toEqual([
        expect.objectContaining({
          status: "processed",
          returnId: "rrpkg-a",
          taskId: "TASK-A",
          sourceFile: "return-a.json",
          actionRequired: true,
        }),
      ]);
      expect(existsSync(path.join(workspaceRoot, "system/returns/inbox/return-a.json"))).toBe(
        false,
      );
      expect(existsSync(processedPath)).toBe(true);
      const receiptFile = readdirSync(processedDir).find((name) =>
        /^receipt-rrpkg-TASK-A-.*\.json$/u.test(name),
      );
      expect(receiptFile).toBeDefined();
      expect(readJson(path.join(processedDir, receiptFile as string))).toMatchObject({
        sourcePackage: "return-a.json",
        sourceReturnId: "rrpkg-a",
        taskId: "TASK-A",
        status: "consumed",
      });
      expect(readJson(bridgeMarkerPath)).toMatchObject({
        packageId: "rrpkg-a",
        taskId: "TASK-A",
        returnFile: "return-a.json",
        receiptFile,
      });
      expect(
        readdirSync(noticeDir).some((name) => /^notice-return-consumer-.*\.json$/u.test(name)),
      ).toBe(true);
      expect(log.info).toHaveBeenCalledWith("[return-consumer] processed=1 skipped=0");
    }));

  it("skips invalid return packages without moving them", () =>
    withTempRoot((workspaceRoot) => {
      writeJson(workspaceRoot, "system/returns/inbox/return-invalid.json", {
        packageId: "rrpkg-invalid",
        packageVersion: "1.0",
      });

      const results = processReturnInbox(workspaceRoot, { info: vi.fn(), warn: vi.fn() });

      expect(results).toEqual([
        expect.objectContaining({
          status: "skipped",
          reason: "schema-invalid",
          sourceFile: "return-invalid.json",
          returnId: "rrpkg-invalid",
        }),
      ]);
      expect(existsSync(path.join(workspaceRoot, "system/returns/inbox/return-invalid.json"))).toBe(
        true,
      );
      expect(
        existsSync(path.join(workspaceRoot, "runtime/main/tmp/return-consumer-warn.jsonl")),
      ).toBe(true);
    }));
});
