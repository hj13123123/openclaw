import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleHudStateHttpRequest, summarizeRuntimeLoopFreshness } from "./server-hud-api.js";

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

describe("server HUD API runtime loop freshness", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-hud-api-"));
    roots.push(root);
    return root;
  }

  it("classifies runtime loop freshness from tick timestamps", () => {
    expect(
      summarizeRuntimeLoopFreshness(
        { tick_at: "2026-05-22T08:00:00.000Z" },
        Date.parse("2026-05-22T08:05:00.000Z"),
      ),
    ).toEqual({
      status: "fresh",
      ageMs: 300_000,
      staleAfterMs: 900_000,
    });
    expect(
      summarizeRuntimeLoopFreshness(
        { tick_at: "2026-05-22T08:00:00.000Z" },
        Date.parse("2026-05-22T08:16:00.000Z"),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "stale",
        ageMs: 960_000,
      }),
    );
    expect(summarizeRuntimeLoopFreshness({})).toEqual(
      expect.objectContaining({
        status: "missing",
        ageMs: null,
      }),
    );
    expect(summarizeRuntimeLoopFreshness({ tick_at: "not-a-date" })).toEqual(
      expect.objectContaining({
        status: "invalid",
        ageMs: null,
      }),
    );
  });

  it("surfaces stale runtime loop snapshots without modifying state", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "runtime", "main", "tmp", "runtime-loop-state.json"), {
      tickId: "tick-old",
      tick_at: "2026-05-22T08:00:00.000Z",
      mode: "observe",
      scheduler: { intervalMs: 60_000 },
      tasks: { total: 1, queued: 0 },
      dispatch_plan: [],
      return_processor: { inbox_count: 2 },
      warnings: ["observe only"],
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T08:20:00.000Z"));

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        latest_tick_id: "tick-old",
        latest_tick_at: "2026-05-22T08:00:00.000Z",
        freshness: {
          status: "stale",
          ageMs: 1_200_000,
          staleAfterMs: 900_000,
        },
        mode: "observe",
        task_summary: { total: 1, queued: 0 },
        dispatch_plan_count: 0,
        inbox_count: 2,
        warnings: ["observe only", "runtime loop snapshot is stale (20 minutes old)"],
      },
    });
  });

  it("runs a manual observe-only runtime loop refresh", async () => {
    const workspaceRoot = makeWorkspace();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T08:30:00.000Z"));

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/refresh", "POST"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        refreshed: true,
        refreshMode: "observe-only",
        wouldDispatch: false,
        applied: false,
        data: expect.objectContaining({
          latest_tick_at: "2026-05-22T08:30:00.000Z",
          freshness: {
            status: "fresh",
            ageMs: 0,
            staleAfterMs: 900_000,
          },
          mode: "observe",
          dispatch_plan_count: 0,
        }),
      }),
    );
  });

  it("rejects runtime loop refresh reads", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/refresh", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("returns runtime loop preflight without writing runtime loop state", async () => {
    const workspaceRoot = makeWorkspace();
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "PREFLIGHT-API-A",
        status: "queued",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        metadata: { dispatchTarget: "/main" },
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

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/preflight", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        tasks: expect.objectContaining({
          queued_candidates: 1,
          policy_eligible_candidates: 1,
          would_dispatch_if_apply_enabled: 0,
          would_dispatch: 0,
        }),
        dispatch_plan: [
          expect.objectContaining({
            taskId: "PREFLIGHT-API-A",
            would_dispatch: false,
            blocked_reasons: expect.arrayContaining([
              "observe_only_preflight",
              "scheduler_disabled",
              "continuous_apply_disabled",
            ]),
          }),
        ],
        constraintsVerified: expect.objectContaining({
          stateWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    });
  });

  it("rejects runtime loop preflight writes", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/preflight", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("creates runtime loop dispatch proposal artifacts without dispatching", async () => {
    const workspaceRoot = makeWorkspace();
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "PROPOSAL-API-A",
        status: "queued",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        metadata: { dispatchTarget: "/main" },
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

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/dispatch-proposal", "POST"),
      response.res,
      workspaceRoot,
    );
    const body = response.json();
    const data = body.data as { proposalPath: string };

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(body).toEqual({
      ok: true,
      created: true,
      mode: "proposal-only",
      data: expect.objectContaining({
        mode: "proposal-only",
        selectedCandidates: [
          expect.objectContaining({
            taskId: "PROPOSAL-API-A",
            would_dispatch: false,
            would_dispatch_if_apply_enabled: true,
          }),
        ],
        constraintsVerified: expect.objectContaining({
          artifactWritten: "yes",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    });
    expect(readFileSync(path.join(workspaceRoot, data.proposalPath), "utf8")).toContain(
      "PROPOSAL-API-A",
    );
  });

  it("rejects runtime loop dispatch proposal reads", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/dispatch-proposal", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("checks runtime loop proposal acceptance without executing dispatch", async () => {
    const workspaceRoot = makeWorkspace();
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "ACCEPTANCE-API-A",
        status: "queued",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        metadata: { dispatchTarget: "/main" },
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
    const proposalResponse = makeResponse();
    await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/dispatch-proposal", "POST"),
      proposalResponse.res,
      workspaceRoot,
    );
    const proposal = proposalResponse.json().data as { proposalPath: string };

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq(
        `/api/hud/runtime-loop/proposal-acceptance?proposalPath=${encodeURIComponent(proposal.proposalPath)}`,
        "GET",
      ),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "acceptance-stub",
        proposalPath: proposal.proposalPath,
        status: "ready_for_human_gate",
        readyForHumanGate: true,
        blockReasons: [],
        selectedCandidateTaskIds: ["ACCEPTANCE-API-A"],
        currentCandidateTaskIds: ["ACCEPTANCE-API-A"],
        constraintsVerified: expect.objectContaining({
          artifactWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    });
  });

  it("rejects runtime loop proposal acceptance requests without proposal path", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/proposal-acceptance", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "proposalPath is required",
    });
  });

  it("rejects runtime loop proposal acceptance writes", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/proposal-acceptance?proposalPath=x", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("builds runtime loop acceptance record dry-run previews without writing records", async () => {
    const workspaceRoot = makeWorkspace();
    const tasksPath = path.join(workspaceRoot, "runtime", "tasks", "tasks.jsonl");
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(
      tasksPath,
      `${JSON.stringify({
        taskId: "ACCEPTANCE-RECORD-API-A",
        status: "queued",
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z",
        metadata: { dispatchTarget: "/main" },
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
    const proposalResponse = makeResponse();
    await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/dispatch-proposal", "POST"),
      proposalResponse.res,
      workspaceRoot,
    );
    const proposal = proposalResponse.json().data as { proposalPath: string };

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq(
        `/api/hud/runtime-loop/acceptance-record-dry-run?proposalPath=${encodeURIComponent(proposal.proposalPath)}`,
        "GET",
      ),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "acceptance-record-dry-run",
        proposalPath: proposal.proposalPath,
        wouldWrite: false,
        wouldWritePath: expect.stringMatching(
          /^runtime\/dispatch\/acceptance-records\/runtime-loop-acceptance-.*\.json$/u,
        ),
        acceptance: expect.objectContaining({
          status: "ready_for_human_gate",
          readyForHumanGate: true,
        }),
        recordPreview: expect.objectContaining({
          proposalPath: proposal.proposalPath,
          selectedCandidateTaskIds: ["ACCEPTANCE-RECORD-API-A"],
          approved: false,
          dispatchTriggered: false,
        }),
        constraintsVerified: expect.objectContaining({
          recordWritten: "no",
          dispatchTriggered: "no",
          sessionsSpawnCalled: "no",
          applied: "no",
        }),
      }),
    });
    expect(existsSync(path.join(workspaceRoot, "runtime", "dispatch", "acceptance-records"))).toBe(
      false,
    );
  });

  it("rejects runtime loop acceptance record dry-run requests without proposal path", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/acceptance-record-dry-run", "GET"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "proposalPath is required",
    });
  });

  it("rejects runtime loop acceptance record dry-run writes", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop/acceptance-record-dry-run?proposalPath=x", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("returns typed return inbox summaries without consuming files", async () => {
    const workspaceRoot = makeWorkspace();
    const returnPath = path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json");
    writeJson(returnPath, {
      routing: {
        taskId: "TASK-A",
        sourceRole: "engineering-executive",
        action: "complete",
      },
      outcome: {
        summary: "return summary",
      },
    });
    writeJson(path.join(workspaceRoot, "system", "returns", "inbox", "return.mock.skip.json"), {
      taskId: "MOCK",
    });

    const before = readFileSync(returnPath, "utf8");
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/return-inbox", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        inboxPath: "system/returns/inbox",
        pendingCount: 1,
        completeCount: 1,
        incompleteCount: 0,
        malformedCount: 0,
        skippedMockCount: 1,
        pendingItems: [
          expect.objectContaining({
            returnId: "return-a.json",
            relativePath: "system/returns/inbox/return-a.json",
            taskId: "TASK-A",
            sourceRole: "engineering-executive",
            action: "complete",
            summary: "return summary",
          }),
        ],
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      }),
    });
    expect(readFileSync(returnPath, "utf8")).toBe(before);
  });

  it("returns return consumer plans without consuming files", async () => {
    const workspaceRoot = makeWorkspace();
    const returnPath = path.join(workspaceRoot, "system", "returns", "inbox", "return-a.json");
    writeJson(returnPath, {
      packageId: "rrpkg-a",
      packageVersion: "1.0",
      returnType: "completion",
      producedAt: "2026-05-20T00:00:00.000Z",
      role: {
        roleId: "engineering-executive",
        roleType: "executor",
      },
      task: {
        ticketId: "TASK-A",
      },
      deliveryReceipt: {
        receiptId: "delivery-a",
      },
      returnSummary: {
        status: "completed",
      },
      candidateEligibility: {
        eligible: false,
      },
      recommendedNextAction: {
        action: "accept",
        target: "main",
        description: "accept result",
      },
    });

    const before = readFileSync(returnPath, "utf8");
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/return-consumer-plan", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        mode: "observe-only",
        inboxPath: "system/returns/inbox",
        processedPath: "system/returns/processed",
        totalCount: 1,
        processCount: 1,
        skipCount: 0,
        plans: [
          expect.objectContaining({
            status: "process",
            sourceFile: "return-a.json",
            returnId: "rrpkg-a",
            taskId: "TASK-A",
          }),
        ],
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      }),
    });
    expect(readFileSync(returnPath, "utf8")).toBe(before);
  });

  it("recovers malformed HUD state snapshots with a runtime refresh", async () => {
    const workspaceRoot = makeWorkspace();
    const hudStatePath = path.join(workspaceRoot, "runtime", "main", "tmp", "task-hud-state.json");
    mkdirSync(path.dirname(hudStatePath), { recursive: true });
    writeFileSync(hudStatePath, '{"version":"1.1","taskGraphs":[{"title":"broken}', "utf8");
    writeJson(
      path.join(workspaceRoot, "system", "positions", "state", "main_workspace-main.json"),
      {
        agentId: "main",
        status: "idle",
        progressPct: 100,
      },
    );

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/state", "GET"),
      response.res,
      workspaceRoot,
    );
    const body = response.json();

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        generator: "runtime-hud-state",
        snapshotRecovered: true,
        snapshotRecoveryReason: "invalid_snapshot",
        recentCompletions: {
          totalToday: 0,
          lastCompletedAt: null,
          items: [],
        },
      }),
    );
    expect(JSON.parse(readFileSync(hudStatePath, "utf8"))).toEqual(
      expect.objectContaining({
        generator: "runtime-hud-state",
      }),
    );
  });

  it("rejects return inbox writes", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/return-inbox", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("rejects return consumer plan writes", async () => {
    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/return-consumer-plan", "POST"),
      response.res,
      makeWorkspace(),
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(405);
    expect(response.text()).toBe("Method Not Allowed");
    expect(response.res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
});
