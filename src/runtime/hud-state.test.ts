import { describe, expect, it } from "vitest";
import {
  generateHudState,
  normalizeHudAgentStatus,
  type HudPendingReturnItem,
  type HudTaskGraphItem,
} from "./hud-state.js";

const generatedAt = "2026-05-20T00:00:00.000Z";

function pendingReturn(overrides: Partial<HudPendingReturnItem> = {}): HudPendingReturnItem {
  return {
    returnId: "return-a.json",
    taskId: "TASK-A",
    sourceRole: "engineering-executive",
    action: "complete",
    status: "pending",
    createdAt: generatedAt,
    needsReview: true,
    summary: "pending return",
    ...overrides,
  };
}

function taskGraph(overrides: Partial<HudTaskGraphItem> = {}): HudTaskGraphItem {
  return {
    graphId: "graph-a",
    title: "Graph A",
    aggregateStatus: "running",
    nodeSummary: {
      total: 2,
      completed: 1,
      running: 1,
      ready: 0,
      planned: 0,
      blocked: 0,
      failed: 0,
    },
    blockers: [],
    nextRunnable: [],
    lastValidatedAt: null,
    validationSeverity: null,
    ...overrides,
  };
}

describe("HUD state core", () => {
  it("normalizes agent status aliases", () => {
    expect(normalizeHudAgentStatus("available")).toBe("completed");
    expect(normalizeHudAgentStatus("in_progress")).toBe("running");
    expect(normalizeHudAgentStatus("blocked")).toBe("attention_required");
    expect(normalizeHudAgentStatus("error")).toBe("failed");
    expect(normalizeHudAgentStatus(null)).toBe("unknown");
  });

  it("builds agent groups only from position states and derives healthy counters", () => {
    const state = generateHudState({
      generatedAt,
      positionStatesByAgentId: {
        main: { status: "idle", progress: "50", currentTask: "TASK-MAIN" },
        "engineering-executive": { status: "running", progressPct: 30 },
        "front-end-executive": { status: "completed", progressPct: 100 },
      },
    });

    expect(state.generator).toBe("runtime-hud-state");
    expect(state.agentGroups.map((agent) => agent.agentId)).toEqual([
      "main",
      "engineering-executive",
      "front-end-executive",
      "patrol",
    ]);
    expect(state.globalStatus).toMatchObject({
      status: "healthy",
      runningCount: 1,
      completedCount: 2,
      failedCount: 0,
      alertCount: 0,
    });
    expect(state.agentGroups.find((agent) => agent.agentId === "main")).toMatchObject({
      status: "completed",
      currentTask: "TASK-MAIN",
      progressPct: 50,
      source: "position-state",
      progressDerivation: "position-state",
    });
    expect(state.agentGroups.find((agent) => agent.agentId === "patrol")).toMatchObject({
      role: "observability",
      status: "unknown",
      source: "configured",
      progressDerivation: "unknown",
    });
  });

  it("marks pending returns as attention_required", () => {
    const state = generateHudState({
      generatedAt,
      positionStatesByAgentId: {
        main: { status: "running" },
      },
      pendingReturnItems: [pendingReturn()],
    });

    expect(state.globalStatus.status).toBe("attention_required");
    expect(state.globalStatus.pendingReviewCount).toBe(1);
    expect(state.returnInbox.pendingItems[0]?.returnId).toBe("return-a.json");
  });

  it("marks warnings or unknown agent state as degraded", () => {
    const state = generateHudState({
      generatedAt,
      warnings: ["positions state directory missing"],
    });

    expect(state.globalStatus.status).toBe("degraded");
    expect(state.warnings).toEqual(["positions state directory missing"]);
  });

  it("summarizes task graph totals while capping visible items", () => {
    const state = generateHudState({
      generatedAt,
      taskGraphItems: [
        taskGraph({ graphId: "graph-a", aggregateStatus: "running" }),
        taskGraph({ graphId: "graph-b", aggregateStatus: "blocked" }),
        taskGraph({ graphId: "graph-c", aggregateStatus: "completed" }),
        taskGraph({ graphId: "graph-d", aggregateStatus: "planned" }),
        taskGraph({ graphId: "graph-e", aggregateStatus: "ready" }),
        taskGraph({ graphId: "graph-f", aggregateStatus: "running" }),
      ],
    });

    expect(state.taskGraphs.total).toBe(6);
    expect(state.taskGraphs.active).toBe(5);
    expect(state.taskGraphs.blocked).toBe(1);
    expect(state.taskGraphs.returnPreview).toMatchObject({
      mode: "observe-only",
      graphCount: 0,
      pendingReturnCount: 0,
      unmatchedReturnCount: 0,
    });
    expect(state.taskGraphs.items.map((item) => item.graphId)).toEqual([
      "graph-a",
      "graph-b",
      "graph-c",
      "graph-d",
      "graph-e",
    ]);
  });

  it("aggregates task graph validation severity into watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      taskGraphItems: [
        taskGraph({ graphId: "graph-a", validationSeverity: "pass" }),
        taskGraph({ graphId: "graph-b", validationSeverity: "warning" }),
        taskGraph({ graphId: "graph-c", validationSeverity: "error" }),
        taskGraph({ graphId: "graph-d", validationSeverity: "error" }),
      ],
    });

    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 3,
      byCondition: {
        taskGraphValidationWarning: 1,
        taskGraphValidationError: 2,
      },
    });
  });

  it("carries mirror observe visibility without changing global health", () => {
    const state = generateHudState({
      generatedAt,
      mirrorObserve: {
        available: true,
        reportPath: "runtime/main/tmp/mirror-observe-a.json",
        mirrorId: "mirror-a",
        generatedAt,
        mode: "observe-only",
        stats: {
          observationCount: 4,
          findingCount: 4,
          bySeverity: {
            attention: 2,
            info: 2,
          },
        },
        constraintsVerified: {
          promoted: "none",
          applyPerformed: "no",
        },
        verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
      },
    });

    expect(state.globalStatus.status).toBe("healthy");
    expect(state.mirrorObserve).toMatchObject({
      available: true,
      reportPath: "runtime/main/tmp/mirror-observe-a.json",
      mirrorId: "mirror-a",
      mode: "observe-only",
      constraintsVerified: {
        promoted: "none",
        applyPerformed: "no",
      },
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 2,
      byCondition: {
        mirrorObserveAttention: 2,
      },
    });
  });

  it("flags mirror observe constraint deviations in watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      mirrorObserve: {
        available: true,
        reportPath: "runtime/main/tmp/mirror-observe-a.json",
        mirrorId: "mirror-a",
        generatedAt,
        mode: "observe-only",
        stats: {
          observationCount: 1,
          findingCount: 1,
          bySeverity: {
            warning: 1,
          },
        },
        constraintsVerified: {
          promoted: "candidate-a",
          applyPerformed: "yes",
        },
        verdict: "unexpected",
      },
    });

    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 3,
      byCondition: {
        mirrorObserveWarning: 1,
        mirrorObserveConstraintViolation: 2,
      },
    });
  });

  it("carries auto-evolution observe visibility and watchdog priorities", () => {
    const state = generateHudState({
      generatedAt,
      autoEvolutionObserve: {
        available: true,
        reportPath: "runtime/main/tmp/auto-evolution-observe-a.json",
        generatedAt,
        mode: "observe-only",
        stats: {
          totalSuggestions: 3,
          byPriority: {
            P1: 2,
            P2: 1,
          },
          bySource: {
            mirror: 1,
            promote_gate: 1,
            hud: 1,
          },
        },
        constraintsVerified: {
          MEMORYWritten: "no",
          ENGINEERING_RULESWritten: "no",
          codeWritten: "no",
          promoted: "none",
          applyPerformed: "no",
          autoEvolutionApplied: "no",
          continuousAutoLoopTriggered: "no",
        },
        verdict: "PASS / AUTO-EVOLUTION OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
      },
    });

    expect(state.autoEvolutionObserve).toMatchObject({
      available: true,
      reportPath: "runtime/main/tmp/auto-evolution-observe-a.json",
      mode: "observe-only",
      stats: {
        totalSuggestions: 3,
      },
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 2,
      byCondition: {
        autoEvolutionObserveP1: 2,
      },
    });
  });

  it("carries semantic rebuild visibility without changing global health", () => {
    const state = generateHudState({
      generatedAt,
      semanticRebuild: {
        available: true,
        stage: "ready_for_real_rebuild_implementation",
        latestPlanPath: "runtime/main/tmp/kb-semantic-rebuild-plan-a.json",
        latestAcceptancePath: "runtime/main/tmp/kb-semantic-rebuild-acceptance-a.json",
        latestApprovalPath: "runtime/main/tmp/kb-semantic-rebuild-approval-a.json",
        latestExecutionPath: null,
        executionStatus: null,
        totalItems: 2,
        plannedBatches: 1,
        readyForHumanGate: true,
        readyForExecution: true,
        readyForRealRebuildImplementation: true,
        constraintsVerified: {
          embeddingCalls: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      },
    });

    expect(state.globalStatus.status).toBe("healthy");
    expect(state.semanticRebuild).toMatchObject({
      available: true,
      stage: "ready_for_real_rebuild_implementation",
      latestPlanPath: "runtime/main/tmp/kb-semantic-rebuild-plan-a.json",
      latestAcceptancePath: "runtime/main/tmp/kb-semantic-rebuild-acceptance-a.json",
      latestApprovalPath: "runtime/main/tmp/kb-semantic-rebuild-approval-a.json",
      latestExecutionPath: null,
      executionStatus: null,
      totalItems: 2,
      plannedBatches: 1,
      readyForRealRebuildImplementation: true,
      constraintsVerified: {
        embeddingCalls: "no",
        vectorIndexWritten: "no",
        realRebuildTriggered: "no",
        applied: "no",
      },
    });
  });

  it("defaults semantic rebuild visibility to missing plan", () => {
    const state = generateHudState({ generatedAt });

    expect(state.semanticRebuild).toEqual({
      available: false,
      stage: "plan_missing",
      latestPlanPath: null,
      latestAcceptancePath: null,
      latestApprovalPath: null,
      latestExecutionPath: null,
      executionStatus: null,
      totalItems: null,
      plannedBatches: null,
      readyForHumanGate: false,
      readyForExecution: false,
      readyForRealRebuildImplementation: false,
      constraintsVerified: null,
    });
    expect(state.controlSignals).toMatchObject({
      mode: "observe-only",
      status: "ok",
      pendingCount: 0,
      invalidCount: 0,
    });
    expect(state.recoveryCandidates).toMatchObject({
      mode: "observe-only",
      graphCount: 0,
      candidateCount: 0,
      errorCount: 0,
    });
    expect(state.returnConsumerPlan).toMatchObject({
      mode: "observe-only",
      scannedAt: generatedAt,
      totalCount: 0,
      processCount: 0,
      skipCount: 0,
      warningCount: 0,
    });
    expect(state.returnDiagnosis).toMatchObject({
      mode: "observe-only",
      scannedAt: generatedAt,
      totalCount: 0,
      diagnosableCount: 0,
      warningCount: 0,
    });
    expect(state.returnRepairDryRun).toMatchObject({
      mode: "observe-only",
      dryRun: true,
      plannedAt: generatedAt,
      candidateCount: 0,
      repairableCount: 0,
      blockedCount: 0,
      warningCount: 0,
    });
    expect(state.returnReconciliationGate).toMatchObject({
      mode: "observe-only",
      checkedAt: generatedAt,
      status: "empty",
      frozen: false,
      readyForControlledApply: false,
      applyBlockedReason: null,
      nextAction: "no_action",
      repair: {
        candidateCount: 0,
        repairableCount: 0,
        blockedCount: 0,
      },
      returnLink: {
        candidateCount: 0,
        linkableCount: 0,
        blockedCount: 0,
      },
    });
    expect(state.taskGraphs.returnLinkDryRun).toMatchObject({
      mode: "observe-only",
      dryRun: true,
      candidateCount: 0,
      linkableCount: 0,
      blockedCount: 0,
      warningCount: 0,
    });
    expect(state.promotionCandidates).toMatchObject({
      available: false,
      status: "missing",
      stats: {
        total: 0,
        byState: {},
        byRisk: {},
        byConsistency: {},
        invalid: 0,
        safeApplyEligible: 0,
      },
      errorCount: 0,
    });
    expect(state.schedulerTickPlan).toMatchObject({
      mode: "observe-only",
      decision: "disabled",
      enabled: false,
      markerMode: "observe",
      warningCount: 0,
      constraintsVerified: {
        readOnly: "yes",
        scriptInvoked: "no",
        childProcessSpawned: "no",
        autoDispatchTriggered: "no",
        applied: "no",
      },
    });
  });

  it("adds D7 control and recovery summaries to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      controlSignals: {
        mode: "observe-only",
        status: "ok",
        pendingPath: "system/control-signals/pending",
        frozen: false,
        g2Approved: false,
        pendingCount: 2,
        expiredCount: 1,
        errorCount: 1,
        validCount: 1,
        invalidCount: 1,
        byRole: [{ role: "engineering-executive", count: 2 }],
        byAction: [{ action: "pause", count: 2 }],
        constraintsVerified: {
          readOnly: "yes",
          signalWritten: "no",
          taskGraphMutated: "no",
          sessionsSent: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
      },
      recoveryCandidates: {
        mode: "observe-only",
        sourcePath: "runtime/main/tmp/v2-task-graph-01/",
        frozen: false,
        graphCount: 1,
        candidateCount: 3,
        byStatus: [{ status: "failed", count: 3 }],
        bySuggestedAction: [{ action: "retry", count: 3 }],
        errorCount: 1,
        constraintsVerified: {
          readOnly: "yes",
          recoveryDecisionWritten: "no",
          taskGraphMutated: "no",
          sessionsSent: "no",
          autoDispatchTriggered: "no",
          applied: "no",
        },
      },
    });

    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 8,
      byCondition: {
        pendingControlSignals: 2,
        invalidControlSignals: 1,
        controlSignalScanError: 1,
        recoveryCandidates: 3,
        recoveryCandidateScanError: 1,
      },
    });
  });

  it("adds task graph return preview mismatches to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      taskGraphReturnPreview: {
        mode: "observe-only",
        observedAt: generatedAt,
        sourcePath: "runtime/main/tmp/v2-task-graph-01/",
        inboxPath: "system/returns/inbox",
        graphCount: 1,
        nodeCount: 2,
        pendingReturnCount: 2,
        matchedNodeCount: 0,
        missingNodeCount: 1,
        ambiguousNodeCount: 0,
        declaredReturnNodeCount: 1,
        unmatchedReturnCount: 2,
        graphErrorCount: 1,
        sampleUnmatchedReturns: [
          {
            returnId: "return-a.json",
            taskId: "TASK-A",
            reason: "no_matching_task_node",
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
    });

    expect(state.taskGraphs.returnPreview).toMatchObject({
      graphCount: 1,
      pendingReturnCount: 2,
      unmatchedReturnCount: 2,
      graphErrorCount: 1,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 3,
      byCondition: {
        taskGraphUnmatchedReturns: 2,
        taskGraphReturnPreviewError: 1,
      },
    });
  });

  it("adds blocked task graph return link dry-runs to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      taskGraphReturnLinkDryRun: {
        mode: "observe-only",
        dryRun: true,
        plannedAt: generatedAt,
        sourcePath: "runtime/main/tmp/v2-task-graph-01/",
        inboxPath: "system/returns/inbox",
        unmatchedReturnCount: 3,
        candidateCount: 3,
        linkableCount: 2,
        blockedCount: 1,
        graphErrorCount: 0,
        warningCount: 1,
        constraintsVerified: {
          readOnly: "yes",
          taskGraphWritten: "no",
          returnConsumed: "no",
          receiptWritten: "no",
          dispatchTriggered: "no",
          applied: "no",
        },
      },
    });

    expect(state.taskGraphs.returnLinkDryRun).toMatchObject({
      candidateCount: 3,
      linkableCount: 2,
      blockedCount: 1,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 2,
      byCondition: {
        taskGraphReturnLinkBlocked: 1,
        taskGraphReturnLinkWarning: 1,
      },
    });
  });

  it("adds return consumer plan summary to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      returnConsumerPlan: {
        mode: "observe-only",
        scannedAt: generatedAt,
        inboxPath: "system/returns/inbox",
        processedPath: "system/returns/processed",
        totalCount: 4,
        processCount: 1,
        skipCount: 3,
        byReason: [{ reason: "schema-invalid", count: 3 }],
        warningCount: 2,
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      },
    });

    expect(state.returnConsumerPlan).toMatchObject({
      totalCount: 4,
      processCount: 1,
      skipCount: 3,
      byReason: [{ reason: "schema-invalid", count: 3 }],
      warningCount: 2,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 6,
      byCondition: {
        returnConsumerProcessable: 1,
        returnConsumerSkipped: 3,
        returnConsumerPlanWarning: 2,
      },
    });
  });

  it("adds return diagnosis summary to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      returnDiagnosis: {
        mode: "observe-only",
        scannedAt: generatedAt,
        inboxPath: "system/returns/inbox",
        totalCount: 2,
        diagnosableCount: 2,
        byCompatibility: [{ compatibility: "v2-shaped", count: 2 }],
        bySuggestedAction: [{ action: "repair-to-v1-dry-run", count: 2 }],
        byIssueCode: [
          { code: "consumer_schema_invalid", count: 5 },
          { code: "task_graph_unmatched", count: 2 },
        ],
        warningCount: 1,
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
    });

    expect(state.returnDiagnosis).toMatchObject({
      totalCount: 2,
      diagnosableCount: 2,
      byCompatibility: [{ compatibility: "v2-shaped", count: 2 }],
      bySuggestedAction: [{ action: "repair-to-v1-dry-run", count: 2 }],
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 3,
      byCondition: {
        returnDiagnosisIssue: 2,
        returnDiagnosisWarning: 1,
      },
    });
  });

  it("adds blocked return repair dry-run plans to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      returnRepairDryRun: {
        mode: "observe-only",
        dryRun: true,
        plannedAt: generatedAt,
        inboxPath: "system/returns/inbox",
        totalDiagnosed: 3,
        candidateCount: 3,
        repairableCount: 2,
        blockedCount: 1,
        warningCount: 1,
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
    });

    expect(state.returnRepairDryRun).toMatchObject({
      candidateCount: 3,
      repairableCount: 2,
      blockedCount: 1,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 2,
      byCondition: {
        returnRepairDryRunBlocked: 1,
        returnRepairDryRunWarning: 1,
      },
    });
  });

  it("adds return reconciliation dry-run blockers to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      returnReconciliationGate: {
        mode: "observe-only",
        checkedAt: generatedAt,
        status: "blocked",
        frozen: false,
        readyForControlledApply: false,
        applyBlockedReason: "dry_run_blocked",
        nextAction: "resolve_blockers",
        repair: {
          candidateCount: 3,
          repairableCount: 2,
          blockedCount: 1,
        },
        returnLink: {
          candidateCount: 3,
          linkableCount: 1,
          blockedCount: 2,
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
    });

    expect(state.returnReconciliationGate).toMatchObject({
      status: "blocked",
      applyBlockedReason: "dry_run_blocked",
      nextAction: "resolve_blockers",
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 3,
      byCondition: {
        returnReconciliationDryRunBlocked: 3,
      },
    });
  });

  it("adds D9 promotion candidate scan issues to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      promotionCandidates: {
        available: true,
        status: "ok",
        sourceFile: "evolution/promotion-candidates.json",
        stateFile: "evolution/candidate-gate-state.json",
        generatedAt,
        lastSyncedAt: generatedAt,
        stats: {
          total: 4,
          byState: {
            pending: 2,
            invalid: 1,
            rejected: 1,
          },
          byRisk: {
            low: 3,
            high: 1,
          },
          byConsistency: {
            ok: 2,
            "orphan-write": 1,
            invalid: 1,
          },
          invalid: 1,
          safeApplyEligible: 3,
        },
        errorCount: 1,
        constraintsVerified: {
          readOnly: "yes",
          candidateStateWritten: "no",
          truthFilesWritten: "no",
          applied: "none",
          rolledBack: "none",
          autoPromote: "disabled",
        },
      },
    });

    expect(state.promotionCandidates).toMatchObject({
      available: true,
      status: "ok",
      stats: {
        total: 4,
        invalid: 1,
        safeApplyEligible: 3,
      },
      errorCount: 1,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 4,
      byCondition: {
        invalidPromotionCandidates: 1,
        promotionCandidateConsistencyIssue: 2,
        promotionCandidateScanError: 1,
      },
    });
  });

  it("adds scheduler tick plan safety states to watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      schedulerTickPlan: {
        mode: "observe-only",
        plannedAt: generatedAt,
        decision: "would_spawn_apply_tick",
        reason: "scheduler would spawn the apply tick script in current legacy runtime",
        enabled: true,
        markerMode: "apply",
        stateStatus: "idle",
        running: false,
        totalTicks: 1,
        nextTickIndex: 2,
        maxTicks: {
          effective: 5,
          reason: "global_max_ticks",
          global: 5,
          perTask: null,
          perTaskId: null,
          reached: false,
        },
        sourceFiles: {
          marker: "runtime/main/tmp/task-scheduler-enabled.json",
          state: "runtime/main/tmp/task-scheduler-state.json",
          policy: "runtime/scheduler/scheduler-policy.json",
          tickScript: "evolution/run-auto-progress-tick.ps1",
          tickScriptExists: true,
        },
        warningCount: 0,
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
    });

    expect(state.schedulerTickPlan).toMatchObject({
      decision: "would_spawn_apply_tick",
      nextTickIndex: 2,
    });
    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 1,
      byCondition: {
        schedulerWouldSpawnApplyTick: 1,
      },
    });
  });

  it("flags auto-evolution constraint deviations in watchdog conditions", () => {
    const state = generateHudState({
      generatedAt,
      autoEvolutionObserve: {
        available: true,
        reportPath: "runtime/main/tmp/auto-evolution-observe-a.json",
        generatedAt,
        mode: "observe-only",
        stats: {
          totalSuggestions: 1,
          byPriority: {
            P0: 1,
          },
          bySource: {
            runtime_loop: 1,
          },
        },
        constraintsVerified: {
          codeWritten: "yes",
          promoted: "candidate-a",
          autoEvolutionApplied: "yes",
          continuousAutoLoopTriggered: "yes",
        },
        verdict: "unexpected",
      },
    });

    expect(state.watchdogSnapshot).toMatchObject({
      totalAlerts: 5,
      byCondition: {
        autoEvolutionObserveP0: 1,
        autoEvolutionObserveConstraintViolation: 4,
      },
    });
  });
});
