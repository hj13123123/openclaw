import { afterEach, describe, expect, it, vi } from "vitest";
import "./TaskHUD.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("TaskHUD task graph validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("fetches task graph validation and renders validation detail in the task graph section", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/hud/state") {
        return Promise.resolve(jsonResponse({
          generatedAt: "2026-05-21T00:00:00.000Z",
          globalStatus: { status: "healthy" },
          agentGroups: [],
          activeTasks: [],
          attentionQueue: [],
          returnInbox: { pendingItems: [] },
          taskGraphs: {
            items: [
              {
                graphId: "graph-a",
                title: "Graph A",
                aggregateStatus: "running",
                nodeSummary: { total: 2, completed: 1, blocked: 0 },
                lastValidatedAt: "2026-05-21T00:00:00.000Z",
                validationSeverity: "warning",
              },
            ],
          },
          warnings: [],
        }));
      }
      if (url === "/api/task-graph/validation") {
        return Promise.resolve(jsonResponse({
          available: true,
          total: 1,
          valid: false,
          bySeverity: { pass: 0, warning: 1, error: 0 },
          reports: [
            {
              graphId: "graph-a",
              checkedAt: "2026-05-21T00:00:00.000Z",
              severity: "warning",
              errors: [],
              warnings: [{ check: "role_enum", field: "nodes[0].role", message: "unknown role" }],
            },
          ],
        }));
      }
      if (url === "/api/hud/runtime-loop") {
        return Promise.resolve(jsonResponse({
          ok: true,
          data: {
            latest_tick_id: "tick-a",
            latest_tick_at: "2026-05-21T00:00:00.000Z",
            mode: "observe",
            dispatch_plan_count: 2,
            inbox_count: 1,
            warnings: ["observe only"],
          },
        }));
      }
      if (url === "/api/promote-gate/state") {
        return Promise.resolve(jsonResponse({
          available: true,
          status: "PASS",
          mode: "dry-run",
          generatedAt: "2026-05-21T00:00:00.000Z",
          frozenActive: false,
          reportPath: "runtime/main/tmp/d9-promote-gate-dryrun.json",
          stats: {
            total: 3,
            byVerdict: {
              READY_FOR_PROMOTE_GATE: 1,
              WAITING_REVIEW: 1,
              BLOCKED: 1,
            },
            byType: { skill: 2, memory: 1 },
          },
          constraintsVerified: {
            MEMORYWritten: "no",
            ENGINEERING_RULESWritten: "no",
            promoted: "none",
            autoPromote: "disabled",
          },
        }));
      }
      if (url === "/api/kb/state") {
        return Promise.resolve(jsonResponse({
          available: true,
          indexPath: "system/kb-index/index.json",
          generatedAt: "2026-05-21T00:00:00.000Z",
          totalItems: 5,
          sourceCaseCount: 2,
          sourceSkillCount: 3,
          keywordCount: 9,
          semantic: {
            status: "configured",
            mode: "observe-only",
            rebuild: "disabled",
            provider: "volcengine",
            model: "doubao-embedding",
            vectorEnabled: true,
            hybridEnabled: true,
          },
        }));
      }
      if (url === "/api/kb/semantic-rebuild-plan/state") {
        return Promise.resolve(jsonResponse({
          available: true,
          status: "ready",
          mode: "dry-run",
          dryRun: true,
          generatedAt: "2026-05-21T00:01:00.000Z",
          reportPath: "runtime/main/tmp/kb-semantic-rebuild-plan.json",
          plannedBatches: 1,
          blockedReasons: [],
          constraintsVerified: {
            embeddingCalls: "no",
            dryRunReportWritten: "yes",
            fileWrites: "dry-run-report-only",
            vectorIndexWritten: "no",
            applied: "no",
          },
        }));
      }
      if (url === "/api/hud/scheduler-events?limit=8") return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    const element = document.createElement("task-hud") as HTMLElement & { updateComplete: Promise<boolean>; panelOpen: boolean };
    document.body.appendChild(element);
    element.panelOpen = true;
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? "";
    expect(fetchMock).toHaveBeenCalledWith("/api/task-graph/validation");
    expect(text).toContain("任务图验真");
    expect(text).toContain("错误 0");
    expect(text).toContain("警告 1");
    expect(text).toContain("验真 警告");
    expect(text).toContain("问题 1");
    expect(text).toContain("查看验真明细");
    expect(text).toContain("role_enum");
    expect(text).toContain("nodes[0].role");
    expect(text).toContain("unknown role");
    expect(fetchMock).toHaveBeenCalledWith("/api/hud/runtime-loop");
    expect(text).toContain("运行态总线");
    expect(text).toContain("快照可用");
    expect(text).toContain("dispatch 2");
    expect(text).toContain("inbox 1");
    expect(text).toContain("查看总线警告");
    expect(text).toContain("observe only");
    expect(fetchMock).toHaveBeenCalledWith("/api/promote-gate/state");
    expect(text).toContain("蒸馏闸口");
    expect(text).toContain("报告可用");
    expect(text).toContain("候选 3");
    expect(text).toContain("就绪 1");
    expect(text).toContain("待审 1");
    expect(text).toContain("阻塞 1");
    expect(text).toContain("查看闸口约束");
    expect(text).toContain("MEMORY");
    expect(text).toContain("ENGINEERING_RULES");
    expect(text).toContain("promoted");
    expect(text).toContain("autoPromote");
    expect(text).toContain("查看判定明细");
    expect(text).toContain("判定 READY_FOR_PROMOTE_GATE · 1");
    expect(text).toContain("判定 WAITING_REVIEW · 1");
    expect(text).toContain("判定 BLOCKED · 1");
    expect(text).toContain("类型 skill · 2");
    expect(text).toContain("类型 memory · 1");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/state");
    expect(text).toContain("知识库");
    expect(text).toContain("索引可用");
    expect(text).toContain("条目 5");
    expect(text).toContain("案例 2");
    expect(text).toContain("技能 3");
    expect(text).toContain("关键词 9");
    expect(text).toContain("语义 configured");
    expect(text).toContain("observe-only");
    expect(text).toContain("向量重建 disabled");
    expect(text).toContain("volcengine");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/semantic-rebuild-plan/state");
    expect(text).toContain("语义计划 ready");
    expect(text).toContain("batch 1");
    expect(text).toContain("查看语义 dry-run 约束");
    expect(text).toContain("embedding");
    expect(text).toContain("dry-run-report-only");
  });
});
