import { scanControlSignals } from "./control-signals.js";
import { buildPositionConfigCleanupPlan } from "./position-config-cleanup-plan.js";

export type PositionConfigCleanupGateStatus = "empty" | "ready" | "blocked";
export type PositionConfigCleanupGateNextAction =
  | "no_action"
  | "controlled_apply_can_be_planned"
  | "resolve_blockers"
  | "await_unfreeze_or_human_approval";

export interface PositionConfigCleanupGateResult {
  mode: "observe-only";
  checkedAt: string;
  status: PositionConfigCleanupGateStatus;
  frozen: boolean;
  g2Approved: boolean;
  readyForControlledApply: boolean;
  applyBlockedReason: "frozen" | "cleanup_plan_blocked" | null;
  nextAction: PositionConfigCleanupGateNextAction;
  cleanup: {
    staleConfiguredOnlyCount: number;
    removalStepCount: number;
    readyStepCount: number;
    blockedStepCount: number;
  };
  constraintsVerified: {
    readOnly: "yes";
    positionConfigWritten: "no";
    agentsListMutated: "no";
    sessionsSent: "no";
    applied: "no";
  };
}

export interface PositionConfigCleanupGateOptions {
  checkedAt?: string;
}

function constraints(): PositionConfigCleanupGateResult["constraintsVerified"] {
  return {
    readOnly: "yes",
    positionConfigWritten: "no",
    agentsListMutated: "no",
    sessionsSent: "no",
    applied: "no",
  };
}

export function evaluatePositionConfigCleanupGate(
  workspaceRoot: string,
  options: PositionConfigCleanupGateOptions = {},
): PositionConfigCleanupGateResult {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const plan = buildPositionConfigCleanupPlan(workspaceRoot, { plannedAt: checkedAt, limit: 0 });
  const controlSignals = scanControlSignals(workspaceRoot, {
    scannedAt: checkedAt,
    respectFrozenGate: true,
  });
  const frozenBlocksApply = controlSignals.frozen && !controlSignals.g2Approved;
  const status: PositionConfigCleanupGateStatus =
    plan.status === "clean" ? "empty" : plan.readyForControlledApply ? "ready" : "blocked";
  const readyForControlledApply = status === "ready" && !frozenBlocksApply;
  const applyBlockedReason =
    status === "empty"
      ? null
      : plan.readyForControlledApply
        ? frozenBlocksApply
          ? "frozen"
          : null
        : "cleanup_plan_blocked";
  const nextAction: PositionConfigCleanupGateNextAction =
    status === "empty"
      ? "no_action"
      : applyBlockedReason === "frozen"
        ? "await_unfreeze_or_human_approval"
        : readyForControlledApply
          ? "controlled_apply_can_be_planned"
          : "resolve_blockers";

  return {
    mode: "observe-only",
    checkedAt,
    status,
    frozen: controlSignals.frozen,
    g2Approved: controlSignals.g2Approved,
    readyForControlledApply,
    applyBlockedReason,
    nextAction,
    cleanup: {
      staleConfiguredOnlyCount: plan.staleConfiguredOnlyPositions.length,
      removalStepCount: plan.removalStepCount,
      readyStepCount: plan.readyStepCount,
      blockedStepCount: plan.blockedStepCount,
    },
    constraintsVerified: constraints(),
  };
}
