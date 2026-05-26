import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { V2_POSITION_IDS } from "./position-config-audit.js";

export type PositionConfigCleanupPlanStatus = "missing" | "invalid" | "clean" | "ready" | "blocked";
export type PositionConfigCleanupTarget = "positionModelMapping" | "positionOverrides";

export interface PositionConfigCleanupPlanStep {
  stepId: string;
  order: number;
  positionId: string;
  target: PositionConfigCleanupTarget;
  action: "remove-configured-only-entry";
  ready: boolean;
  blockedReasons: string[];
  summary: string;
}

export interface PositionConfigCleanupPlanResult {
  mode: "observe-only";
  dryRun: true;
  plannedAt: string;
  status: PositionConfigCleanupPlanStatus;
  configPath: string;
  available: boolean;
  officialPositionIds: string[];
  enabledPositions: string[];
  staleConfiguredOnlyPositions: string[];
  retainedConfiguredOnlyOfficialPositions: string[];
  nonV2EnabledPositions: string[];
  removalStepCount: number;
  readyStepCount: number;
  blockedStepCount: number;
  readyForControlledApply: boolean;
  blockedReasons: string[];
  steps: PositionConfigCleanupPlanStep[];
  constraintsVerified: {
    readOnly: "yes";
    positionConfigWritten: "no";
    agentsListMutated: "no";
    sessionsSent: "no";
    applied: "no";
  };
}

export interface PositionConfigCleanupPlanOptions {
  plannedAt?: string;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).filter((key) => key.trim().length > 0) : [];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stepSafeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function constraints(): PositionConfigCleanupPlanResult["constraintsVerified"] {
  return {
    readOnly: "yes",
    positionConfigWritten: "no",
    agentsListMutated: "no",
    sessionsSent: "no",
    applied: "no",
  };
}

function unavailableResult(
  plannedAt: string,
  configPath: string,
  status: "missing" | "invalid",
  blockedReason: string,
): PositionConfigCleanupPlanResult {
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    status,
    configPath,
    available: false,
    officialPositionIds: [...V2_POSITION_IDS],
    enabledPositions: [],
    staleConfiguredOnlyPositions: [],
    retainedConfiguredOnlyOfficialPositions: [],
    nonV2EnabledPositions: [],
    removalStepCount: 0,
    readyStepCount: 0,
    blockedStepCount: 0,
    readyForControlledApply: false,
    blockedReasons: [blockedReason],
    steps: [],
    constraintsVerified: constraints(),
  };
}

export function buildPositionConfigCleanupPlan(
  workspaceRoot: string,
  options: PositionConfigCleanupPlanOptions = {},
): PositionConfigCleanupPlanResult {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const configPath = ".claw/positions.json";
  const absolutePath = path.join(workspaceRoot, configPath);
  if (!existsSync(absolutePath)) {
    return unavailableResult(plannedAt, configPath, "missing", "positions_config_missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    return unavailableResult(
      plannedAt,
      configPath,
      "invalid",
      `positions_config_parse_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const config = isRecord(parsed) ? parsed : {};
  const officialSet = new Set<string>(V2_POSITION_IDS);
  const enabledPositions = uniqueSorted(stringArray(config.enabledPositions));
  const enabledSet = new Set(enabledPositions);
  const mappingKeys = recordKeys(config.positionModelMapping);
  const overrideKeys = recordKeys(config.positionOverrides);
  const configuredOnlyPositions = uniqueSorted([...mappingKeys, ...overrideKeys]).filter(
    (positionId) => !enabledSet.has(positionId),
  );
  const staleConfiguredOnlyPositions = configuredOnlyPositions.filter(
    (positionId) => !officialSet.has(positionId),
  );
  const retainedConfiguredOnlyOfficialPositions = configuredOnlyPositions.filter((positionId) =>
    officialSet.has(positionId),
  );
  const nonV2EnabledPositions = enabledPositions.filter(
    (positionId) => !officialSet.has(positionId),
  );
  const steps: PositionConfigCleanupPlanStep[] = [];

  for (const positionId of staleConfiguredOnlyPositions) {
    const targets: PositionConfigCleanupTarget[] = [
      ...(mappingKeys.includes(positionId) ? (["positionModelMapping"] as const) : []),
      ...(overrideKeys.includes(positionId) ? (["positionOverrides"] as const) : []),
    ];
    for (const target of targets) {
      steps.push({
        stepId: `remove-${stepSafeId(positionId)}-${target}`,
        order: steps.length + 1,
        positionId,
        target,
        action: "remove-configured-only-entry",
        ready: true,
        blockedReasons: [],
        summary: `Remove disabled non-V2 position entry from ${target}.`,
      });
    }
  }

  const blockedReasons = [...(nonV2EnabledPositions.length > 0 ? ["non_v2_position_enabled"] : [])];
  const readyForControlledApply = steps.length > 0 && blockedReasons.length === 0;
  const status: PositionConfigCleanupPlanStatus =
    blockedReasons.length > 0 ? "blocked" : steps.length > 0 ? "ready" : "clean";

  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    status,
    configPath,
    available: true,
    officialPositionIds: [...V2_POSITION_IDS],
    enabledPositions,
    staleConfiguredOnlyPositions,
    retainedConfiguredOnlyOfficialPositions,
    nonV2EnabledPositions,
    removalStepCount: steps.length,
    readyStepCount: steps.filter((step) => step.ready).length,
    blockedStepCount: steps.filter((step) => !step.ready).length,
    readyForControlledApply,
    blockedReasons,
    steps: steps.slice(0, limit),
    constraintsVerified: constraints(),
  };
}
