import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildTaskGraphReturnLinkDryRun } from "../task-graph-return-link-dry-run.js";
import { buildReturnRepairDryRun } from "./return-repair-dry-run.js";

export type ReturnReconciliationGateStatus = "empty" | "ready" | "blocked";
export type ReturnReconciliationGateNextAction =
  | "no_action"
  | "controlled_apply_can_be_planned"
  | "resolve_blockers"
  | "await_unfreeze_or_human_approval";

export interface ReturnReconciliationGateResult {
  mode: "observe-only";
  checkedAt: string;
  status: ReturnReconciliationGateStatus;
  frozen: boolean;
  readyForControlledApply: boolean;
  applyBlockedReason: "frozen" | "dry_run_blocked" | null;
  nextAction: ReturnReconciliationGateNextAction;
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

export interface ReturnReconciliationGateOptions {
  checkedAt?: string;
}

function readTextIfExists(filePath: string): string {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  } catch {
    return "";
  }
}

function detectFrozenFlag(workspaceRoot: string): boolean {
  return (
    /frozen/iu.test(readTextIfExists(path.join(workspaceRoot, "HEARTBEAT.md"))) ||
    /frozen flag.*active/iu.test(readTextIfExists(path.join(workspaceRoot, "SESSION_SUMMARY.md")))
  );
}

function dryRunsReady(params: {
  repairCandidateCount: number;
  repairableCount: number;
  repairBlockedCount: number;
  linkCandidateCount: number;
  linkableCount: number;
  linkBlockedCount: number;
}): boolean {
  return (
    params.repairCandidateCount > 0 &&
    params.repairBlockedCount === 0 &&
    params.linkBlockedCount === 0 &&
    params.repairCandidateCount === params.repairableCount &&
    params.linkCandidateCount === params.linkableCount &&
    params.repairCandidateCount === params.linkCandidateCount
  );
}

export function evaluateReturnReconciliationGate(
  workspaceRoot: string,
  options: ReturnReconciliationGateOptions = {},
): ReturnReconciliationGateResult {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const repair = buildReturnRepairDryRun(workspaceRoot, { plannedAt: checkedAt, limit: 0 });
  const returnLink = buildTaskGraphReturnLinkDryRun(workspaceRoot, {
    plannedAt: checkedAt,
    limit: 0,
  });
  const frozen = detectFrozenFlag(workspaceRoot);
  const readyDryRun = dryRunsReady({
    repairCandidateCount: repair.candidateCount,
    repairableCount: repair.repairableCount,
    repairBlockedCount: repair.blockedCount,
    linkCandidateCount: returnLink.candidateCount,
    linkableCount: returnLink.linkableCount,
    linkBlockedCount: returnLink.blockedCount,
  });
  const status: ReturnReconciliationGateStatus =
    repair.candidateCount === 0 && returnLink.candidateCount === 0
      ? "empty"
      : readyDryRun
        ? "ready"
        : "blocked";
  const readyForControlledApply = readyDryRun && !frozen;
  const applyBlockedReason =
    status === "empty" ? null : readyDryRun ? (frozen ? "frozen" : null) : "dry_run_blocked";
  const nextAction: ReturnReconciliationGateNextAction =
    status === "empty"
      ? "no_action"
      : frozen
        ? "await_unfreeze_or_human_approval"
        : readyForControlledApply
          ? "controlled_apply_can_be_planned"
          : "resolve_blockers";

  return {
    mode: "observe-only",
    checkedAt,
    status,
    frozen,
    readyForControlledApply,
    applyBlockedReason,
    nextAction,
    repair: {
      candidateCount: repair.candidateCount,
      repairableCount: repair.repairableCount,
      blockedCount: repair.blockedCount,
    },
    returnLink: {
      candidateCount: returnLink.candidateCount,
      linkableCount: returnLink.linkableCount,
      blockedCount: returnLink.blockedCount,
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
  };
}
