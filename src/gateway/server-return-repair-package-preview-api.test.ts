import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleReturnRepairPackagePreviewHttpRequest,
  isReturnRepairPackagePreviewApiPath,
} from "./server-return-repair-package-preview-api.js";

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

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("server return repair package preview API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-return-repair-preview-api-"));
    roots.push(root);
    return root;
  }

  it("matches only return repair package preview API paths", () => {
    expect(isReturnRepairPackagePreviewApiPath("/api/returns/repair-package-preview")).toBe(true);
    expect(isReturnRepairPackagePreviewApiPath("/api/returns/repair-dry-run")).toBe(false);
  });

  it("serves observe-only repair package previews", async () => {
    const root = workspace();
    writeJson(root, "system/returns/inbox/return-v2.json", {
      packageId: "rrpkg-v2",
      packageVersion: "2.0",
      returnType: "completion",
      role: {
        roleId: "engineering-executive",
        roleType: "executor",
      },
      taskId: "TASK-A",
      returnSummary: {
        status: "completed",
      },
      recommendedNextAction: {
        action: "main-verify",
        target: "main",
        description: "verify",
      },
    });

    const response = makeResponse();
    const handled = await handleReturnRepairPackagePreviewHttpRequest(
      makeReq("/api/returns/repair-package-preview?sourceFile=return-v2.json"),
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
        sourceFile: "return-v2.json",
        repairable: true,
        proposedPackage: expect.objectContaining({
          packageId: "rrpkg-v2",
          packageVersion: "1.0",
          task: expect.objectContaining({
            ticketId: "TASK-A",
          }),
        }),
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

  it("requires sourceFile", async () => {
    const response = makeResponse();
    const handled = await handleReturnRepairPackagePreviewHttpRequest(
      makeReq("/api/returns/repair-package-preview"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "sourceFile query parameter is required",
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleReturnRepairPackagePreviewHttpRequest(
      makeReq("/api/returns/repair-package-preview?sourceFile=return-v2.json", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
