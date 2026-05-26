import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluatePositionConfigCleanupGate } from "./position-config-cleanup-gate.js";
import {
  type PositionConfigCleanupTarget,
  buildPositionConfigCleanupPlan,
} from "./position-config-cleanup-plan.js";

export const POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION = "apply-position-config-cleanup";

export type PositionConfigCleanupApplyStatus =
  | "invalid_request"
  | "blocked"
  | "dry_run"
  | "applied";

export interface PositionConfigCleanupApplyRemoval {
  positionId: string;
  target: PositionConfigCleanupTarget;
}

export interface PositionConfigCleanupApplyResult {
  mode: "controlled-apply";
  requestedAt: string;
  status: PositionConfigCleanupApplyStatus;
  dryRun: boolean;
  readyForControlledApply: boolean;
  applyBlockedReason: string | null;
  message: string;
  removals: PositionConfigCleanupApplyRemoval[];
  constraintsVerified: {
    readOnly: "no";
    positionConfigWritten: "yes" | "no";
    agentsListMutated: "no";
    sessionsSent: "no";
    applied: "yes" | "no";
  };
}

export interface PositionConfigCleanupApplyOptions {
  requestedAt?: string;
  confirm?: string;
  dryRun?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constraints(params?: {
  positionConfigWritten?: "yes" | "no";
  applied?: "yes" | "no";
}): PositionConfigCleanupApplyResult["constraintsVerified"] {
  return {
    readOnly: "no",
    positionConfigWritten: params?.positionConfigWritten ?? "no",
    agentsListMutated: "no",
    sessionsSent: "no",
    applied: params?.applied ?? "no",
  };
}

function result(params: {
  requestedAt: string;
  status: PositionConfigCleanupApplyStatus;
  dryRun: boolean;
  readyForControlledApply: boolean;
  applyBlockedReason: string | null;
  message: string;
  removals?: PositionConfigCleanupApplyRemoval[];
  positionConfigWritten?: "yes" | "no";
  applied?: "yes" | "no";
}): PositionConfigCleanupApplyResult {
  return {
    mode: "controlled-apply",
    requestedAt: params.requestedAt,
    status: params.status,
    dryRun: params.dryRun,
    readyForControlledApply: params.readyForControlledApply,
    applyBlockedReason: params.applyBlockedReason,
    message: params.message,
    removals: params.removals ?? [],
    constraintsVerified: constraints({
      positionConfigWritten: params.positionConfigWritten,
      applied: params.applied,
    }),
  };
}

export function applyPositionConfigCleanup(
  workspaceRoot: string,
  options: PositionConfigCleanupApplyOptions = {},
): PositionConfigCleanupApplyResult {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  if (options.confirm !== POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION) {
    return result({
      requestedAt,
      status: "invalid_request",
      dryRun,
      readyForControlledApply: false,
      applyBlockedReason: "confirmation_required",
      message: `confirm must equal ${POSITION_CONFIG_CLEANUP_APPLY_CONFIRMATION}.`,
    });
  }

  const gate = evaluatePositionConfigCleanupGate(workspaceRoot, { checkedAt: requestedAt });
  const plan = buildPositionConfigCleanupPlan(workspaceRoot, {
    plannedAt: requestedAt,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const removals = plan.steps.map((step) => ({
    positionId: step.positionId,
    target: step.target,
  }));

  if (!gate.readyForControlledApply) {
    return result({
      requestedAt,
      status: "blocked",
      dryRun,
      readyForControlledApply: false,
      applyBlockedReason: gate.applyBlockedReason ?? "cleanup_gate_not_ready",
      message: "Position config cleanup is blocked by the current cleanup gate.",
      removals,
    });
  }

  if (dryRun) {
    return result({
      requestedAt,
      status: "dry_run",
      dryRun,
      readyForControlledApply: true,
      applyBlockedReason: null,
      message: "Position config cleanup would remove stale configured-only entries.",
      removals,
    });
  }

  const configPath = path.join(workspaceRoot, ".claw", "positions.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
  const config = isRecord(parsed) ? parsed : {};
  for (const removal of removals) {
    const target = config[removal.target];
    if (isRecord(target)) {
      delete target[removal.positionId];
    }
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return result({
    requestedAt,
    status: "applied",
    dryRun: false,
    readyForControlledApply: true,
    applyBlockedReason: null,
    message: "Position config cleanup applied.",
    removals,
    positionConfigWritten: "yes",
    applied: "yes",
  });
}
