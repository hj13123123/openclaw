import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePromoteGateHttpRequest, isPromoteGateApiPath } from "./server-promote-gate-api.js";

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

function writeCandidateWorkspace(root: string): void {
  writeJson(path.join(root, "system", "case-library", "case-a.json"), {
    caseId: "case-a",
    title: "Reusable gate evidence",
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "distill-candidates", "cand-skill.json"), {
    candidateId: "cand-skill",
    candidateType: "skill",
    title: "Reusable skill",
    confidence: 0.9,
    occurrenceCount: 2,
    sources: [{ sourceType: "case", sourceId: "case-a" }],
    gates: {
      duplicateCheck: "passed",
      conflictCheck: "passed",
      minimumOccurrence: "passed",
      confidenceThreshold: "passed",
    },
  });
  writeJson(path.join(root, "runtime", "main", "tmp", "review-candidates", "review-skill.json"), {
    reviewId: "review-skill",
    candidateId: "cand-skill",
    reviewStatus: "approved",
    checklistResults: {
      evidenceSufficient: true,
      noDuplicate: true,
      noConflict: true,
      notOverfit: true,
      noPrivilegeExpansion: true,
      needsMoreEvidence: false,
      noTruthFileTouch: true,
    },
  });
}

describe("server promote gate API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-promote-gate-api-"));
    roots.push(root);
    return root;
  }

  it("matches only promote gate API paths", () => {
    expect(isPromoteGateApiPath("/api/promote-gate/state")).toBe(true);
    expect(isPromoteGateApiPath("/api/promote-gate/dry-run")).toBe(true);
    expect(isPromoteGateApiPath("/api/kb/state")).toBe(false);
  });

  it("returns unavailable state before the first dry-run report", async () => {
    const response = makeResponse();
    const handled = await handlePromoteGateHttpRequest(
      makeReq("/api/promote-gate/state", "GET"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      reportDir: "runtime/main/tmp",
    });
  });

  it("runs dry-run and exposes the latest report summary", async () => {
    const root = workspace();
    writeCandidateWorkspace(root);

    const dryRunResponse = makeResponse();
    const handled = await handlePromoteGateHttpRequest(
      makeReq("/api/promote-gate/dry-run", "POST"),
      dryRunResponse.res,
      root,
    );

    expect(handled).toBe(true);
    expect(dryRunResponse.res.statusCode).toBe(200);
    expect(dryRunResponse.json()).toEqual(
      expect.objectContaining({
        status: "PASS",
        mode: "dry-run",
        dryRun: true,
        promoted: "none",
        stats: {
          total: 1,
          byVerdict: { READY_FOR_PROMOTE_GATE: 1 },
          byType: { skill: 1 },
        },
      }),
    );

    const outputFile = String(dryRunResponse.json().outputFile);
    expect(existsSync(outputFile)).toBe(true);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual(
      expect.objectContaining({
        mode: "dry-run",
        constraintsVerified: expect.objectContaining({
          MEMORYWritten: "no",
          ENGINEERING_RULESWritten: "no",
          promoted: "none",
        }),
      }),
    );

    const stateResponse = makeResponse();
    await handlePromoteGateHttpRequest(
      makeReq("/api/promote-gate/state", "GET"),
      stateResponse.res,
      root,
    );
    expect(stateResponse.json()).toEqual(
      expect.objectContaining({
        available: true,
        status: "PASS",
        mode: "dry-run",
        stats: {
          total: 1,
          byVerdict: { READY_FOR_PROMOTE_GATE: 1 },
          byType: { skill: 1 },
        },
      }),
    );
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handlePromoteGateHttpRequest(
      makeReq("/api/promote-gate/dry-run", "GET"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});
