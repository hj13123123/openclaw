import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePromotionCandidatesHttpRequest,
  isPromotionCandidatesApiPath,
} from "./server-promotion-candidates-api.js";

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

describe("server promotion candidates API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-promotion-candidates-api-"));
    roots.push(root);
    return root;
  }

  it("matches only promotion candidate scan API paths", () => {
    expect(isPromotionCandidatesApiPath("/api/promotion-candidates/scan")).toBe(true);
    expect(isPromotionCandidatesApiPath("/api/promote-gate/state")).toBe(false);
    expect(isPromotionCandidatesApiPath("/api/recovery-candidates/scan")).toBe(false);
  });

  it("serves observe-only promotion candidate scans", async () => {
    const root = workspace();
    writeJson(path.join(root, "evolution", "promotion-candidates.json"), {
      generatedAt: "2026-05-26T01:00:00.000Z",
      candidates: [
        {
          targetFile: "NEXT_ACTION.md",
          changeType: "append_staleness_note",
          risk: "low",
          proposedSnippet: "<!-- truth-crosscheck: api -->",
          rollback: "Remove the exact truth-crosscheck line",
        },
      ],
    });
    writeJson(path.join(root, "evolution", "candidate-gate-state.json"), {
      lastSyncedAt: "2026-05-26T01:05:00.000Z",
      candidates: [{ index: 0, approvedAt: "2026-05-26T01:06:00.000Z" }],
    });

    const response = makeResponse();
    const handled = await handlePromotionCandidatesHttpRequest(
      makeReq("/api/promotion-candidates/scan"),
      response.res,
      root,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        available: true,
        status: "ok",
        stats: expect.objectContaining({
          total: 1,
          byState: { approved: 1 },
          safeApplyEligible: 1,
        }),
        constraintsVerified: {
          readOnly: "yes",
          candidateStateWritten: "no",
          truthFilesWritten: "no",
          applied: "none",
          rolledBack: "none",
          autoPromote: "disabled",
        },
      }),
    });
  });

  it("rejects wrong methods", async () => {
    const response = makeResponse();
    const handled = await handlePromotionCandidatesHttpRequest(
      makeReq("/api/promotion-candidates/scan", "POST"),
      response.res,
      workspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
