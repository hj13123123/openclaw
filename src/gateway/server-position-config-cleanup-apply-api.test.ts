import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION } from "../runtime/position-config-cleanup-apply.js";
import {
  handlePositionConfigCleanupApplyHttpRequest,
  isPositionConfigCleanupApplyApiPath,
} from "./server-position-config-cleanup-apply-api.js";

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

function makeReq(url: string, method = "POST", body: unknown = {}): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { "content-type": "application/json" };
  return req;
}

function writePositionsConfig(root: string): string {
  const filePath = path.join(root, ".claw", "positions.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        enabledPositions: ["main", "engineering-executive", "front-end-executive", "patrol"],
        positionModelMapping: {
          main: {},
          "engineering-executive": {},
          "front-end-executive": {},
          patrol: {},
          "evolution-curator": {},
        },
        positionOverrides: {
          main: {},
          "engineering-executive": {},
          "front-end-executive": {},
          patrol: {},
          "evolution-curator": {},
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

describe("server position config cleanup apply API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-cleanup-apply-api-"));
    roots.push(root);
    return root;
  }

  it("matches only position config cleanup apply API paths", () => {
    expect(isPositionConfigCleanupApplyApiPath("/api/positions/cleanup-apply")).toBe(true);
    expect(isPositionConfigCleanupApplyApiPath("/api/positions/cleanup-gate")).toBe(false);
  });

  it("requires explicit confirmation", async () => {
    const root = workspace();
    const filePath = writePositionsConfig(root);
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupApplyHttpRequest(
      makeReq("/api/positions/cleanup-apply", "POST", { confirm: "apply" }),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      data: expect.objectContaining({
        status: "invalid_request",
        applyBlockedReason: "confirmation_required",
      }),
    });
    expect(readFileSync(filePath, "utf8")).toContain("evolution-curator");
  });

  it("returns conflict without writing when frozen blocks apply", async () => {
    const root = workspace();
    const filePath = writePositionsConfig(root);
    writeFileSync(path.join(root, "HEARTBEAT.md"), "frozen flag ACTIVE\n", "utf8");
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupApplyHttpRequest(
      makeReq("/api/positions/cleanup-apply", "POST", {
        confirm: POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
      }),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      data: expect.objectContaining({
        status: "blocked",
        applyBlockedReason: "frozen",
        constraintsVerified: expect.objectContaining({
          positionConfigWritten: "no",
          applied: "no",
        }),
      }),
    });
    expect(readFileSync(filePath, "utf8")).toContain("evolution-curator");
  });

  it("supports confirmed dry-run without writing", async () => {
    const root = workspace();
    const filePath = writePositionsConfig(root);
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupApplyHttpRequest(
      makeReq("/api/positions/cleanup-apply", "POST", {
        confirm: POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION,
        dryRun: true,
      }),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        status: "dry_run",
        removals: [
          { positionId: "evolution-curator", target: "positionModelMapping" },
          { positionId: "evolution-curator", target: "positionOverrides" },
        ],
      }),
    });
    expect(readFileSync(filePath, "utf8")).toContain("evolution-curator");
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupApplyHttpRequest(
      makeReq("/api/positions/cleanup-apply", "GET"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});
