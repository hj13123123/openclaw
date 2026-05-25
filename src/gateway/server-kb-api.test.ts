import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
import {
  buildSemanticRebuildAcceptanceRecordDryRun,
  buildSemanticRebuildApprovalRecordDryRun,
  buildSemanticRebuildExecutionContract,
  buildSemanticRebuildExecutionDryRun,
  buildSemanticRebuildPlan,
  buildDispatchRecallAcceptanceRecordDryRun,
  checkSemanticRebuildProposalAcceptance,
  checkDispatchRecallPreviewAcceptance,
  checkSemanticRebuildExecutionEntry,
  checkSemanticRebuildPreflight,
  executeDispatchRecallPreview,
  executeHybridRecall,
  executeSemanticRebuild,
  executeSemanticSearch,
  getSemanticRebuildStatus,
  handleKbHttpRequest,
  isKbApiPath,
  listDispatchRecallAcceptanceRecords,
  listSemanticRebuildApprovalRecords,
  listSemanticRebuildAcceptanceRecords,
  summarizeSemanticBoundary,
  writeDispatchRecallAcceptanceRecord,
  writeSemanticRebuildAcceptanceRecord,
  writeSemanticRebuildApprovalRecord,
  writeSemanticRebuildExecutionStageRecord,
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

function registerTestEmbeddingProvider(
  calls: string[][],
  overrides: {
    embedQuery?: (text: string) => Promise<number[]>;
    embedBatch?: (texts: string[]) => Promise<number[][]>;
  } = {},
): void {
  registerMemoryEmbeddingProvider({
    id: "test-embed",
    defaultModel: "test-model",
    transport: "remote",
    create: async (createOptions) => ({
      provider: {
        id: "test-embed",
        model: createOptions.model,
        embedQuery: async (text) => overrides.embedQuery?.(text) ?? [1, 0, 0],
        embedBatch: async (texts) => {
          calls.push(texts);
          return (
            overrides.embedBatch?.(texts) ??
            texts.map((_, index) => [index + 1, index + 2, index + 3])
          );
        },
      },
    }),
  });
}

function semanticRebuildConfig() {
  return {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          provider: "test-embed",
          fallback: "none",
          model: "test-model",
          store: { vector: { enabled: true } },
        },
      },
    },
  };
}

async function prepareApprovedSemanticRebuild(
  workspaceRoot: string,
  config: ReturnType<typeof semanticRebuildConfig>,
) {
  await handleKbHttpRequest(
    makeReq("/api/kb/semantic-rebuild-plan", "POST"),
    makeResponse().res,
    workspaceRoot,
    { config },
  );
  const acceptance = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
  expect(acceptance.wrote).toBe(true);
  const approval = await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });
  expect(approval.wrote).toBe(true);
}

