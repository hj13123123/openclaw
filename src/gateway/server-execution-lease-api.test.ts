import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  handleExecutionLeaseHttpRequest,
  isExecutionLeaseApiPath,
} from "./server-execution-lease-api.js";

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

function line(timestamp: string, role: string, content: string): string {
  return JSON.stringify({
    type: "message",
    timestamp,
    message: { role, content },
  });
}

describe("server execution lease API", () => {
  it("matches only execution lease API paths", () => {
    expect(isExecutionLeaseApiPath("/api/execution-lease/evaluate")).toBe(true);
    expect(isExecutionLeaseApiPath("/api/promotion-candidates/scan")).toBe(false);
  });

  it("evaluates leases and returns a dry-run human-gate plan", async () => {
    const response = makeResponse();
    const handled = await handleExecutionLeaseHttpRequest(
      makeReq("/api/execution-lease/evaluate", "POST", {
        now: "2026-05-26T00:07:00.000Z",
        transcriptLines: [line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A")],
        taskMetadata: { taskId: "TASK-A", taskType: "realTask" },
        config: { noProgressTimeoutSec: 300, hardStopSec: 1800 },
      }),
      response.res,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      mode: "dry-run",
      data: {
        lease: expect.objectContaining({
          leaseVerdict: "EXECUTION_STALLED",
          constraintsVerified: expect.objectContaining({
            humanGateCandidateWritten: "no",
            sessionKilled: "no",
            applied: "no",
          }),
        }),
        humanGatePlan: expect.objectContaining({
          action: "create_dry_run_candidate",
          candidateType: "execution_stalled",
          humanGateRequired: true,
        }),
      },
      constraintsVerified: {
        readOnly: "yes",
        localFileRead: "no",
        humanGateCandidateWritten: "no",
        sessionKilled: "no",
        sessionRestarted: "no",
        autoRecoveryTriggered: "no",
        applied: "no",
      },
    });
  });

  it("rejects invalid bodies and methods", async () => {
    const wrongMethod = makeResponse();
    expect(
      await handleExecutionLeaseHttpRequest(
        makeReq("/api/execution-lease/evaluate", "GET"),
        wrongMethod.res,
      ),
    ).toBe(true);
    expect(wrongMethod.res.statusCode).toBe(405);
    expect(wrongMethod.text()).toBe("Method Not Allowed");

    const invalidBody = makeResponse();
    expect(
      await handleExecutionLeaseHttpRequest(
        makeReq("/api/execution-lease/evaluate", "POST", {
          transcriptLines: "not-array",
          taskMetadata: {},
        }),
        invalidBody.res,
      ),
    ).toBe(true);
    expect(invalidBody.res.statusCode).toBe(400);
    expect(invalidBody.json()).toEqual(
      expect.objectContaining({
        ok: false,
        error: "transcriptLines string[] and taskMetadata object are required",
      }),
    );
  });
});
