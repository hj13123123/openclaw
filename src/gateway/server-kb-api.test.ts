import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSemanticRebuildPlan,
  handleKbHttpRequest,
  isKbApiPath,
  summarizeSemanticBoundary,
} from "./server-kb-api.js";

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
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/state")).toBe(true);
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
      semantic: {
        status: "default",
        mode: "observe-only",
        source: "agents.memorySearch",
        rebuild: "disabled",
        reason: "semantic_vector_refresh_deferred",
        provider: "auto",
        model: null,
        vectorEnabled: true,
        hybridEnabled: true,
        configuredScopes: [],
      },
    });
  });

  it("summarizes semantic vector boundary without starting a rebuild", () => {
    expect(summarizeSemanticBoundary({
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
            query: { hybrid: { enabled: true } },
          },
        },
        list: [
          { id: "curator", memorySearch: { model: "curator-embedding" } },
          { id: "disabled-agent", memorySearch: { enabled: false } },
        ],
      },
    })).toEqual({
      status: "configured",
      mode: "observe-only",
      source: "agents.memorySearch",
      rebuild: "disabled",
      reason: "semantic_vector_refresh_deferred",
      provider: "volcengine",
      model: "doubao-embedding",
      vectorEnabled: true,
      hybridEnabled: true,
      configuredScopes: [
        "agents.defaults",
        "agents.list.curator",
        "agents.list.disabled-agent",
      ],
    });

    expect(summarizeSemanticBoundary({
      agents: {
        defaults: {
          memorySearch: { enabled: false },
        },
        list: [
          { id: "curator", memorySearch: { model: "curator-embedding" } },
        ],
      },
    })).toEqual(expect.objectContaining({
      status: "disabled",
      provider: null,
      model: null,
      vectorEnabled: false,
      hybridEnabled: false,
    }));
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
      semantic: expect.objectContaining({
        status: "default",
        mode: "observe-only",
        rebuild: "disabled",
      }),
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
    }));
  });

  it("builds a semantic rebuild dry-run plan without embedding calls or writes", async () => {
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

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      response.res,
      workspaceRoot,
      {
        config: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "volcengine",
                model: "doubao-embedding",
                store: { vector: { enabled: true } },
              },
            },
          },
        },
      },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual(expect.objectContaining({
      status: "ready",
      mode: "dry-run",
      dryRun: true,
      action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE",
      semantic: expect.objectContaining({
        status: "configured",
        provider: "volcengine",
        model: "doubao-embedding",
      }),
      source: expect.objectContaining({
        totalItems: 2,
        sourceCaseCount: 1,
        sourceSkillCount: 1,
      }),
      plannedBatches: 1,
      plannedOutputs: [
        "system/kb-index/semantic-index.json",
        "system/kb-index/vector-index.sqlite",
        "system/kb-index/semantic-rebuild-report.json",
      ],
      blockedReasons: [],
      constraintsVerified: {
        embeddingCalls: "no",
        fileWrites: "dry-run-report-only",
        keywordIndexWritten: "no",
        vectorIndexWritten: "no",
        applied: "no",
        dryRunReportWritten: "yes",
      },
      reportPath: expect.stringMatching(/^runtime\/main\/tmp\/kb-semantic-rebuild-plan-/),
      outputFile: expect.stringContaining("kb-semantic-rebuild-plan-"),
    }));
    const reportPath = String(json.reportPath);
    expect(JSON.parse(readFileSync(path.join(workspaceRoot, ...reportPath.split("/")), "utf8"))).toEqual(json);
    expect(readFileSync(path.join(workspaceRoot, "system", "case-library", "case-a.json"), "utf8")).toContain("case-a");
    expect(() => readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8")).toThrow();
    expect(() => readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8")).toThrow();
  });

  it("returns the latest semantic rebuild dry-run report state", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const emptyStateResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/state", "GET"),
      emptyStateResponse.res,
      workspaceRoot,
    );
    expect(emptyStateResponse.json()).toEqual(expect.objectContaining({
      available: false,
      mode: "dry-run",
      dryRun: true,
      reportDir: "runtime/main/tmp",
      reportPrefix: "kb-semantic-rebuild-plan-",
    }));

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
    );
    const plan = planResponse.json();

    const stateResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/state", "GET"),
      stateResponse.res,
      workspaceRoot,
    );

    expect(stateResponse.json()).toEqual({
      available: true,
      ...plan,
    });
  });

  it("blocks semantic rebuild planning when vector search is disabled", () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const plan = buildSemanticRebuildPlan(
      workspaceRoot,
      summarizeSemanticBoundary({
        agents: {
          defaults: {
            memorySearch: {
              enabled: false,
              store: { vector: { enabled: false } },
            },
          },
        },
      }),
      "2026-05-21T00:00:00.000Z",
    );

    expect(plan).toEqual(expect.objectContaining({
      status: "blocked",
      mode: "dry-run",
      dryRun: true,
      blockedReasons: [
        "semantic memorySearch is disabled",
        "vector store is disabled",
      ],
      constraintsVerified: expect.objectContaining({
        embeddingCalls: "no",
        fileWrites: "no",
        vectorIndexWritten: "no",
      }),
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

  it("rejects semantic rebuild plan reads", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("rejects semantic rebuild plan state writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/state", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
