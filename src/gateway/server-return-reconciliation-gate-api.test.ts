import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleReturnReconciliationGateHttpRequest,
  isReturnReconciliationGateApiPath,
} from "./server-return-reconciliation-gate-api.js";

function makeResponse() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      if (typeof body === "string") chunks.push(body);
    }),
  } as unknown as ServerResponse;
  return {
    res,
    json: () => JSON.parse(chunks.join("")) as Record<string, unknown>,
    text: () => chunks.join(""),
  };
}

function makeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method } as IncomingMessage;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("server return reconciliation gate API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-return-reconciliation-api-"));
    roots.push(root);
    return root;
  }

  it("matches only return reconciliation gate API paths", () => {
    expect(isReturnReconciliationGateApiPath("/api/returns/reconciliation-gate")).toBe(true);
    expect(isReturnReconciliationGateApiPath("/api/returns/repair-dry-run")).toBe(false);
    expect(isReturnReconciliationGateApiPath("/api/returns/diagnosis")).toBe(false);
  });

  it("serves observe-only reconciliation gate status", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "HEARTBEAT.md"), "FROZEN\n", "utf8");
    writeJson(path.join(root, "system", "returns", "inbox", "return-v2.json"), {
      packageId: "rrpkg-v2",
      packageVersion: "2.0",
      returnType: "completion",
      producedAt: "2026-05-20T00:00:00.000Z",
      role: {
        roleId: "engineering-executive",
        roleType: "executor",
      },
      taskId: "TASK-B",
      deliveryReceipt: {
        receiptId: "delivery-b",
        deliveryStatus: "delivered",
        summary: "done",
      },
      returnSummary: {
        status: "completed",
      },
      recommendedNextAction: {
        action: "main-verify",
        target: "main",
        description: "verify result",
      },
    });

    const response = makeResponse();
    const handled = await handleReturnReconciliationGateHttpRequest(
      makeReq("/api/returns/reconciliation-gate"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        status: "ready",
        frozen: true,
        readyForControlledApply: false,
        nextAction: "await_unfreeze_or_human_approval",
        constraintsVerified: {
          readOnly: "yes",
          returnWritten: "no",
          taskGraphWritten: "no",
          receiptWritten: "no",
          consumerTriggered: "no",
          dispatchTriggered: "no",
          applied: "no",
        },
      }),
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleReturnReconciliationGateHttpRequest(
      makeReq("/api/returns/reconciliation-gate", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
