import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAutoEvolutionHttpRequest, isAutoEvolutionApiPath } from "./server-auto-evolution-api.js";

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

function writeRuntimeEvidence(root: string): void {
  writeJson(path.join(root, "runtime", "main", "tmp", "mirror-observe-2026-05-20T00-01-00-000Z.json"), {
    generatedAt: "2026-05-20T00:01:00.000Z",
    mode: "observe-only",
    stats: {
      observationCount: 4,
      findingCount: 4,
      bySeverity: {
        attention: 2,
        info: 2,
      },
    },
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "d9-promote-gate-dryrun-2026-05-20T00-02-00-000Z.json"), {
    generatedAt: "2026-05-20T00:02:00.000Z",
    mode: "dry-run",
    stats: {
      total: 1,
      byVerdict: {
        FROZEN_BLOCKED: 1,
      },
    },
  });
  writeJson(path.join(root, "system", "kb-index", "index.json"), {
    generatedAt: "2026-05-20T00:03:00.000Z",
    totalItems: 2,
    sourceCaseCount: 1,
    sourceSkillCount: 1,
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "task-hud-state.json"), {
    generatedAt: "2026-05-20T00:04:00.000Z",
    watchdogSnapshot: {
      totalAlerts: 2,
      byCondition: {
        mirrorObserveAttention: 2,
      },
    },
  });
}

describe("server auto-evolution API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-auto-evolution-api-"));
    roots.push(root);
    return root;
  }

  it("matches only auto-evolution API paths", () => {
    expect(isAutoEvolutionApiPath("/api/auto-evolution/state")).toBe(true);
    expect(isAutoEvolutionApiPath("/api/auto-evolution/observe")).toBe(true);
    expect(isAutoEvolutionApiPath("/api/mirror/observe")).toBe(false);
  });

  it("returns unavailable state before the first observe report", async () => {
    const response = makeResponse();
    const handled = await handleAutoEvolutionHttpRequest(makeReq("/api/auto-evolution/state", "GET"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      reportDir: "runtime/main/tmp",
    });
  });

  it("runs observe-only planner and exposes latest report summary", async () => {
    const root = workspace();
    writeRuntimeEvidence(root);

    const observeResponse = makeResponse();
    const handled = await handleAutoEvolutionHttpRequest(makeReq("/api/auto-evolution/observe", "POST"), observeResponse.res, root);

    expect(handled).toBe(true);
    expect(observeResponse.res.statusCode).toBe(200);
    expect(observeResponse.json()).toEqual(expect.objectContaining({
      mode: "observe-only",
      observeOnly: true,
      promoted: "none",
      applied: false,
      autoEvolutionApplied: false,
      continuousAutoLoopTriggered: false,
      constraintsVerified: expect.objectContaining({
        MEMORYWritten: "no",
        ENGINEERING_RULESWritten: "no",
        codeWritten: "no",
        promoted: "none",
        applyPerformed: "no",
        continuousAutoLoopTriggered: "no",
      }),
    }));

    const outputFile = String(observeResponse.json().outputFile);
    expect(existsSync(outputFile)).toBe(true);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual(expect.objectContaining({
      taskId: "DOMAIN11-AUTO-EVOLUTION-OBSERVE-ONLY-A",
      mode: "observe-only",
      constraintsVerified: expect.objectContaining({
        promoted: "none",
        autoEvolutionApplied: "no",
      }),
    }));

    const stateResponse = makeResponse();
    await handleAutoEvolutionHttpRequest(makeReq("/api/auto-evolution/state", "GET"), stateResponse.res, root);
    expect(stateResponse.json()).toEqual(expect.objectContaining({
      available: true,
      mode: "observe-only",
      reportPath: expect.stringMatching(/^runtime\/main\/tmp\/auto-evolution-observe-/u),
      constraintsVerified: expect.objectContaining({
        codeWritten: "no",
        promoted: "none",
        applyPerformed: "no",
      }),
    }));
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handleAutoEvolutionHttpRequest(makeReq("/api/auto-evolution/observe", "GET"), response.res, workspace());

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});
