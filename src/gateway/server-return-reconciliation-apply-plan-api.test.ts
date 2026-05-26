import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleReturnReconciliationApplyPlanHttpRequest,
  isReturnReconciliationApplyPlanApiPath,
} from "./server-return-reconciliation-apply-plan-api.js";

const timestamp = "2026-05-20T00:00:00.000Z";

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

describe("server return reconciliation apply plan API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-return-reconcile-plan-api-"));
    roots.push(root);
    return root;
  }

  function writeReadyReturnAndGraph(root: string): void {
    writeJson(path.join(root, "runtime", "main", "tmp", "v2-task-graph-01", "graph.json"), {
      graphId: "graph-a",
      parentTaskId: "PARENT-A",
      title: "Task graph",
      status: "running",
      aggregateStatus: "running",
      nodes: [
        {
          nodeId: "a",
          role: "engineering-executive",
          taskId: "TASK-A",
          description: "Task A",
          dependsOn: [],
          status: "running",
          runId: null,
          sessionKey: null,
          returnId: null,
          humanGateRequired: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      edges: [],
      blockers: [],
      nextRunnable: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeJson(path.join(root, "system", "returns", "inbox", "return-v2.json"), {
      packageId: "rrpkg-v2",
      packageVersion: "2.0",
      returnType: "completion",
      producedAt: timestamp,
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
  }

  it("matches only return reconciliation apply plan API paths", () => {
    expect(isReturnReconciliationApplyPlanApiPath("/api/returns/reconciliation-apply-plan")).toBe(
      true,
    );
    expect(isReturnReconciliationApplyPlanApiPath("/api/returns/reconciliation-gate")).toBe(false);
  });

  it("serves observe-only ordered apply plans", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "HEARTBEAT.md"), "FROZEN\n", "utf8");
    writeReadyReturnAndGraph(root);

    const response = makeResponse();
    const handled = await handleReturnReconciliationApplyPlanHttpRequest(
      makeReq("/api/returns/reconciliation-apply-plan?limit=2"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        dryRun: true,
        status: "blocked",
        frozen: true,
        blockedReasons: ["frozen"],
        stepCount: 3,
        readyStepCount: 2,
        blockedStepCount: 1,
        steps: [
          expect.objectContaining({ action: "repair-return-package" }),
          expect.objectContaining({ action: "link-return-to-task-graph" }),
        ],
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
    const handled = await handleReturnReconciliationApplyPlanHttpRequest(
      makeReq("/api/returns/reconciliation-apply-plan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