describe("server KB API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    clearMemoryEmbeddingProviders();
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
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/status")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/acceptance")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/acceptance-records")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-preflight")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-dry-run")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-approval")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-approval-records")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-execution")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-execution-contract")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-execution-stage")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-execution-run")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-search")).toBe(true);
    expect(isKbApiPath("/api/kb/hybrid-recall")).toBe(true);
    expect(isKbApiPath("/api/kb/dispatch-recall-preview")).toBe(true);
    expect(isKbApiPath("/api/kb/dispatch-recall-preview/acceptance")).toBe(true);
    expect(isKbApiPath("/api/kb/dispatch-recall-preview/acceptance-record-dry-run")).toBe(true);
    expect(isKbApiPath("/api/kb/dispatch-recall-preview/acceptance-records")).toBe(true);
    expect(isKbApiPath("/api/hud/state")).toBe(false);
  });

  it("returns unavailable state when the index has not been generated", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/state", "GET"),
      response.res,
      workspaceRoot,
    );

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
    expect(
      summarizeSemanticBoundary({
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
      }),
    ).toEqual({
      status: "configured",
      mode: "observe-only",
      source: "agents.memorySearch",
      rebuild: "disabled",
      reason: "semantic_vector_refresh_deferred",
      provider: "volcengine",
      model: "doubao-embedding",
      vectorEnabled: true,
      hybridEnabled: true,
      configuredScopes: ["agents.defaults", "agents.list.curator", "agents.list.disabled-agent"],
    });

    expect(
      summarizeSemanticBoundary({
        agents: {
          defaults: {
            memorySearch: { enabled: false },
          },
          list: [{ id: "curator", memorySearch: { model: "curator-embedding" } }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        status: "disabled",
        provider: null,
        model: null,
        vectorEnabled: false,
        hybridEnabled: false,
      }),
    );
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
    expect(refreshResponse.json()).toEqual(
      expect.objectContaining({
        refreshed: true,
        refreshMode: "runtime",
        totalItems: 2,
        sourceCaseCount: 1,
        sourceSkillCount: 1,
        warnings: [],
      }),
    );
    expect(
      JSON.parse(
        readFileSync(path.join(workspaceRoot, "system", "kb-index", "index.json"), "utf8"),
      ),
    ).toEqual(expect.objectContaining({ totalItems: 2 }));

    const stateResponse = makeResponse();
    await handleKbHttpRequest(makeReq("/api/kb/state", "GET"), stateResponse.res, workspaceRoot);
    expect(stateResponse.json()).toEqual(
      expect.objectContaining({
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
      }),
    );
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
    expect(json).toEqual(
      expect.objectContaining({
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
      }),
    );
    const reportPath = String(json.reportPath);
    expect(
      JSON.parse(readFileSync(path.join(workspaceRoot, ...reportPath.split("/")), "utf8")),
    ).toEqual(json);
    expect(
      readFileSync(path.join(workspaceRoot, "system", "case-library", "case-a.json"), "utf8"),
    ).toContain("case-a");
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
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
    expect(emptyStateResponse.json()).toEqual(
      expect.objectContaining({
        available: false,
        mode: "dry-run",
        dryRun: true,
        reportDir: "runtime/main/tmp",
        reportPrefix: "kb-semantic-rebuild-plan-",
      }),
    );

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

  it("builds semantic rebuild acceptance dry-run without writing approval state", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
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
    const plan = planResponse.json();

    const acceptanceResponse = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/acceptance", "GET"),
      acceptanceResponse.res,
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
    expect(acceptanceResponse.res.statusCode).toBe(200);
    const json = acceptanceResponse.json();
    expect(json).toEqual(
      expect.objectContaining({
        mode: "acceptance-record-dry-run",
        proposalPath: plan.reportPath,
        wouldWrite: false,
        wouldWritePath: expect.stringMatching(
          /^runtime\/main\/tmp\/kb-semantic-rebuild-acceptance-/,
        ),
        acceptance: expect.objectContaining({
          status: "ready_for_human_gate",
          readyForHumanGate: true,
          blockReasons: [],
          proposalPath: plan.reportPath,
        }),
        recordPreview: expect.objectContaining({
          proposalPath: plan.reportPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_human_approval",
          approved: false,
          rebuildTriggered: false,
        }),
        constraintsVerified: {
          recordWritten: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(
        path.join(workspaceRoot, "runtime", "main", "tmp", "kb-semantic-rebuild-acceptance.json"),
        "utf8",
      ),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild acceptance when the proposal has drifted", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
    );
    writeJson(path.join(workspaceRoot, "system", "skill-library", "skill-a.json"), {
      skillId: "skill-a",
      title: "KB refresh",
    });

    const acceptance = await checkSemanticRebuildProposalAcceptance(workspaceRoot);

    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "blocked",
        readyForHumanGate: false,
        blockReasons: ["source_summary_drift"],
        proposalSummary: expect.objectContaining({
          totalItems: 1,
          plannedBatches: 1,
        }),
        currentSummary: expect.objectContaining({
          totalItems: 2,
          plannedBatches: 1,
        }),
      }),
    );
  });

  it("returns missing semantic rebuild acceptance when no proposal exists", async () => {
    const dryRun = await buildSemanticRebuildAcceptanceRecordDryRun(makeWorkspace());

    expect(dryRun).toEqual(
      expect.objectContaining({
        mode: "acceptance-record-dry-run",
        proposalPath: null,
        wouldWrite: false,
        wouldWritePath: null,
        recordPreview: null,
        acceptance: expect.objectContaining({
          status: "missing",
          readyForHumanGate: false,
          blockReasons: ["proposal_missing"],
        }),
      }),
    );
  });

  it("writes a human-gated semantic rebuild acceptance record without rebuilding vectors", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
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
    const plan = planResponse.json();

    const writeResponse = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/acceptance", "POST"),
      writeResponse.res,
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
    expect(writeResponse.res.statusCode).toBe(201);
    const json = writeResponse.json();
    expect(json).toEqual(
      expect.objectContaining({
        mode: "acceptance-record-write",
        proposalPath: plan.reportPath,
        wrote: true,
        recordPath: expect.stringMatching(/^runtime\/main\/tmp\/kb-semantic-rebuild-acceptance-/),
        acceptance: expect.objectContaining({
          status: "ready_for_human_gate",
          readyForHumanGate: true,
          blockReasons: [],
        }),
        record: expect.objectContaining({
          mode: "acceptance-record",
          status: "human_gate_ready",
          proposalPath: plan.reportPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_human_approval",
          approved: false,
          rebuildTriggered: false,
        }),
        constraintsVerified: {
          recordWritten: "yes",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    const recordPath = String(json.recordPath);
    const persisted = JSON.parse(
      readFileSync(path.join(workspaceRoot, ...recordPath.split("/")), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(json.record);
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild acceptance record writes when the proposal is not ready", async () => {
    const write = await writeSemanticRebuildAcceptanceRecord(makeWorkspace());

    expect(write).toEqual(
      expect.objectContaining({
        mode: "acceptance-record-write",
        proposalPath: null,
        wrote: false,
        recordPath: null,
        record: null,
        acceptance: expect.objectContaining({
          status: "missing",
          readyForHumanGate: false,
          blockReasons: ["proposal_missing"],
        }),
        constraintsVerified: expect.objectContaining({
          recordWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("lists semantic rebuild acceptance records without mutating rebuild state", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
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
    const write = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, {
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
    });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/acceptance-records", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "acceptance-record-list",
        reportDir: "runtime/main/tmp",
        reportPrefix: "kb-semantic-rebuild-acceptance-",
        totalRecords: 1,
        returnedRecords: 1,
        invalidRecords: 0,
        records: [
          expect.objectContaining({
            recordPath: write.recordPath,
            acceptanceId: write.record?.acceptanceId,
            status: "human_gate_ready",
            proposalPath: write.proposalPath,
            plannedBatches: 1,
            totalItems: 1,
            requiredApproval: "human",
            nextAction: "await_human_approval",
            approved: false,
            rebuildTriggered: false,
            constraintsVerified: expect.objectContaining({
              recordWritten: "yes",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        ],
        constraintsVerified: {
          fileWrites: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("returns an empty semantic rebuild acceptance record list when no records exist", async () => {
    expect(await listSemanticRebuildAcceptanceRecords(makeWorkspace())).toEqual({
      available: false,
      mode: "acceptance-record-list",
      reportDir: "runtime/main/tmp",
      reportPrefix: "kb-semantic-rebuild-acceptance-",
      totalRecords: 0,
      returnedRecords: 0,
      invalidRecords: 0,
      records: [],
      constraintsVerified: {
        fileWrites: "no",
        embeddingCalls: "no",
        keywordIndexWritten: "no",
        vectorIndexWritten: "no",
        realRebuildTriggered: "no",
        applied: "no",
      },
    });
  });

  it("checks semantic rebuild preflight without mutating rebuild state", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
      { config },
    );
    const plan = planResponse.json();
    const write = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-preflight", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "semantic-rebuild-preflight",
        status: "ready_for_rebuild_human_approval",
        readyForRebuildHumanApproval: true,
        blockReasons: [],
        recordPath: write.recordPath,
        acceptanceRecord: expect.objectContaining({
          recordPath: write.recordPath,
          status: "human_gate_ready",
          proposalPath: plan.reportPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_human_approval",
          approved: false,
          rebuildTriggered: false,
        }),
        acceptance: expect.objectContaining({
          status: "ready_for_human_gate",
          readyForHumanGate: true,
          blockReasons: [],
          proposalPath: plan.reportPath,
        }),
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild preflight when no acceptance record exists", async () => {
    const preflight = await checkSemanticRebuildPreflight(makeWorkspace());

    expect(preflight).toEqual(
      expect.objectContaining({
        available: false,
        mode: "semantic-rebuild-preflight",
        status: "blocked",
        readyForRebuildHumanApproval: false,
        blockReasons: ["acceptance_record_missing", "proposal_missing"],
        recordPath: null,
        acceptanceRecord: null,
        acceptance: expect.objectContaining({
          status: "missing",
          readyForHumanGate: false,
        }),
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("blocks semantic rebuild preflight when the latest acceptance record is invalid", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(
      path.join(
        workspaceRoot,
        "runtime",
        "main",
        "tmp",
        "kb-semantic-rebuild-acceptance-9999.json",
      ),
      { mode: "acceptance-record", approved: true },
    );

    const preflight = await checkSemanticRebuildPreflight(workspaceRoot);

    expect(preflight).toEqual(
      expect.objectContaining({
        available: false,
        status: "blocked",
        readyForRebuildHumanApproval: false,
        blockReasons: ["acceptance_record_invalid", "proposal_missing"],
        recordPath: "runtime/main/tmp/kb-semantic-rebuild-acceptance-9999.json",
        acceptanceRecord: null,
      }),
    );
  });

  it("blocks semantic rebuild preflight when the proposal has drifted", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
    );
    await writeSemanticRebuildAcceptanceRecord(workspaceRoot);
    writeJson(path.join(workspaceRoot, "system", "skill-library", "skill-a.json"), {
      skillId: "skill-a",
      title: "KB refresh",
    });

    const preflight = await checkSemanticRebuildPreflight(workspaceRoot);

    expect(preflight).toEqual(
      expect.objectContaining({
        available: true,
        status: "blocked",
        readyForRebuildHumanApproval: false,
        blockReasons: ["source_summary_drift"],
        acceptanceRecord: expect.objectContaining({
          plannedBatches: 1,
          totalItems: 1,
        }),
        acceptance: expect.objectContaining({
          readyForHumanGate: false,
          blockReasons: ["source_summary_drift"],
          currentSummary: expect.objectContaining({
            totalItems: 2,
          }),
        }),
      }),
    );
  });

  it("builds a human-gated semantic rebuild execution dry-run without rebuilding vectors", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
      { config },
    );
    const plan = planResponse.json();
    const write = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-dry-run", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "semantic-rebuild-execution-dry-run",
        status: "ready_for_execution_human_gate",
        wouldExecute: false,
        readyForExecutionHumanGate: true,
        blockReasons: [],
        preflight: expect.objectContaining({
          status: "ready_for_rebuild_human_approval",
          readyForRebuildHumanApproval: true,
          recordPath: write.recordPath,
        }),
        plannedExecution: expect.objectContaining({
          acceptanceId: write.record?.acceptanceId,
          proposalId: write.record?.proposalId,
          proposalPath: plan.reportPath,
          recordPath: write.recordPath,
          provider: "volcengine",
          model: "doubao-embedding",
          totalItems: 1,
          plannedBatches: 1,
          plannedOutputs: [
            "system/kb-index/semantic-index.json",
            "system/kb-index/vector-index.sqlite",
            "system/kb-index/semantic-rebuild-report.json",
          ],
          plannedSteps: expect.arrayContaining([
            "read case-library and skill-library sources",
            "plan embedding batches",
            "stop before real rebuild until explicit human approval",
          ]),
          requiredApproval: "human",
          nextAction: "await_human_rebuild_approval",
          wouldCallEmbeddingProvider: false,
          wouldWriteSemanticIndex: false,
          wouldWriteVectorIndex: false,
        }),
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild execution dry-run when preflight is not ready", async () => {
    const dryRun = await buildSemanticRebuildExecutionDryRun(makeWorkspace());

    expect(dryRun).toEqual(
      expect.objectContaining({
        available: false,
        mode: "semantic-rebuild-execution-dry-run",
        status: "blocked",
        wouldExecute: false,
        readyForExecutionHumanGate: false,
        blockReasons: ["acceptance_record_missing", "proposal_missing"],
        plannedExecution: null,
        preflight: expect.objectContaining({
          status: "blocked",
          readyForRebuildHumanApproval: false,
        }),
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("previews a semantic rebuild approval record without rebuilding vectors", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    const acceptanceWrite = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-approval", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual(
      expect.objectContaining({
        mode: "rebuild-approval-record-dry-run",
        wouldWrite: false,
        wouldWritePath: expect.stringMatching(/^runtime\/main\/tmp\/kb-semantic-rebuild-approval-/),
        dryRun: expect.objectContaining({
          status: "ready_for_execution_human_gate",
          readyForExecutionHumanGate: true,
        }),
        recordPreview: expect.objectContaining({
          status: "rebuild_human_approved",
          acceptanceId: acceptanceWrite.record?.acceptanceId,
          proposalId: acceptanceWrite.record?.proposalId,
          acceptanceRecordPath: acceptanceWrite.recordPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_rebuild_execution",
          approved: true,
          rebuildTriggered: false,
        }),
        constraintsVerified: {
          approvalRecordWritten: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, ...String(json.wouldWritePath).split("/")), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("writes a semantic rebuild approval record without triggering rebuild execution", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    const acceptanceWrite = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-approval", "POST"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(201);
    const json = response.json();
    expect(json).toEqual(
      expect.objectContaining({
        mode: "rebuild-approval-record-write",
        wrote: true,
        recordPath: expect.stringMatching(/^runtime\/main\/tmp\/kb-semantic-rebuild-approval-/),
        dryRun: expect.objectContaining({
          status: "ready_for_execution_human_gate",
          wouldExecute: false,
        }),
        record: expect.objectContaining({
          mode: "rebuild-approval-record",
          status: "rebuild_human_approved",
          acceptanceId: acceptanceWrite.record?.acceptanceId,
          proposalId: acceptanceWrite.record?.proposalId,
          acceptanceRecordPath: acceptanceWrite.recordPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_rebuild_execution",
          approved: true,
          rebuildTriggered: false,
          constraintsVerified: {
            approvalRecordWritten: "yes",
            stateWritten: "no",
            embeddingCalls: "no",
            keywordIndexWritten: "no",
            vectorIndexWritten: "no",
            realRebuildTriggered: "no",
            applied: "no",
          },
        }),
        constraintsVerified: {
          approvalRecordWritten: "yes",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    const persisted = JSON.parse(
      readFileSync(path.join(workspaceRoot, ...String(json.recordPath).split("/")), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(json.record);
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild approval writes when execution dry-run is not ready", async () => {
    const write = await writeSemanticRebuildApprovalRecord(makeWorkspace());

    expect(write).toEqual(
      expect.objectContaining({
        mode: "rebuild-approval-record-write",
        wrote: false,
        recordPath: null,
        record: null,
        dryRun: expect.objectContaining({
          status: "blocked",
          readyForExecutionHumanGate: false,
        }),
        constraintsVerified: expect.objectContaining({
          approvalRecordWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("returns missing semantic rebuild approval dry-run when execution dry-run is not ready", async () => {
    const dryRun = await buildSemanticRebuildApprovalRecordDryRun(makeWorkspace());

    expect(dryRun).toEqual(
      expect.objectContaining({
        mode: "rebuild-approval-record-dry-run",
        wouldWrite: false,
        wouldWritePath: null,
        recordPreview: null,
        dryRun: expect.objectContaining({
          status: "blocked",
          readyForExecutionHumanGate: false,
        }),
        constraintsVerified: expect.objectContaining({
          approvalRecordWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("lists semantic rebuild approval records without triggering rebuild execution", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    const approvalWrite = await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-approval-records", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "rebuild-approval-record-list",
        reportDir: "runtime/main/tmp",
        reportPrefix: "kb-semantic-rebuild-approval-",
        totalRecords: 1,
        returnedRecords: 1,
        invalidRecords: 0,
        latestRecord: expect.objectContaining({
          recordPath: approvalWrite.recordPath,
          approvalId: approvalWrite.record?.approvalId,
          status: "rebuild_human_approved",
          acceptanceId: approvalWrite.record?.acceptanceId,
          proposalId: approvalWrite.record?.proposalId,
          proposalPath: approvalWrite.record?.proposalPath,
          acceptanceRecordPath: approvalWrite.record?.acceptanceRecordPath,
          plannedBatches: 1,
          totalItems: 1,
          requiredApproval: "human",
          nextAction: "await_rebuild_execution",
          approved: true,
          rebuildTriggered: false,
        }),
        records: [
          expect.objectContaining({
            recordPath: approvalWrite.recordPath,
            approvalId: approvalWrite.record?.approvalId,
            constraintsVerified: expect.objectContaining({
              approvalRecordWritten: "yes",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        ],
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("returns an empty semantic rebuild approval record list when no records exist", async () => {
    expect(await listSemanticRebuildApprovalRecords(makeWorkspace())).toEqual({
      available: false,
      mode: "rebuild-approval-record-list",
      reportDir: "runtime/main/tmp",
      reportPrefix: "kb-semantic-rebuild-approval-",
      totalRecords: 0,
      returnedRecords: 0,
      invalidRecords: 0,
      latestRecord: null,
      records: [],
      constraintsVerified: {
        fileWrites: "no",
        stateWritten: "no",
        embeddingCalls: "no",
        keywordIndexWritten: "no",
        vectorIndexWritten: "no",
        realRebuildTriggered: "no",
        applied: "no",
      },
    });
  });

  it("reports semantic rebuild execution entry ready without executing rebuild", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    const approvalWrite = await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution", "POST"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "semantic-rebuild-execution-entry",
        requestMethod: "POST",
        status: "ready_for_real_rebuild_implementation",
        wouldExecute: false,
        executed: false,
        readyForRealRebuildImplementation: true,
        blockReasons: [],
        latestApprovalRecord: expect.objectContaining({
          recordPath: approvalWrite.recordPath,
          approvalId: approvalWrite.record?.approvalId,
          status: "rebuild_human_approved",
          approved: true,
          rebuildTriggered: false,
        }),
        approvalRecords: expect.objectContaining({
          available: true,
          latestRecord: expect.objectContaining({
            recordPath: approvalWrite.recordPath,
          }),
        }),
        dryRun: expect.objectContaining({
          status: "ready_for_execution_human_gate",
          wouldExecute: false,
          readyForExecutionHumanGate: true,
        }),
        nextAction: "run_real_rebuild_executor",
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild execution entry when approval is missing", async () => {
    const entry = await checkSemanticRebuildExecutionEntry(makeWorkspace());

    expect(entry).toEqual(
      expect.objectContaining({
        available: false,
        mode: "semantic-rebuild-execution-entry",
        requestMethod: "GET",
        status: "blocked",
        wouldExecute: false,
        executed: false,
        readyForRealRebuildImplementation: false,
        blockReasons: [
          "approval_record_missing",
          "execution_dry_run_not_ready",
          "acceptance_record_missing",
          "proposal_missing",
        ],
        latestApprovalRecord: null,
        approvalRecords: expect.objectContaining({
          available: false,
          records: [],
        }),
        dryRun: expect.objectContaining({
          status: "blocked",
          readyForExecutionHumanGate: false,
        }),
        nextAction: "resolve_blockers",
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("blocks semantic rebuild execution entry when the latest approval record is invalid", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(
      path.join(workspaceRoot, "runtime", "main", "tmp", "kb-semantic-rebuild-approval-9999.json"),
      { mode: "rebuild-approval-record", approved: false },
    );

    const entry = await checkSemanticRebuildExecutionEntry(workspaceRoot);

    expect(entry).toEqual(
      expect.objectContaining({
        available: false,
        status: "blocked",
        wouldExecute: false,
        executed: false,
        readyForRealRebuildImplementation: false,
        blockReasons: [
          "approval_record_invalid",
          "execution_dry_run_not_ready",
          "acceptance_record_missing",
          "proposal_missing",
        ],
        latestApprovalRecord: null,
        approvalRecords: expect.objectContaining({
          totalRecords: 1,
          returnedRecords: 0,
          invalidRecords: 1,
        }),
      }),
    );
  });

  it("returns semantic rebuild execution contract without executing rebuild", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    const acceptanceWrite = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    const approvalWrite = await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });
    const expectedIdempotencyKey = `semantic-rebuild:${approvalWrite.record?.proposalId}:${approvalWrite.record?.approvalId}`;

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-contract", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "semantic-rebuild-execution-contract",
        status: "ready_for_executor_contract",
        readyForExecutorContract: true,
        wouldExecute: false,
        executed: false,
        blockReasons: [],
        executionEntry: expect.objectContaining({
          status: "ready_for_real_rebuild_implementation",
          readyForRealRebuildImplementation: true,
          wouldExecute: false,
          executed: false,
          nextAction: "run_real_rebuild_executor",
        }),
        executorInput: expect.objectContaining({
          contractVersion: "v1",
          action: "SEMANTIC_VECTOR_REBUILD",
          idempotencyKey: expectedIdempotencyKey,
          workspaceRoot,
          sourceIndexPath: "system/kb-index/index.json",
          executionRecordPath: expect.stringContaining(
            "runtime/main/tmp/kb-semantic-rebuild-execution-",
          ),
          proposal: expect.objectContaining({
            proposalId: approvalWrite.record?.proposalId,
            proposalPath: approvalWrite.record?.proposalPath,
          }),
          acceptance: {
            acceptanceId: acceptanceWrite.record?.acceptanceId,
            acceptanceRecordPath: acceptanceWrite.recordPath,
          },
          approval: {
            approvalId: approvalWrite.record?.approvalId,
            approvalRecordPath: approvalWrite.recordPath,
          },
          semantic: {
            provider: "volcengine",
            model: "doubao-embedding",
          },
          batchPlan: {
            totalItems: 1,
            plannedBatches: 1,
            maxItemsPerBatch: 100,
          },
          plannedOutputs: {
            semanticIndexPath: "system/kb-index/semantic-index.json",
            vectorIndexPath: "system/kb-index/vector-index.sqlite",
            rebuildReportPath: "system/kb-index/semantic-rebuild-report.json",
          },
          stagedOutputs: {
            semanticIndexPath: expect.stringContaining(
              "runtime/main/tmp/semantic-rebuild-staging/",
            ),
            vectorIndexPath: expect.stringContaining("runtime/main/tmp/semantic-rebuild-staging/"),
            rebuildReportPath: expect.stringContaining(
              "runtime/main/tmp/semantic-rebuild-staging/",
            ),
          },
          executionPolicy: {
            requiredApproval: "human",
            approvedBy: "rebuild-approval-record",
            embeddingCallsAllowed: true,
            semanticIndexWritesAllowed: true,
            vectorIndexWritesAllowed: true,
            atomicWritesRequired: true,
            realRebuildExecutorImplemented: true,
            nextAction: "run_real_rebuild_executor",
          },
        }),
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("blocks semantic rebuild execution contract when gate records are missing", async () => {
    const contract = await buildSemanticRebuildExecutionContract(makeWorkspace());

    expect(contract).toEqual(
      expect.objectContaining({
        available: false,
        mode: "semantic-rebuild-execution-contract",
        status: "blocked",
        readyForExecutorContract: false,
        wouldExecute: false,
        executed: false,
        blockReasons: [
          "approval_record_missing",
          "execution_dry_run_not_ready",
          "acceptance_record_missing",
          "proposal_missing",
        ],
        executorInput: null,
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("writes a staged semantic rebuild execution record and manifest without rebuilding vectors", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-stage", "POST"),
      response.res,
      workspaceRoot,
      { config },
    );
    const body = response.json();

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(201);
    expect(body).toEqual(
      expect.objectContaining({
        mode: "semantic-rebuild-execution-stage-write",
        status: "staged_manifest_written",
        readyForStagedExecution: true,
        wrote: true,
        idempotentReplay: false,
        blockReasons: [],
        recordPath: expect.stringMatching(/^runtime\/main\/tmp\/kb-semantic-rebuild-execution-/u),
        manifestPath: expect.stringMatching(
          /^runtime\/main\/tmp\/semantic-rebuild-staging\/semantic-rebuild-/u,
        ),
        record: expect.objectContaining({
          mode: "semantic-rebuild-execution-stage-record",
          status: "staged_manifest_written",
          wouldExecute: false,
          executed: false,
          manifest: expect.objectContaining({
            manifestVersion: "v1",
            totalItems: 1,
            plannedBatches: 1,
            batches: [
              {
                batchId: "batch-0001",
                itemOffset: 0,
                itemLimit: 1,
                itemCount: 1,
              },
            ],
          }),
          constraintsVerified: expect.objectContaining({
            fileWrites: "staged-execution-record-and-manifest-only",
            embeddingCalls: "no",
            vectorIndexWritten: "no",
            realRebuildTriggered: "no",
            applied: "no",
          }),
        }),
      }),
    );

    const recordPath = String(body.recordPath);
    const manifestPath = String(body.manifestPath);
    expect(
      JSON.parse(readFileSync(path.join(workspaceRoot, ...recordPath.split("/")), "utf8")),
    ).toEqual(expect.objectContaining({ mode: "semantic-rebuild-execution-stage-record" }));
    expect(
      JSON.parse(readFileSync(path.join(workspaceRoot, ...manifestPath.split("/")), "utf8")),
    ).toEqual(expect.objectContaining({ manifestVersion: "v1" }));
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
  });

  it("replays staged semantic rebuild execution writes idempotently", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      makeResponse().res,
      workspaceRoot,
      { config },
    );
    await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });

    const first = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, { config });
    const second = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, { config });

    expect(first).toEqual(
      expect.objectContaining({
        wrote: true,
        idempotentReplay: false,
        recordPath: expect.any(String),
      }),
    );
    expect(second).toEqual(
      expect.objectContaining({
        wrote: false,
        idempotentReplay: true,
        recordPath: first.recordPath,
        manifestPath: first.manifestPath,
      }),
    );
    expect(second.record?.createdAt).toBe(first.record?.createdAt);
  });

  it("refreshes stale staged semantic rebuild execution metadata", async () => {
    const workspaceRoot = makeWorkspace();
    const config = semanticRebuildConfig();
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });
    await prepareApprovedSemanticRebuild(workspaceRoot, config);

    const first = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, { config });
    expect(first.recordPath).toEqual(expect.any(String));
    expect(first.manifestPath).toEqual(expect.any(String));

    const recordFile = path.join(workspaceRoot, ...first.recordPath!.split("/"));
    const manifestFile = path.join(workspaceRoot, ...first.manifestPath!.split("/"));
    const stale = JSON.parse(readFileSync(recordFile, "utf8")) as {
      contract: { executionPolicy: Record<string, unknown> };
      manifest: { executionPolicy: Record<string, unknown> };
    };
    const stalePolicy = {
      ...stale.contract.executionPolicy,
      embeddingCallsAllowed: false,
      semanticIndexWritesAllowed: false,
      vectorIndexWritesAllowed: false,
      realRebuildExecutorImplemented: false,
      nextAction: "implement_real_rebuild_executor",
    };
    stale.contract.executionPolicy = stalePolicy;
    stale.manifest.executionPolicy = stalePolicy;
    writeJson(recordFile, stale);
    writeJson(manifestFile, stale.manifest);

    const refreshed = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, { config });
    const refreshedManifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      executionPolicy: { embeddingCallsAllowed: boolean };
    };

    expect(refreshed).toEqual(
      expect.objectContaining({
        wrote: true,
        idempotentReplay: false,
        recordPath: first.recordPath,
        manifestPath: first.manifestPath,
      }),
    );
    expect(refreshed.record?.contract.executionPolicy.embeddingCallsAllowed).toBe(true);
    expect(refreshed.record?.manifest.executionPolicy.embeddingCallsAllowed).toBe(true);
    expect(refreshedManifest.executionPolicy.embeddingCallsAllowed).toBe(true);
  });

  it("blocks staged semantic rebuild execution writes when the contract is not ready", async () => {
    const stage = await writeSemanticRebuildExecutionStageRecord(makeWorkspace());

    expect(stage).toEqual(
      expect.objectContaining({
        mode: "semantic-rebuild-execution-stage-write",
        status: "blocked",
        readyForStagedExecution: false,
        wrote: false,
        idempotentReplay: false,
        recordPath: null,
        manifestPath: null,
        blockReasons: expect.arrayContaining(["executor_contract_not_ready"]),
        record: null,
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("executes a real semantic rebuild into staged and active outputs", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls);
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

    await prepareApprovedSemanticRebuild(workspaceRoot, config);

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-run", "POST"),
      response.res,
      workspaceRoot,
      { config },
    );
    const body = response.json();

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(body).toEqual(
      expect.objectContaining({
        mode: "semantic-rebuild-execution-run",
        status: "applied",
        readyForExecution: true,
        executed: true,
        idempotentReplay: false,
        totalItems: 2,
        batchesExecuted: 1,
        embeddingDimensions: 3,
        provider: "test-embed",
        model: "test-model",
        constraintsVerified: {
          fileWrites: "staged-and-active-semantic-vector-indexes",
          stateWritten: "no",
          embeddingCalls: "yes",
          keywordIndexWritten: "no",
          semanticIndexWritten: "yes",
          vectorIndexWritten: "yes",
          realRebuildTriggered: "yes",
          applied: "yes",
        },
      }),
    );

    const semanticIndex = JSON.parse(
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(semanticIndex).toEqual(
      expect.objectContaining({
        version: "v1",
        totalItems: 2,
        provider: "test-embed",
        model: "test-model",
        dimensions: 3,
      }),
    );
    expect(semanticIndex.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "case-a", vectorId: "case:case-a" }),
        expect.objectContaining({ itemId: "skill-a", vectorId: "skill:skill-a" }),
      ]),
    );

    const activeReport = JSON.parse(
      readFileSync(
        path.join(workspaceRoot, "system", "kb-index", "semantic-rebuild-report.json"),
        "utf8",
      ),
    );
    expect(activeReport).toEqual(
      expect.objectContaining({
        mode: "semantic-rebuild-execution-run-report",
        status: "applied",
        totalItems: 2,
      }),
    );

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(
      path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"),
    );
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM vectors").get() as {
        count: number | bigint;
      };
      expect(Number(count.count)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("replays real semantic rebuild execution without another embedding call", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls);
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });
    await prepareApprovedSemanticRebuild(workspaceRoot, config);

    const first = await executeSemanticRebuild(workspaceRoot, { config });
    const second = await executeSemanticRebuild(workspaceRoot, { config });

    expect(first).toEqual(expect.objectContaining({ status: "applied", executed: true }));
    expect(second).toEqual(
      expect.objectContaining({
        status: "applied",
        executed: false,
        idempotentReplay: true,
        totalItems: 1,
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("runs read-only semantic search against active vector outputs", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls, {
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts) =>
        texts.map((text) => (text.includes("Task graph recovery") ? [1, 0, 0] : [0, 1, 0])),
    });
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
      summary: "Recover task graph state",
    });
    writeJson(path.join(workspaceRoot, "system", "skill-library", "skill-a.json"), {
      skillId: "skill-a",
      title: "KB refresh",
      trigger: "refresh keyword index",
      sourceCases: ["case-a"],
    });
    await prepareApprovedSemanticRebuild(workspaceRoot, config);
    await executeSemanticRebuild(workspaceRoot, { config });

    const search = await executeSemanticSearch(
      workspaceRoot,
      { query: "graph recovery", limit: 1 },
      { config },
    );

    expect(search).toEqual(
      expect.objectContaining({
        mode: "semantic-search",
        status: "ready",
        ready: true,
        provider: "test-embed",
        model: "test-model",
        embeddingDimensions: 3,
        totalIndexed: 2,
        totalVectors: 2,
        returnedResults: 1,
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "yes",
          keywordIndexWritten: "no",
          semanticIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(search.results[0]).toEqual(
      expect.objectContaining({
        vectorId: "case:case-a",
        item: expect.objectContaining({ itemId: "case-a" }),
        score: 1,
      }),
    );
  });

  it("serves read-only semantic search over HTTP query params", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls, {
      embedQuery: async () => [1, 0, 0],
      embedBatch: async () => [[1, 0, 0]],
    });
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });
    await prepareApprovedSemanticRebuild(workspaceRoot, config);
    await executeSemanticRebuild(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-search?q=graph&limit=1", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "semantic-search",
        status: "ready",
        query: "graph",
        limit: 1,
        returnedResults: 1,
      }),
    );
  });

  it("blocks semantic search when the query is missing", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-search", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "semantic-search",
        status: "blocked",
        ready: false,
        blockReasons: ["query_missing"],
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
        }),
      }),
    );
  });

  it("combines keyword and semantic results for read-only hybrid recall", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls, {
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts) =>
        texts.map((text) => (text.includes("Task graph recovery") ? [1, 0, 0] : [0, 1, 0])),
    });
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
    });

    const refreshResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/refresh", "POST"),
      refreshResponse.res,
      workspaceRoot,
    );
    expect(refreshResponse.res.statusCode).toBe(200);
    await prepareApprovedSemanticRebuild(workspaceRoot, config);
    await executeSemanticRebuild(workspaceRoot, { config });

    const recall = await executeHybridRecall(
      workspaceRoot,
      { query: "task graph recovery", limit: 2 },
      { config },
    );

    expect(recall).toEqual(
      expect.objectContaining({
        mode: "hybrid-recall",
        status: "ready",
        ready: true,
        query: "task graph recovery",
        limit: 2,
        provider: "test-embed",
        model: "test-model",
        embeddingDimensions: 3,
        totalIndexed: 2,
        totalVectors: 2,
        keywordReturned: 1,
        semanticReturned: 2,
        returnedResults: 2,
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "yes",
          keywordIndexWritten: "no",
          semanticIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(recall.results[0]).toEqual(
      expect.objectContaining({
        vectorId: "case:case-a",
        sources: ["keyword", "semantic"],
        keywordScore: 1,
        semanticScore: 1,
        score: 1,
        item: expect.objectContaining({ itemId: "case-a" }),
      }),
    );
  });

  it("serves hybrid recall over HTTP query params", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/hybrid-recall", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "hybrid-recall",
        status: "blocked",
        ready: false,
        blockReasons: ["query_missing"],
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          embeddingCalls: "no",
          realRebuildTriggered: "no",
        }),
      }),
    );
  });

  it("previews runtime-loop dispatch candidates with hybrid recall without dispatching", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[][] = [];
    const config = semanticRebuildConfig();
    registerTestEmbeddingProvider(calls, {
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts) =>
        texts.map((text) => (text.includes("Task graph recovery") ? [1, 0, 0] : [0, 1, 0])),
    });
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
      summary: "Recover task graph state",
      tags: ["D7"],
    });
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "DISPATCH-RECALL-A",
        status: "queued",
        sourceRole: "engineering-executive",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        summary: "Task graph recovery follow-up",
        metadata: {
          dispatchTarget: "/engineering-executive",
          goal: "Recover task graph state",
        },
        policyDecision: {
          decisionId: "decision-1",
          ruleId: "R001",
          riskLevel: "L0",
          action: "auto_close",
          reason: "unit test",
          timestamp: "2026-05-22T08:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    writeJson(path.join(workspaceRoot, "runtime", "main", "tmp", "task-scheduler-state.json"), {
      enabled: true,
      mode: "observe",
      status: "idle",
    });
    writeJson(path.join(workspaceRoot, "runtime", "policy", "policy-rules.json"), {
      $schema: "policy-rules-v1",
      schedulerPolicy: {
        runtimeLoopMode: "observe",
        maxDispatchesPerTick: 1,
        disableOldTrigger: true,
        enableContinuousApply: false,
      },
      rules: [],
    });
    await handleKbHttpRequest(
      makeReq("/api/kb/refresh", "POST"),
      makeResponse().res,
      workspaceRoot,
    );
    await prepareApprovedSemanticRebuild(workspaceRoot, config);
    await executeSemanticRebuild(workspaceRoot, { config });

    const preview = await executeDispatchRecallPreview(
      workspaceRoot,
      { limit: 1, recallLimit: 1 },
      { config },
    );

    expect(preview).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-preview",
        status: "ready",
        ready: true,
        blockReasons: [],
        warnings: [],
        selectedCandidateCount: 1,
        previewedCandidateCount: 1,
        recallLimit: 1,
        preflightSummary: expect.objectContaining({
          queuedCandidates: 1,
          policyEligibleCandidates: 1,
          wouldDispatchIfApplyEnabled: 1,
          wouldDispatch: 0,
        }),
        constraintsVerified: {
          stateWritten: "no",
          artifactWritten: "no",
          eventEmitted: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          taskGraphMutated: "no",
          returnConsumed: "no",
          receiptWritten: "no",
          embeddingCalls: "yes",
          keywordIndexWritten: "no",
          semanticIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(preview.candidates[0]).toEqual(
      expect.objectContaining({
        taskId: "DISPATCH-RECALL-A",
        dispatchTarget: "/engineering-executive",
        recallStatus: "ready",
        recallReady: true,
        recallBlockReasons: [],
        returnedResults: 1,
        topResults: [
          expect.objectContaining({
            vectorId: "case:case-a",
            sources: ["keyword", "semantic"],
            item: expect.objectContaining({ itemId: "case-a" }),
          }),
        ],
      }),
    );
    expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch", "proposals"))).toBe(false);
    expect(
      existsSync(path.join(workspaceRoot, "runtime", "main", "tmp", "runtime-loop-state.json")),
    ).toBe(false);

    const acceptance = await checkDispatchRecallPreviewAcceptance(
      workspaceRoot,
      { limit: 1, recallLimit: 1 },
      { config },
    );

    expect(acceptance).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-stub",
        status: "ready_for_human_gate",
        readyForHumanGate: true,
        blockReasons: [],
        previewSummary: expect.objectContaining({
          selectedCandidateCount: 1,
          previewedCandidateCount: 1,
        }),
        candidates: [
          expect.objectContaining({
            taskId: "DISPATCH-RECALL-A",
            dispatchTarget: "/engineering-executive",
            recallReady: true,
            returnedResults: 1,
            topResultIds: ["case-a"],
          }),
        ],
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          artifactWritten: "no",
          acceptanceRecordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          taskGraphMutated: "no",
          applied: "no",
        }),
      }),
    );

    const recordDryRun = await buildDispatchRecallAcceptanceRecordDryRun(
      workspaceRoot,
      { limit: 1, recallLimit: 1 },
      { config },
    );

    expect(recordDryRun).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-record-dry-run",
        status: "ready_for_human_gate",
        readyForHumanGate: true,
        wouldWrite: false,
        wouldWritePath: expect.stringMatching(
          /^runtime\/dispatch\/recall-acceptance-records\/dispatch-recall-acceptance-.*\.json$/u,
        ),
        recordPreview: expect.objectContaining({
          status: "human_gate_ready",
          requiredApproval: "human",
          nextAction: "await_human_dispatch_approval",
          approved: false,
          dispatchTriggered: false,
          selectedCandidateCount: 1,
          previewedCandidateCount: 1,
          taskIds: ["DISPATCH-RECALL-A"],
        }),
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          artifactWritten: "no",
          acceptanceRecordWritten: "no",
          recordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          taskGraphMutated: "no",
          applied: "no",
        }),
      }),
    );

    const write = await writeDispatchRecallAcceptanceRecord(
      workspaceRoot,
      { limit: 1, recallLimit: 1 },
      { config },
    );

    expect(write).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-record-write",
        status: "human_gate_ready",
        readyForHumanGate: true,
        wrote: true,
        recordPath: expect.stringMatching(
          /^runtime\/dispatch\/recall-acceptance-records\/dispatch-recall-acceptance-.*\.json$/u,
        ),
        record: expect.objectContaining({
          mode: "dispatch-recall-acceptance-record",
          status: "human_gate_ready",
          requiredApproval: "human",
          nextAction: "await_human_dispatch_approval",
          approved: false,
          dispatchTriggered: false,
          selectedCandidateCount: 1,
          previewedCandidateCount: 1,
          taskIds: ["DISPATCH-RECALL-A"],
        }),
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          artifactWritten: "acceptance-record-only",
          acceptanceRecordWritten: "yes",
          recordWritten: "yes",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          taskGraphMutated: "no",
          applied: "no",
        }),
      }),
    );
    const writtenRecord = JSON.parse(
      readFileSync(path.join(workspaceRoot, ...(write.recordPath ?? "").split("/")), "utf8"),
    );
    expect(writtenRecord).toEqual(
      expect.objectContaining({ acceptanceId: write.record?.acceptanceId }),
    );

    const recordList = await listDispatchRecallAcceptanceRecords(workspaceRoot);
    expect(recordList).toEqual(
      expect.objectContaining({
        available: true,
        mode: "dispatch-recall-acceptance-record-list",
        recordDir: "runtime/dispatch/recall-acceptance-records",
        recordPrefix: "dispatch-recall-acceptance-",
        totalRecords: 1,
        returnedRecords: 1,
        invalidRecords: 0,
        latestRecord: expect.objectContaining({
          recordPath: write.recordPath,
          acceptanceId: write.record?.acceptanceId,
          status: "human_gate_ready",
          requiredApproval: "human",
          nextAction: "await_human_dispatch_approval",
          approved: false,
          dispatchTriggered: false,
          selectedCandidateCount: 1,
          previewedCandidateCount: 1,
          taskIds: ["DISPATCH-RECALL-A"],
          constraintsVerified: expect.objectContaining({
            acceptanceRecordWritten: "yes",
            recordWritten: "yes",
            dispatchTriggered: "no",
            sessionsSpawnCalled: "no",
            applied: "no",
          }),
        }),
      }),
    );
    expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch", "proposals"))).toBe(false);
  });

  it("blocks dispatch recall acceptance when selected candidates have no recall hits", async () => {
    const workspaceRoot = makeWorkspace();
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "DISPATCH-RECALL-NO-HIT",
        status: "queued",
        sourceRole: "engineering-executive",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        summary: "No matching KB material",
        metadata: { dispatchTarget: "/engineering-executive" },
        policyDecision: {
          decisionId: "decision-1",
          ruleId: "R001",
          riskLevel: "L0",
          action: "auto_close",
          reason: "unit test",
          timestamp: "2026-05-22T08:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    writeJson(path.join(workspaceRoot, "runtime", "main", "tmp", "task-scheduler-state.json"), {
      enabled: true,
      mode: "observe",
      status: "idle",
    });
    writeJson(path.join(workspaceRoot, "runtime", "policy", "policy-rules.json"), {
      $schema: "policy-rules-v1",
      schedulerPolicy: {
        runtimeLoopMode: "observe",
        maxDispatchesPerTick: 1,
        disableOldTrigger: true,
        enableContinuousApply: false,
      },
      rules: [],
    });

    const acceptance = await checkDispatchRecallPreviewAcceptance(workspaceRoot, {
      limit: 1,
      recallLimit: 1,
    });

    expect(acceptance).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-stub",
        status: "blocked",
        readyForHumanGate: false,
        blockReasons: ["candidate_recall_blocked", "candidate_recall_missing"],
        previewSummary: expect.objectContaining({
          selectedCandidateCount: 1,
          previewedCandidateCount: 1,
        }),
        candidates: [
          expect.objectContaining({
            taskId: "DISPATCH-RECALL-NO-HIT",
            recallReady: false,
            returnedResults: 0,
            topResultIds: [],
          }),
        ],
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          acceptanceRecordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          taskGraphMutated: "no",
          embeddingCalls: "no",
          applied: "no",
        }),
      }),
    );
    expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch", "proposals"))).toBe(false);
  });

  it("serves dispatch recall previews over HTTP without selected candidates", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview?limit=1&recallLimit=1", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-preview",
        status: "ready",
        ready: true,
        warnings: ["no_selected_candidates"],
        selectedCandidateCount: 0,
        previewedCandidateCount: 0,
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          embeddingCalls: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("serves dispatch recall acceptance over HTTP and blocks empty previews", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance?limit=1&recallLimit=1", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(409);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-stub",
        status: "blocked",
        readyForHumanGate: false,
        blockReasons: ["no_selected_candidates"],
        previewSummary: expect.objectContaining({
          selectedCandidateCount: 0,
          previewedCandidateCount: 0,
          warnings: ["no_selected_candidates"],
        }),
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          acceptanceRecordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("serves dispatch recall acceptance record dry-runs without writing records", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq(
        "/api/kb/dispatch-recall-preview/acceptance-record-dry-run?limit=1&recallLimit=1",
        "GET",
      ),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(409);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-record-dry-run",
        status: "blocked",
        readyForHumanGate: false,
        wouldWrite: false,
        wouldWritePath: null,
        recordPreview: null,
        acceptance: expect.objectContaining({
          blockReasons: ["no_selected_candidates"],
        }),
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          acceptanceRecordWritten: "no",
          recordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    );
    expect(
      existsSync(path.join(workspaceRoot, "runtime", "dispatch", "recall-acceptance-records")),
    ).toBe(false);
  });

  it("serves empty dispatch recall acceptance record lists without mutating state", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance-records", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      mode: "dispatch-recall-acceptance-record-list",
      recordDir: "runtime/dispatch/recall-acceptance-records",
      recordPrefix: "dispatch-recall-acceptance-",
      totalRecords: 0,
      returnedRecords: 0,
      invalidRecords: 0,
      latestRecord: null,
      records: [],
      constraintsVerified: {
        fileWrites: "no",
        stateWritten: "no",
        eventEmitted: "no",
        dispatchTriggered: "no",
        sessionsSpawnCalled: "no",
        taskGraphMutated: "no",
        returnConsumed: "no",
        receiptWritten: "no",
        embeddingCalls: "no",
        keywordIndexWritten: "no",
        semanticIndexWritten: "no",
        vectorIndexWritten: "no",
        realRebuildTriggered: "no",
        applied: "no",
      },
    });
    expect(
      existsSync(path.join(workspaceRoot, "runtime", "dispatch", "recall-acceptance-records")),
    ).toBe(false);
  });

  it("serves dispatch recall acceptance writes over HTTP and blocks empty previews", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance?limit=1&recallLimit=1", "POST"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(409);
    expect(response.json()).toEqual(
      expect.objectContaining({
        mode: "dispatch-recall-acceptance-record-write",
        status: "blocked",
        readyForHumanGate: false,
        wrote: false,
        recordPath: null,
        record: null,
        acceptance: expect.objectContaining({
          blockReasons: ["no_selected_candidates"],
        }),
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          artifactWritten: "no",
          acceptanceRecordWritten: "no",
          recordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    );
    expect(
      existsSync(path.join(workspaceRoot, "runtime", "dispatch", "recall-acceptance-records")),
    ).toBe(false);
  });

  it("blocks real semantic rebuild execution when gate records are missing", async () => {
    const run = await executeSemanticRebuild(makeWorkspace());

    expect(run).toEqual(
      expect.objectContaining({
        mode: "semantic-rebuild-execution-run",
        status: "blocked",
        readyForExecution: false,
        executed: false,
        idempotentReplay: false,
        blockReasons: expect.arrayContaining(["executor_contract_not_ready"]),
        constraintsVerified: expect.objectContaining({
          embeddingCalls: "no",
          semanticIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("summarizes semantic rebuild status when no plan exists", async () => {
    const status = await getSemanticRebuildStatus(makeWorkspace());

    expect(status).toEqual(
      expect.objectContaining({
        available: false,
        mode: "semantic-rebuild-status",
        stage: "plan_missing",
        status: "blocked",
        nextAction: "resolve_blockers",
        plan: {
          available: false,
          reportPath: null,
          proposalId: null,
          status: null,
          generatedAt: null,
          totalItems: null,
          plannedBatches: null,
        },
        acceptance: expect.objectContaining({
          status: "missing",
          readyForHumanGate: false,
          blockReasons: ["proposal_missing"],
          proposalPath: null,
        }),
        acceptanceRecords: expect.objectContaining({
          available: false,
          totalRecords: 0,
          latestRecord: null,
        }),
        preflight: expect.objectContaining({
          status: "blocked",
          readyForRebuildHumanApproval: false,
          blockReasons: ["acceptance_record_missing", "proposal_missing"],
          recordPath: null,
        }),
        executionDryRun: expect.objectContaining({
          status: "blocked",
          readyForExecutionHumanGate: false,
          wouldExecute: false,
        }),
        approvalRecords: expect.objectContaining({
          available: false,
          latestRecord: null,
        }),
        executionEntry: expect.objectContaining({
          status: "blocked",
          readyForRealRebuildImplementation: false,
          wouldExecute: false,
          executed: false,
          nextAction: "resolve_blockers",
        }),
        constraintsVerified: expect.objectContaining({
          fileWrites: "no",
          realRebuildTriggered: "no",
          applied: "no",
        }),
      }),
    );
  });

  it("summarizes semantic rebuild status across the full gated chain", async () => {
    const workspaceRoot = makeWorkspace();
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "volcengine",
            model: "doubao-embedding",
            store: { vector: { enabled: true } },
          },
        },
      },
    };
    writeJson(path.join(workspaceRoot, "system", "case-library", "case-a.json"), {
      caseId: "case-a",
      title: "Task graph recovery",
    });

    const planResponse = makeResponse();
    await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan", "POST"),
      planResponse.res,
      workspaceRoot,
      { config },
    );
    const plan = planResponse.json();
    const acceptanceWrite = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, { config });
    const approvalWrite = await writeSemanticRebuildApprovalRecord(workspaceRoot, { config });

    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/status", "GET"),
      response.res,
      workspaceRoot,
      { config },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        available: true,
        mode: "semantic-rebuild-status",
        stage: "ready_for_real_rebuild_implementation",
        status: "ready_for_real_rebuild_implementation",
        nextAction: "run_real_rebuild_executor",
        plan: expect.objectContaining({
          available: true,
          reportPath: plan.reportPath,
          status: "ready",
          totalItems: 1,
          plannedBatches: 1,
        }),
        acceptance: expect.objectContaining({
          status: "ready_for_human_gate",
          readyForHumanGate: true,
          blockReasons: [],
          proposalPath: plan.reportPath,
        }),
        acceptanceRecords: expect.objectContaining({
          available: true,
          totalRecords: 1,
          latestRecord: expect.objectContaining({
            recordPath: acceptanceWrite.recordPath,
          }),
        }),
        preflight: expect.objectContaining({
          status: "ready_for_rebuild_human_approval",
          readyForRebuildHumanApproval: true,
          blockReasons: [],
          recordPath: acceptanceWrite.recordPath,
        }),
        executionDryRun: expect.objectContaining({
          status: "ready_for_execution_human_gate",
          readyForExecutionHumanGate: true,
          wouldExecute: false,
        }),
        approvalRecords: expect.objectContaining({
          available: true,
          totalRecords: 1,
          latestRecord: expect.objectContaining({
            recordPath: approvalWrite.recordPath,
          }),
        }),
        executionEntry: expect.objectContaining({
          status: "ready_for_real_rebuild_implementation",
          readyForRealRebuildImplementation: true,
          blockReasons: [],
          wouldExecute: false,
          executed: false,
          nextAction: "run_real_rebuild_executor",
        }),
        constraintsVerified: {
          fileWrites: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "semantic-index.json"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(workspaceRoot, "system", "kb-index", "vector-index.sqlite"), "utf8"),
    ).toThrow();
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

    expect(plan).toEqual(
      expect.objectContaining({
        status: "blocked",
        mode: "dry-run",
        dryRun: true,
        blockedReasons: ["semantic memorySearch is disabled", "vector store is disabled"],
        constraintsVerified: expect.objectContaining({
          embeddingCalls: "no",
          fileWrites: "no",
          vectorIndexWritten: "no",
        }),
      }),
    );
  });

  it("rejects wrong methods without changing state", async () => {
    const workspaceRoot = makeWorkspace();
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/refresh", "GET"),
      response.res,
      workspaceRoot,
    );

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

  it("rejects semantic rebuild status writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/status", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects unsupported semantic rebuild acceptance methods", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/acceptance", "PUT"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("rejects semantic rebuild acceptance record list writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/acceptance-records", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects semantic rebuild preflight writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-preflight", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects semantic rebuild execution dry-run writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-dry-run", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects unsupported semantic rebuild approval methods", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-approval", "PUT"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("rejects semantic rebuild approval record list writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-approval-records", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects unsupported semantic rebuild execution entry methods", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution", "PUT"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("rejects semantic rebuild execution contract writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-contract", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects semantic rebuild execution stage reads", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-stage", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("rejects semantic rebuild execution run reads", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/semantic-rebuild-plan/rebuild-execution-run", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("rejects unsupported dispatch recall acceptance methods", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance", "PUT"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("rejects dispatch recall acceptance record dry-run writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance-record-dry-run", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects dispatch recall acceptance record list writes", async () => {
    const response = makeResponse();
    const handled = await handleKbHttpRequest(
      makeReq("/api/kb/dispatch-recall-preview/acceptance-records", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
