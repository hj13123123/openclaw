import { buildTaskGraphReturnLinkDryRun } from "../task-graph-return-link-dry-run.js";
import { evaluateReturnReconciliationGate } from "./return-reconciliation-gate.js";
import { buildReturnRepairDryRun } from "./return-repair-dry-run.js";

export type ReturnReconciliationApplyPlanStatus = "empty" | "ready" | "blocked";
export type ReturnReconciliationApplyPlanBlockedReason = "frozen" | "dry_run_blocked";
export type ReturnReconciliationApplyPlanAction =
  | "repair-return-package"
  | "link-return-to-task-graph"
  | "validate-postconditions";

export interface ReturnReconciliationApplyPlanStep {
  stepId: string;
  order: number;
  returnId: string;
  taskId: string | null;
  action: ReturnReconciliationApplyPlanAction;
  ready: boolean;
  blockedReasons: string[];
  summary: string;
}

export interface ReturnReconciliationApplyPlanResult {
  mode: "observe-only";
  dryRun: true;
  plannedAt: string;
  status: ReturnReconciliationApplyPlanStatus;
  frozen: boolean;
  readyForControlledApply: boolean;
  blockedReasons: ReturnReconciliationApplyPlanBlockedReason[];
  nextAction:
    | "no_action"
    | "controlled_apply_can_be_planned"
    | "resolve_blockers"
    | "await_unfreeze_or_human_approval";
  repair: {
    candidateCount: number;
    repairableCount: number;
    blockedCount: number;
  };
  returnLink: {
    candidateCount: number;
    linkableCount: number;
    blockedCount: number;
  };
  stepCount: number;
  readyStepCount: number;
  blockedStepCount: number;
  steps: ReturnReconciliationApplyPlanStep[];
  constraintsVerified: {
    readOnly: "yes";
    returnWritten: "no";
    taskGraphWritten: "no";
    receiptWritten: "no";
    consumerTriggered: "no";
    dispatchTriggered: "no";
    applied: "no";
  };
}

export interface ReturnReconciliationApplyPlanOptions {
  plannedAt?: string;
  limit?: number;
}

function stepSafeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

export function buildReturnReconciliationApplyPlan(
  workspaceRoot: string,
  options: ReturnReconciliationApplyPlanOptions = {},
): ReturnReconciliationApplyPlanResult {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const gate = evaluateReturnReconciliationGate(workspaceRoot, { checkedAt: plannedAt });
  const repair = buildReturnRepairDryRun(workspaceRoot, {
    plannedAt,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const returnLink = buildTaskGraphReturnLinkDryRun(workspaceRoot, {
    plannedAt,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const linkPlansByReturnId = new Map(returnLink.plans.map((plan) => [plan.returnId, plan]));
  const steps: ReturnReconciliationApplyPlanStep[] = [];

  for (const repairPlan of repair.plans) {
    const returnId = repairPlan.sourceFile;
    const linkPlan = linkPlansByReturnId.get(returnId);
    const repairReady = repairPlan.repairable;
    steps.push({
      stepId: `repair-${stepSafeId(returnId)}`,
      order: steps.length + 1,
      returnId,
      taskId: repairPlan.taskId,
      action: "repair-return-package",
      ready: repairReady,
      blockedReasons: repairPlan.blockedReasons,
      summary: repairReady
        ? "Prepare a V1-compatible repaired return package in a controlled apply."
        : "Repair dry-run is blocked; controlled apply must not write this return.",
    });

    const linkReady = linkPlan?.linkable === true;
    steps.push({
      stepId: `link-${stepSafeId(returnId)}`,
      order: steps.length + 1,
      returnId,
      taskId: linkPlan?.taskId ?? repairPlan.taskId,
      action: "link-return-to-task-graph",
      ready: linkReady,
      blockedReasons: linkPlan?.blockedReasons ?? ["return_link_plan_missing"],
      summary: linkReady
        ? "Prepare a review_pending task graph node for the repaired return."
        : "Task graph link dry-run is blocked; controlled apply must not mutate the graph.",
    });
  }

  if (repair.candidateCount > 0 || returnLink.candidateCount > 0) {
    const postconditionReady =
      gate.applyBlockedReason === null &&
      gate.readyForControlledApply &&
      steps.every((step) => step.ready);
    steps.push({
      stepId: "validate-postconditions",
      order: steps.length + 1,
      returnId: "*",
      taskId: null,
      action: "validate-postconditions",
      ready: postconditionReady,
      blockedReasons: postconditionReady
        ? []
        : [
            ...(gate.frozen ? ["frozen"] : []),
            ...(gate.applyBlockedReason === "dry_run_blocked" ? ["dry_run_blocked"] : []),
          ],
      summary:
        "Re-run return diagnosis, repair dry-run, and task graph link dry-run after any controlled apply.",
    });
  }

  const blockedReasons: ReturnReconciliationApplyPlanBlockedReason[] = [
    ...(gate.frozen ? (["frozen"] as const) : []),
    ...(gate.applyBlockedReason === "dry_run_blocked" ? (["dry_run_blocked"] as const) : []),
  ];
  const status: ReturnReconciliationApplyPlanStatus =
    gate.status === "empty" ? "empty" : blockedReasons.length === 0 ? "ready" : "blocked";

  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    status,
    frozen: gate.frozen,
    readyForControlledApply: gate.readyForControlledApply,
    blockedReasons,
    nextAction: gate.nextAction,
    repair: gate.repair,
    returnLink: gate.returnLink,
    stepCount: steps.length,
    readyStepCount: steps.filter((step) => step.ready).length,
    blockedStepCount: steps.filter((step) => !step.ready).length,
    steps: steps.slice(0, limit),
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      taskGraphWritten: "no",
      receiptWritten: "no",
      consumerTriggered: "no",
      dispatchTriggered: "no",
      applied: "no",
    },
  };
}
