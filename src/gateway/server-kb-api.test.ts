import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSemanticRebuildAcceptanceRecordDryRun,
  buildSemanticRebuildExecutionDryRun,
  buildSemanticRebuildPlan,
  checkSemanticRebuildProposalAcceptance,
  checkSemanticRebuildPreflight,
  handleKbHttpRequest,
  isKbApiPath,
  listSemanticRebuildAcceptanceRecords,
  summarizeSemanticBoundary,
  writeSemanticRebuildAcceptanceRecord,
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
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/acceptance")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/acceptance-records")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-preflight")).toBe(true);
    expect(isKbApiPath("/api/kb/semantic-rebuild-plan/rebuild-dry-run")).toBe(true);
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
});
