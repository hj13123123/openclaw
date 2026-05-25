import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleControlSignalsHttpRequest,
  isControlSignalsApiPath,
} from "./server-control-signals-api.js";

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

describe("server control signals API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-control-signals-api-"));
    roots.push(root);
    return root;
  }

  it("matches only control signal scan API paths", () => {
    expect(isControlSignalsApiPath("/api/control-signals/scan")).toBe(true);
    expect(isControlSignalsApiPath("/api/hud/state")).toBe(false);
    expect(isControlSignalsApiPath("/api/task-graph/validation")).toBe(false);
  });

  it("serves observe-only control signal scans", async () => {
    const root = workspace();
    writeJson(path.join(root, "system", "control-signals", "pending", "ctrl-a.json"), {
      signalId: "ctrl-a",
      taskId: "TASK-A",
      targetRole: "engineering-executive",
      action: "pause",
      status: "pending",
    });

    const response = makeResponse();
    const handled = await handleControlSignalsHttpRequest(
      makeReq("/api/control-signals/scan?targetRole=engineering-executive"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        status: "ok",
        pendingCount: 1,
        validCount: 1,
        constraintsVerified: {
          readOnly: "yes",
          signalWritten: "no",
          taskGraphMutated: "no",
          sessionsSent: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
        signals: [
          expect.objectContaining({ taskId: "TASK-A", targetRole: "engineering-executive" }),
        ],
      }),
    });
  });

  it("rejects invalid targetRole values without scanning", async () => {
    const response = makeResponse();
    const handled = await handleControlSignalsHttpRequest(
      makeReq("/api/control-signals/scan?targetRole=main"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_targetRole",
      allowedTargetRoles: ["engineering-executive", "front-end-executive"],
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleControlSignalsHttpRequest(
      makeReq("/api/control-signals/scan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
