import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePositionConfigCleanupPlanHttpRequest,
  isPositionConfigCleanupPlanApiPath,
} from "./server-position-config-cleanup-plan-api.js";

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

function writePositionsConfig(root: string): void {
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
}

describe("server position config cleanup plan API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-position-config-cleanup-api-"));
    roots.push(root);
    return root;
  }

  it("matches only position config cleanup plan API paths", () => {
    expect(isPositionConfigCleanupPlanApiPath("/api/positions/cleanup-plan")).toBe(true);
    expect(isPositionConfigCleanupPlanApiPath("/api/positions/audit")).toBe(false);
  });

  it("serves observe-only cleanup plans", async () => {
    const root = workspace();
    writePositionsConfig(root);
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupPlanHttpRequest(
      makeReq("/api/positions/cleanup-plan?limit=1"),
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
        status: "ready",
        staleConfiguredOnlyPositions: ["evolution-curator"],
        removalStepCount: 2,
        readyStepCount: 2,
        readyForControlledApply: true,
        steps: [
          expect.objectContaining({
            positionId: "evolution-curator",
            target: "positionModelMapping",
          }),
        ],
        constraintsVerified: {
          readOnly: "yes",
          positionConfigWritten: "no",
          agentsListMutated: "no",
          sessionsSent: "no",
          applied: "no",
        },
      }),
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handlePositionConfigCleanupPlanHttpRequest(
      makeReq("/api/positions/cleanup-plan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
