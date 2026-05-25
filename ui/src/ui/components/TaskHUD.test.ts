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
        return Promise.resolve(
          jsonResponse({
            generatedAt: "2026-05-21T00:00:00.000Z",
            globalStatus: { status: "healthy" },
            agentGroups: [],
            activeTasks: [],
            attentionQueue: [],
            returnInbox: { pendingItems: [] },
            watchdogSnapshot: { totalAlerts: 4 },
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
          }),
        );
      }
      if (url === "/api/task-graph/validation") {
        return Promise.resolve(
          jsonResponse({
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
          }),
        );
      }
      if (url === "/api/hud/runtime-loop") {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            data: {
              latest_tick_id: "tick-a",
              latest_tick_at: "2026-05-21T00:00:00.000Z",
              freshness: { status: "stale", ageMs: 1_200_000, staleAfterMs: 900_000 },
              mode: "observe",
              dispatch_plan_count: 2,
              inbox_count: 1,
              warnings: ["observe only"],
            },
          }),
        );
      }
      if (url === "/api/promote-gate/state") {
        return Promise.resolve(
          jsonResponse({
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
          }),
        );
      }
      if (url === "/api/kb/state") {
        return Promise.resolve(
          jsonResponse({
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
          }),
        );
      }
      if (url === "/api/kb/semantic-rebuild-plan/state") {
        return Promise.resolve(
          jsonResponse({
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
          }),
        );
      }
      if (url === "/api/kb/semantic-rebuild-plan/acceptance") {
        return Promise.resolve(
          jsonResponse({
            mode: "acceptance-record-dry-run",
            checkedAt: "2026-05-21T00:02:00.000Z",
            proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan.json",
            wouldWrite: false,
            wouldWritePath:
              "runtime/main/tmp/kb-semantic-rebuild-acceptance-2026-05-21T00-02-00-000Z.json",
            acceptance: {
              mode: "acceptance-stub",
              checkedAt: "2026-05-21T00:02:00.000Z",
              proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan.json",
              status: "ready_for_human_gate",
              readyForHumanGate: true,
              blockReasons: [],
              proposalSummary: {
                proposalId: "kb-semantic-rebuild-2026-05-21T00-01-00-000Z",
                status: "ready",
                generatedAt: "2026-05-21T00:01:00.000Z",
                provider: "volcengine",
                model: "doubao-embedding",
                totalItems: 5,
                plannedBatches: 1,
                blockedReasons: [],
              },
            },
            recordPreview: {
              acceptanceId: "kb-semantic-rebuild-acceptance-test",
              createdAt: "2026-05-21T00:02:00.000Z",
              status: "human_gate_ready",
              proposalId: "kb-semantic-rebuild-2026-05-21T00-01-00-000Z",
              proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan.json",
              plannedBatches: 1,
              totalItems: 5,
              requiredApproval: "human",
              nextAction: "await_human_approval",
              approved: false,
              rebuildTriggered: false,
            },
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
      }
      if (url === "/api/kb/semantic-rebuild-plan/acceptance-records") {
        return Promise.resolve(
          jsonResponse({
            available: true,
            mode: "acceptance-record-list",
            reportDir: "runtime/main/tmp",
            reportPrefix: "kb-semantic-rebuild-acceptance-",
            totalRecords: 1,
            returnedRecords: 1,
            invalidRecords: 0,
            records: [
              {
                recordPath:
                  "runtime/main/tmp/kb-semantic-rebuild-acceptance-2026-05-21T00-03-00-000Z.json",
                acceptanceId: "acceptance-record-1",
                createdAt: "2026-05-21T00:03:00.000Z",
                status: "human_gate_ready",
                proposalId: "kb-semantic-rebuild-2026-05-21T00-01-00-000Z",
                proposalPath: "runtime/main/tmp/kb-semantic-rebuild-plan.json",
                plannedBatches: 1,
                totalItems: 5,
                requiredApproval: "human",
                nextAction: "await_human_approval",
                approved: false,
                rebuildTriggered: false,
                constraintsVerified: {
                  recordWritten: "yes",
                  stateWritten: "no",
                  embeddingCalls: "no",
                  keywordIndexWritten: "no",
                  vectorIndexWritten: "no",
                  realRebuildTriggered: "no",
                  applied: "no",
                },
              },
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
      }
      if (url === "/api/hud/scheduler-events?limit=8") return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    const element = document.createElement("task-hud") as HTMLElement & {
      updateComplete: Promise<boolean>;
      panelOpen: boolean;
    };
    document.body.appendChild(element);
    element.panelOpen = true;
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? "";
    const compactText = text.replace(/\s+/g, " ");
    expect(fetchMock).toHaveBeenCalledWith("/api/task-graph/validation");
    expect(compactText).toContain("4 警告");
    expect(compactText).toContain("任务图验真");
    expect(compactText).toContain("错误 0");
    expect(compactText).toContain("警告 1");
    expect(compactText).toContain("验真 警告");
    expect(compactText).toContain("问题 1");
    expect(compactText).toContain("查看验真明细");
    expect(compactText).toContain("role_enum");
    expect(compactText).toContain("nodes[0].role");
    expect(compactText).toContain("unknown role");
    expect(fetchMock).toHaveBeenCalledWith("/api/hud/runtime-loop");
    expect(compactText).toContain("运行态总线");
    expect(compactText).toContain("快照可用");
    expect(compactText).toContain("dispatch 2");
    expect(compactText).toContain("inbox 1");
    expect(compactText).toContain("freshness stale");
    expect(compactText).toContain("age 20m");
    expect(compactText).toContain("查看总线警告");
    expect(compactText).toContain("observe only");
    expect(fetchMock).toHaveBeenCalledWith("/api/promote-gate/state");
    expect(compactText).toContain("蒸馏闸口");
    expect(compactText).toContain("报告可用");
    expect(compactText).toContain("候选 3");
    expect(compactText).toContain("就绪 1");
    expect(compactText).toContain("待审 1");
    expect(compactText).toContain("阻塞 1");
    expect(compactText).toContain("查看闸口约束");
    expect(compactText).toContain("MEMORY");
    expect(compactText).toContain("ENGINEERING_RULES");
    expect(compactText).toContain("promoted");
    expect(compactText).toContain("autoPromote");
    expect(compactText).toContain("查看判定明细");
    expect(compactText).toContain("判定 READY_FOR_PROMOTE_GATE · 1");
    expect(compactText).toContain("判定 WAITING_REVIEW · 1");
    expect(compactText).toContain("判定 BLOCKED · 1");
    expect(compactText).toContain("类型 skill · 2");
    expect(compactText).toContain("类型 memory · 1");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/state");
    expect(compactText).toContain("知识库");
    expect(compactText).toContain("索引可用");
    expect(compactText).toContain("条目 5");
    expect(compactText).toContain("案例 2");
    expect(compactText).toContain("技能 3");
    expect(compactText).toContain("关键词 9");
    expect(compactText).toContain("语义 configured");
    expect(compactText).toContain("observe-only");
    expect(compactText).toContain("向量重建 disabled");
    expect(compactText).toContain("volcengine");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/semantic-rebuild-plan/state");
    expect(compactText).toContain("语义计划 ready");
    expect(compactText).toContain("batch 1");
    expect(compactText).toContain("查看语义 dry-run 约束");
    expect(compactText).toContain("embedding");
    expect(compactText).toContain("dry-run-report-only");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/semantic-rebuild-plan/acceptance");
    expect(compactText).toContain("semantic gate ready_for_human_gate");
    expect(compactText).toContain("human gate ready");
    expect(compactText).toContain("semantic acceptance dry-run");
    expect(compactText).toContain("recordWritten");
    expect(compactText).toContain("realRebuild");
    expect(compactText).toContain("await_human_approval");
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/semantic-rebuild-plan/acceptance-records");
    expect(compactText).toContain("semantic records 1/1");
    expect(compactText).toContain("invalid 0");
    expect(compactText).toContain("semantic acceptance records");
    expect(compactText).toContain("human_gate_ready");
    expect(compactText).toContain("kb-semantic-rebuild-2026-05-21T00-01-00-000Z");
    expect(compactText).toContain("list fileWrites / no");
  });
});
