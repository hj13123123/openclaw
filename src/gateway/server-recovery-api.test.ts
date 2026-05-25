import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_GRAPH_SOURCE_RELATIVE_PATH } from "../runtime/task-graph.js";
import { handleRecoveryHttpRequest, isRecoveryApiPath } from "./server-recovery-api.js";

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

describe("server recovery API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-recovery-api-"));
    roots.push(root);
    return root;
  }

  it("matches only recovery candidate scan API paths", () => {
    expect(isRecoveryApiPath("/api/recovery-candidates/scan")).toBe(true);
    expect(isRecoveryApiPath("/api/control-signals/scan")).toBe(false);
    expect(isRecoveryApiPath("/api/task-graph/validation")).toBe(false);
  });

  it("serves observe-only recovery candidate scans", async () => {
    const root = workspace();
    writeJson(path.join(root, TASK_GRAPH_SOURCE_RELATIVE_PATH, "task-graph-a.json"), {
      graphId: "graph-a",
      nodes: [
        {
          nodeId: "a",
          taskId: "TASK-A",
          status: "blocked",
          description: "Blocked task",
          dependsOn: [],
          runId: null,
        },
      ],
    });

    const response = makeResponse();
    const handled = await handleRecoveryHttpRequest(
      makeReq("/api/recovery-candidates/scan?graphId=graph-a"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        graphCount: 1,
        candidateCount: 1,
        constraintsVerified: {
          readOnly: "yes",
          recoveryDecisionWritten: "no",
          taskGraphMutated: "no",
          sessionsSent: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
        candidates: [expect.objectContaining({ taskId: "TASK-A", suggestedAction: "unblock" })],
      }),
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleRecoveryHttpRequest(
      makeReq("/api/recovery-candidates/scan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
