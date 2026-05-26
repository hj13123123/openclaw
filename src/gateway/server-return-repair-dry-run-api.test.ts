import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleReturnRepairDryRunHttpRequest,
  isReturnRepairDryRunApiPath,
} from "./server-return-repair-dry-run-api.js";

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

describe("server return repair dry-run API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-return-repair-api-"));
    roots.push(root);
    return root;
  }

  it("matches only return repair dry-run API paths", () => {
    expect(isReturnRepairDryRunApiPath("/api/returns/repair-dry-run")).toBe(true);
    expect(isReturnRepairDryRunApiPath("/api/returns/diagnosis")).toBe(false);
    expect(isReturnRepairDryRunApiPath("/api/hud/return-consumer-plan")).toBe(false);
  });

  it("serves observe-only return repair dry-runs", async () => {
    const root = workspace();
    writeJson(path.join(root, "system", "returns", "inbox", "return-v2-shape.json"), {
      packageId: "rrpkg-v2-shape",
      packageVersion: "1.0",
      schema: "canonical-v2-return",
      returnType: "completion",
      producedAt: "2026-05-20T00:00:00.000Z",
      role: {
        roleId: "engineering-executive",
        roleType: "executor",
      },
      task: {
        taskId: "TASK-X",
      },
      status: "PASS",
      candidateEligibility: {
        eligible: true,
      },
      recommendedNextAction: {
        action: "main-verify",
        target: "main",
        description: "review result",
      },
    });

    const response = makeResponse();
    const handled = await handleReturnRepairDryRunHttpRequest(
      makeReq("/api/returns/repair-dry-run?limit=1"),
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
        totalDiagnosed: 1,
        candidateCount: 1,
        repairableCount: 1,
        blockedCount: 0,
        plans: [
          expect.objectContaining({
            sourceFile: "return-v2-shape.json",
            taskId: "TASK-X",
            repairable: true,
            remainingValidationErrors: [],
          }),
        ],
        constraintsVerified: {
          readOnly: "yes",
          returnWritten: "no",
          originalReturnMutated: "no",
          archived: "no",
          receiptWritten: "no",
          consumerTriggered: "no",
          applied: "no",
        },
      }),
    });
  });

  it("rejects invalid limits", async () => {
    const response = makeResponse();
    const handled = await handleReturnRepairDryRunHttpRequest(
      makeReq("/api/returns/repair-dry-run?limit=bad"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_limit",
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleReturnRepairDryRunHttpRequest(
      makeReq("/api/returns/repair-dry-run", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
