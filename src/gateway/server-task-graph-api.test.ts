import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTaskGraphHttpRequest, isTaskGraphApiPath } from "./server-task-graph-api.js";

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

function makeReq(url: string, method: string): IncomingMessage {
  return { url, method } as IncomingMessage;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function graph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graphId: "graph-a",
    parentTaskId: "PARENT-A",
    title: "Task graph API test",
    status: "planned",
    nodes: [
      {
        nodeId: "a",
        role: "engineering-executive",
        taskId: "TASK-A",
        description: "Task A",
        dependsOn: [],
        status: "planned",
        runId: null,
        sessionKey: null,
        returnId: null,
        humanGateRequired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    edges: [],
    aggregateStatus: "planned",
    blockers: [],
    nextRunnable: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("server task graph API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-task-graph-api-"));
    roots.push(root);
    return root;
  }

  it("matches only task graph validation API paths", () => {
    expect(isTaskGraphApiPath("/api/task-graph/validation")).toBe(true);
    expect(isTaskGraphApiPath("/api/hud/state")).toBe(false);
    expect(isTaskGraphApiPath("/api/auto-evolution/state")).toBe(false);
  });

  it("returns an empty observe-only validation result when no graph files exist", async () => {
    const response = makeResponse();
    const handled = await handleTaskGraphHttpRequest(makeReq("/api/task-graph/validation", "GET"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      ok: true,
      available: false,
      mode: "observe-only",
      observeOnly: true,
      applied: false,
      wouldDispatch: false,
      sourcePath: "runtime/main/tmp/v2-task-graph-01/",
      total: 0,
      valid: true,
      bySeverity: {
        pass: 0,
        warning: 0,
        error: 0,
      },
      reports: [],
    }));
  });

  it("returns detailed validation reports without writing or dispatching", async () => {
    const root = workspace();
    writeJson(path.join(root, "runtime", "main", "tmp", "v2-task-graph-01", "task-graph-a.json"), graph());
    writeJson(path.join(root, "runtime", "main", "tmp", "v2-task-graph-01", "task-graph-b.json"), graph({
      graphId: "graph-b",
      aggregateStatus: "completed",
    }));

    const response = makeResponse();
    const handled = await handleTaskGraphHttpRequest(makeReq("/api/task-graph/validation", "GET"), response.res, root);
    const body = response.json();

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      ok: true,
      available: true,
      mode: "observe-only",
      applied: false,
      wouldDispatch: false,
      total: 2,
      valid: false,
      bySeverity: {
        pass: 1,
        warning: 0,
        error: 1,
      },
    }));
    expect(body.reports).toEqual([
      expect.objectContaining({
        graphId: "graph-a",
        graphPath: "runtime/main/tmp/v2-task-graph-01/task-graph-a.json",
        status: "PASS",
        severity: "pass",
        errors: [],
      }),
      expect.objectContaining({
        graphId: "graph-b",
        graphPath: "runtime/main/tmp/v2-task-graph-01/task-graph-b.json",
        status: "FAIL",
        severity: "error",
        errors: [expect.objectContaining({ check: "aggregate_status" })],
      }),
    ]);
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleTaskGraphHttpRequest(makeReq("/api/task-graph/validation", "POST"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
