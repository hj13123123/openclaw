import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleKbHttpRequest, isKbApiPath } from "./server-kb-api.js";

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

describe("server KB API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kb-api-"));
    roots.push(root);
    return root;
  }

  it("matches only KB API paths", () => {
    expect(isKbApiPath("/api/kb/state")).toBe(true);
    expect(isKbApiPath("/api/kb/refresh")).toBe(true);
    expect(isKbApiPath("/api/hud/state")).toBe(false);
  });

  it("returns unavailable state when the index has not been generated", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(makeReq("/api/kb/state", "GET"), response.res, workspaceRoot);

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      indexPath: "system/kb-index/index.json",
    });
  });

  it("refreshes the keyword index and returns state summaries", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
      summary: "Recover task graph state",
      tags: ["D7"],
    });
    writeJson(path.join(workspaceRoot, "system", "skill-library", "skill-a.json"), {
      skillId: "skill-a",
      title: "KB refresh",
      trigger: "refresh keyword index",
      sourceCases: ["case-a"],
      keywords: ["kb-refresh"],
    });

    const refreshResponse = makeResponse();
    const refreshed = await handleKbHttpRequest(
      makeReq("/api/kb/refresh", "POST"),
      refreshResponse.res,
      workspaceRoot,
    );

    expect(refreshed).toBe(true);
    expect(refreshResponse.res.statusCode).toBe(200);
    expect(refreshResponse.json()).toEqual(expect.objectContaining({
      refreshed: true,
      refreshMode: "runtime",
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
      warnings: [],
    }));
    expect(JSON.parse(readFileSync(path.join(workspaceRoot, "system", "kb-index", "index.json"), "utf8"))).toEqual(
      expect.objectContaining({ totalItems: 2 }),
    );

    const stateResponse = makeResponse();
    await handleKbHttpRequest(makeReq("/api/kb/state", "GET"), stateResponse.res, workspaceRoot);
    expect(stateResponse.json()).toEqual(expect.objectContaining({
      available: true,
      indexPath: "system/kb-index/index.json",
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
    }));
  });

  it("rejects wrong methods without changing state", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(makeReq("/api/kb/refresh", "GET"), response.res, workspaceRoot);

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});
