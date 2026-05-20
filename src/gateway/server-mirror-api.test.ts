import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMirrorHttpRequest, isMirrorApiPath } from "./server-mirror-api.js";

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

function makeReq(url: string, method: string): IncomingMessage {
  return { url, method } as IncomingMessage;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeMirrorInputs(root: string): void {
  writeJson(path.join(root, "runtime", "main", "tmp", "task-hud-state.json"), {
    generatedAt: "2026-05-20T00:00:00.000Z",
    globalStatus: {
      status: "attention_required",
      pendingReviewCount: 1,
      alertCount: 0,
    },
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "task-scheduler-state.json"), {
    enabled: false,
    mode: "observe",
    status: "disabled",
    totalTicks: 0,
    observeOnlyTicks: 0,
    skippedBecauseDisabled: 1,
  });
  writeJson(path.join(root, "system", "kb-index", "index.json"), {
    generatedAt: "2026-05-20T00:01:00.000Z",
    totalItems: 1,
    sourceCaseCount: 1,
    sourceSkillCount: 0,
    keywords: { mirror: ["case-a"] },
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "d9-promote-gate-dryrun-2026-05-20T00-02-00-000Z.json"), {
    generatedAt: "2026-05-20T00:02:00.000Z",
    stats: {
      total: 1,
      byVerdict: {
        FROZEN_BLOCKED: 1,
      },
    },
    constraintsVerified: {
      promoted: "none",
    },
  });
}

describe("server mirror API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-mirror-api-"));
    roots.push(root);
    return root;
  }

  it("matches only mirror API paths", () => {
    expect(isMirrorApiPath("/api/mirror/state")).toBe(true);
    expect(isMirrorApiPath("/api/mirror/observe")).toBe(true);
    expect(isMirrorApiPath("/api/promote-gate/state")).toBe(false);
  });

  it("returns unavailable state before first mirror report", async () => {
    const response = makeResponse();
    const handled = await handleMirrorHttpRequest(makeReq("/api/mirror/state", "GET"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      reportDir: "runtime/main/tmp",
    });
  });

  it("runs observe-only and exposes latest report summary", async () => {
    const root = workspace();
    writeMirrorInputs(root);

    const observeResponse = makeResponse();
    const handled = await handleMirrorHttpRequest(makeReq("/api/mirror/observe", "POST"), observeResponse.res, root);

    expect(handled).toBe(true);
    expect(observeResponse.res.statusCode).toBe(200);
    expect(observeResponse.json()).toEqual(expect.objectContaining({
      mode: "observe-only",
      observeOnly: true,
      promoted: "none",
      applied: false,
      stats: {
        observationCount: 4,
        findingCount: 4,
        bySeverity: {
          attention: 2,
          info: 2,
        },
      },
    }));

    const outputFile = String(observeResponse.json().outputFile);
    expect(existsSync(outputFile)).toBe(true);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual(expect.objectContaining({
      mode: "observe-only",
      constraintsVerified: expect.objectContaining({
        MEMORYWritten: "no",
        ENGINEERING_RULESWritten: "no",
        promoted: "none",
        autoLoopTriggered: "no",
      }),
    }));

    const stateResponse = makeResponse();
    await handleMirrorHttpRequest(makeReq("/api/mirror/state", "GET"), stateResponse.res, root);
    expect(stateResponse.json()).toEqual(expect.objectContaining({
      available: true,
      mode: "observe-only",
      stats: {
        observationCount: 4,
        findingCount: 4,
        bySeverity: {
          attention: 2,
          info: 2,
        },
      },
    }));
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleMirrorHttpRequest(makeReq("/api/mirror/observe", "GET"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});
