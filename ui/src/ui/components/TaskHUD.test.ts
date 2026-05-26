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
            returnConsumerPlan: {
              mode: "observe-only",
              totalCount: 2,
              processCount: 0,
              skipCount: 2,
              warningCount: 0,
              byReason: [{ reason: "schema-invalid", count: 2 }],
              constraintsVerified: {
                consumed: "no",
                archived: "no",
                receiptWritten: "no",
                taskGraphMutated: "no",
                applied: "no",
              },
            },
            returnDiagnosis: {
              mode: "observe-only",
              totalCount: 2,
              diagnosableCount: 2,
              warningCount: 0,
              byCompatibility: [{ compatibility: "v2-shaped", count: 2 }],
              bySuggestedAction: [{ action: "repair-to-v1-dry-run", count: 2 }],
              byIssueCode: [
                { code: "consumer_schema_invalid", count: 5 },
                { code: "task_graph_unmatched", count: 2 },
                { code: "v2_shape_not_consumer_v1", count: 2 },
              ],
              constraintsVerified: {
                readOnly: "yes",
                returnWritten: "no",
                returnConsumed: "no",
                archived: "no",
                receiptWritten: "no",
                taskGraphMutated: "no",
                applied: "no",
              },
            },
            returnRepairDryRun: {
              mode: "observe-only",
              dryRun: true,
              totalDiagnosed: 2,
              candidateCount: 2,
              repairableCount: 2,
              blockedCount: 0,
              warningCount: 0,
              constraintsVerified: {
                readOnly: "yes",
                returnWritten: "no",
                originalReturnMutated: "no",
                archived: "no",
                receiptWritten: "no",
                consumerTriggered: "no",
                applied: "no",
              },
            },
            returnReconciliationGate: {
              mode: "observe-only",
              status: "ready",
              frozen: true,
              readyForControlledApply: false,
              applyBlockedReason: "frozen",
              nextAction: "await_unfreeze_or_human_approval",
              repair: {
                candidateCount: 2,
                repairableCount: 2,
                blockedCount: 0,
              },
              returnLink: {
                candidateCount: 2,
                linkableCount: 2,
                blockedCount: 0,
              },
              constraintsVerified: {
                readOnly: "yes",
                returnWritten: "no",
                taskGraphWritten: "no",
                receiptWritten: "no",
                consumerTriggered: "no",
                dispatchTriggered: "no",
                applied: "no",
              },
            },
            controlSignals: {
              mode: "observe-only",
              status: "frozen",
              frozen: true,
              g2Approved: false,
              pendingCount: 2,
              validCount: 1,
              invalidCount: 1,
              expiredCount: 0,
              errorCount: 0,
              byRole: [{ role: "engineering-executive", count: 1 }],
              byAction: [{ action: "pause", count: 1 }],
              constraintsVerified: {
                readOnly: "yes",
                taskGraphMutated: "no",
                sessionsSent: "no",
                applied: "no",
              },
            },
            recoveryCandidates: {
              mode: "observe-only",
              frozen: true,
              graphCount: 1,
              candidateCount: 1,
              errorCount: 0,
              byStatus: [{ status: "blocked", count: 1 }],
              bySuggestedAction: [{ action: "unblock", count: 1 }],
              constraintsVerified: {
                readOnly: "yes",
                taskGraphMutated: "no",
                autoDispatchTriggered: "no",
                applied: "no",
              },
            },
            promotionCandidates: {
              available: true,
              status: "ok",
              stats: {
                total: 5,
                byState: { rolledback: 3, pending: 1, rejected: 1 },
                byRisk: { low: 5 },
                byConsistency: { ok: 5 },
                invalid: 0,
                safeApplyEligible: 5,
              },
              errorCount: 0,
              constraintsVerified: {
                readOnly: "yes",
                candidateStateWritten: "no",
                truthFilesWritten: "no",
                applied: "none",
                rolledBack: "none",
                autoPromote: "disabled",
              },
            },
            schedulerTickPlan: {
              mode: "observe-only",
              decision: "disabled",
              reason: "scheduler marker is disabled",
              enabled: false,
              markerMode: "observe",
              stateStatus: "disabled",
              running: false,
              totalTicks: 0,
              nextTickIndex: null,
              warningCount: 3,
              maxTicks: {
                effective: 10,
                reason: "global_max_ticks",
                global: 10,
                perTask: null,
                perTaskId: null,
                reached: false,
              },
              sourceFiles: { tickScriptExists: true },
              constraintsVerified: {
                readOnly: "yes",
                markerWritten: "no",
                stateWritten: "no",
                eventEmitted: "no",
                scriptInvoked: "no",
                childProcessSpawned: "no",
                autoDispatchTriggered: "no",
                applied: "no",
              },
            },
            watchdogSnapshot: {
              totalAlerts: 6,
              healthyCount: 2,
              byCondition: {
                returnConsumerSkipped: 2,
                mirrorObserveAttention: 2,
                taskGraphUnmatchedReturns: 2,
              },
            },
            mirrorObserve: {
              available: true,
              reportPath: "runtime/main/tmp/mirror-observe.json",
              mirrorId: "mirror-test",
              mode: "observe-only",
              stats: {
                observationCount: 4,
                findingCount: 4,
                bySeverity: { attention: 2, info: 2 },
              },
              constraintsVerified: {
                promoted: "none",
                applyPerformed: "no",
              },
            },
            autoEvolutionObserve: {
              available: true,
              mode: "observe-only",
              stats: {
                totalSuggestions: 3,
                byPriority: { P1: 3 },
                bySource: { mirror: 1, promote_gate: 1, hud: 1 },
              },
              constraintsVerified: {
                codeWritten: "no",
                autoEvolutionApplied: "no",
              },
            },
            taskGraphs: {
              returnPreview: {
                mode: "observe-only",
                observedAt: "2026-05-21T00:00:00.000Z",
                graphCount: 1,
                nodeCount: 2,
                pendingReturnCount: 2,
                matchedNodeCount: 0,
                missingNodeCount: 1,
                ambiguousNodeCount: 0,
                declaredReturnNodeCount: 1,
                unmatchedReturnCount: 2,
                graphErrorCount: 0,
                sampleUnmatchedReturns: [
                  {
                    returnId: "return-rrpkg-DOMAIN1-L3-CANDIDATE-SCAN-MVP-J-20260515-171824.json",
                    taskId: "DOMAIN1-L3-CANDIDATE-SCAN-MVP-J",
                    reason: "no_matching_task_node",
                  },
                  {
                    returnId:
                      "return-rrpkg-DOMAIN1-L3-CONTROLLED-APPLY-SCAN-RECOMMENDED-K-20260515-184521.json",
                    taskId: null,
                    reason: "missing_task_id",
                  },
                ],
                constraintsVerified: {
                  graphMutated: "no",
                  returnConsumed: "no",
                  receiptWritten: "no",
                  dispatchTriggered: "no",
                  applied: "no",
                },
              },
              returnLinkDryRun: {
                mode: "observe-only",
                dryRun: true,
                unmatchedReturnCount: 2,
                candidateCount: 2,
                linkableCount: 2,
                blockedCount: 0,
                graphErrorCount: 0,
                warningCount: 0,
                constraintsVerified: {
                  readOnly: "yes",
                  taskGraphWritten: "no",
                  returnConsumed: "no",
                  receiptWritten: "no",
                  dispatchTriggered: "no",
                  applied: "no",
                },
              },
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
      if (url === "/api/hud/task-state") {
        return Promise.resolve(
          jsonResponse({
            summary: {
              total: 81,
              queued: 0,
              completed: 73,
              failed: 0,
              blocked: 7,
              quarantined: 0,
            },
            tasks: [],
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
    expect(compactText).toContain("Return diagnosis");
    expect(compactText).toContain("0 当前任务");
    expect(compactText).toContain("0 待验收");
    expect(compactText).toContain("repair dry-run 2/2");
    expect(compactText).toContain("blocked 0");
    expect(compactText).toContain("reconciliation gate ready");
    expect(compactText).toContain("frozen yes");
    expect(compactText).toContain("next await_unfreeze_or_human_approval");
    expect(compactText).toContain("gate repair 2/2");
    expect(compactText).toContain("link 2/2");
    expect(compactText).toContain("view reconciliation constraints");
    expect(compactText).toContain("taskGraphWritten - no");
    expect(compactText).toContain("dispatchTriggered - no");
    expect(compactText).toContain("repair constraints");
    expect(compactText).toContain("originalReturnMutated");
    expect(compactText).toContain("consumerTriggered");
    expect(compactText).toContain("diagnosable 2");
    expect(compactText).toContain("v2-shaped 路 2");
    expect(compactText).toContain("repair-to-v1-dry-run 路 2");
    expect(compactText).toContain("consumer_schema_invalid 路 5");
    expect(compactText).toContain("diagnosis constraints");
    expect(compactText).toContain("returnConsumed 路 no");
    expect(compactText).toContain("6 告警");
    expect(compactText).toContain("回执消费计划");
    expect(compactText).toContain("总数 2");
    expect(compactText).toContain("跳过 2");
    expect(compactText).toContain("schema-invalid · 2");
    expect(compactText).toContain("receiptWritten · no");
    expect(compactText).toContain("安全控制");
    expect(compactText).toContain("signals 2");
    expect(compactText).toContain("valid 1");
    expect(compactText).toContain("invalid 1");
    expect(compactText).toContain("recovery 1");
    expect(compactText).toContain("G2 locked");
    expect(compactText).toContain("promotion 5");
    expect(compactText).toContain("consistency 0");
    expect(compactText).toContain("control.taskGraphMutated · no");
    expect(compactText).toContain("recovery.autoDispatchTriggered · no");
    expect(compactText).toContain("promotion.candidateStateWritten · no");
    expect(compactText).toContain("promotion.truthFilesWritten · no");
    expect(compactText).toContain("scheduler disabled");
    expect(compactText).toContain("scheduler.scriptInvoked · no");
    expect(compactText).toContain("scheduler.childProcessSpawned · no");
    expect(compactText).toContain("promotion state rolledback · 3");
    expect(compactText).toContain("promotion consistency ok · 5");
    expect(compactText).toContain("健康巡检");
    expect(compactText).toContain("警告 6");
    expect(compactText).toContain("returnConsumerSkipped");
    expect(compactText).toContain("mirrorObserveAttention");
    expect(compactText).toContain("taskGraphUnmatchedReturns");
    expect(compactText).toContain("观察层");
    expect(compactText).toContain("Mirror Observe");
    expect(compactText).toContain("observations 4");
    expect(compactText).toContain("mirror-test");
    expect(compactText).toContain("Auto-Evolution Observe");
    expect(compactText).toContain("suggestions 3");
    expect(compactText).toContain("autoEvolutionApplied · no");
    expect(compactText).toContain("任务图验真");
    expect(compactText).toContain("错误 0");
    expect(compactText).toContain("警告 1");
    expect(compactText).toContain("验真 警告");
    expect(compactText).toContain("return match");
    expect(compactText).toContain("return link dry-run");
    expect(compactText).toContain("candidates 2");
    expect(compactText).toContain("linkable 2");
    expect(compactText).toContain("view return link constraints");
    expect(compactText).toContain("taskGraphWritten");
    expect(compactText).toContain("pending 2");
    expect(compactText).toContain("matched 0");
    expect(compactText).toContain("unmatched 2");
    expect(compactText).toContain("view unmatched returns");
    expect(compactText).toContain("no_matching_task_node");
    expect(compactText).toContain("missing_task_id");
    expect(compactText).toContain("returnConsumed · no");
    expect(compactText).toContain("问题 1");
    expect(compactText).toContain("查看验真明细");
    expect(compactText).toContain("role_enum");
    expect(compactText).toContain("nodes[0].role");
    expect(compactText).toContain("unknown role");
    expect(fetchMock).toHaveBeenCalledWith("/api/hud/runtime-loop");
    expect(compactText).toContain("运行态总线");
    expect(fetchMock).toHaveBeenCalledWith("/api/hud/task-state");
    expect(compactText).toContain("任务台账");
    expect(compactText).toContain("历史任务台账");
    expect(compactText).toContain("不等于当前运行任务");
    expect(compactText).toContain("历史总数");
    expect(compactText).toContain("81");
    expect(compactText).toContain("历史完成");
    expect(compactText).toContain("73");
    expect(compactText).toContain("策略阻塞");
    expect(compactText).toContain("7");
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
