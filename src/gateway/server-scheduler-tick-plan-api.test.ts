import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSchedulerTickPlanHttpRequest,
  isSchedulerTickPlanApiPath,
} from "./server-scheduler-tick-plan-api.js";

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

describe("server scheduler tick plan API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-scheduler-tick-plan-api-"));
    roots.push(root);
    return root;
  }

  it("matches only scheduler tick plan paths", () => {
    expect(isSchedulerTickPlanApiPath("/api/task-scheduler/tick-plan")).toBe(true);
    expect(isSchedulerTickPlanApiPath("/api/recovery-candidates/scan")).toBe(false);
    expect(isSchedulerTickPlanApiPath("/api/hud/scheduler-state")).toBe(false);
  });

  it("serves observe-only scheduler tick plans", async () => {
    const root = workspace();
    writeJson(path.join(root, "runtime/main/tmp/task-scheduler-enabled.json"), {
      enabled: true,
      mode: "observe",
    });
    writeJson(path.join(root, "runtime/main/tmp/task-scheduler-state.json"), {
      status: "idle",
      running: false,
      totalTicks: 0,
    });

    const response = makeResponse();
    const handled = await handleSchedulerTickPlanHttpRequest(
      makeReq("/api/task-scheduler/tick-plan"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        decision: "observe_only",
        constraintsVerified: {
          readOnly: "yes",
          markerWritten: "no",
          stateWritten: "no",
          eventEmitted: "no",
          scriptInvoked: "no",
          childProcessSpawned: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
      }),
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleSchedulerTickPlanHttpRequest(
      makeReq("/api/task-scheduler/tick-plan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
