import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const V2_POSITION_IDS = [
  "main",
  "engineering-executive",
  "front-end-executive",
  "patrol",
] as const;

export interface PositionConfigAuditResult {
  mode: "observe-only";
  auditedAt: string;
  configPath: string;
  available: boolean;
  enabledPositions: string[];
  officialPositionIds: string[];
  nonV2EnabledPositions: string[];
  configuredOnlyPositions: string[];
  missingEnabledModelMappings: string[];
  missingEnabledOverrides: string[];
  positionModelMappingCount: number;
  positionOverrideCount: number;
  warnings: string[];
  constraintsVerified: {
    readOnly: "yes";
    positionConfigWritten: "no";
    agentsListMutated: "no";
    sessionsSent: "no";
    applied: "no";
  };
}

export interface PositionConfigAuditOptions {
  auditedAt?: string;
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

function constraints(): PositionConfigAuditResult["constraintsVerified"] {
  return {
    readOnly: "yes",
    positionConfigWritten: "no",
    agentsListMutated: "no",
    sessionsSent: "no",
    applied: "no",
  };
}

export function auditPositionConfig(
  workspaceRoot: string,
  options: PositionConfigAuditOptions = {},
): PositionConfigAuditResult {
  const auditedAt = options.auditedAt ?? new Date().toISOString();
  const configPath = ".claw/positions.json";
  const absolutePath = path.join(workspaceRoot, configPath);
  if (!existsSync(absolutePath)) {
    return {
      mode: "observe-only",
      auditedAt,
      configPath,
      available: false,
      enabledPositions: [],
      officialPositionIds: [...V2_POSITION_IDS],
      nonV2EnabledPositions: [],
      configuredOnlyPositions: [],
      missingEnabledModelMappings: [],
      missingEnabledOverrides: [],
      positionModelMappingCount: 0,
      positionOverrideCount: 0,
      warnings: ["positions_config_missing"],
      constraintsVerified: constraints(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    return {
      mode: "observe-only",
      auditedAt,
      configPath,
      available: false,
      enabledPositions: [],
      officialPositionIds: [...V2_POSITION_IDS],
      nonV2EnabledPositions: [],
      configuredOnlyPositions: [],
      missingEnabledModelMappings: [],
      missingEnabledOverrides: [],
      positionModelMappingCount: 0,
      positionOverrideCount: 0,
      warnings: [
        `positions_config_parse_failed:${error instanceof Error ? error.message : String(error)}`,
      ],
      constraintsVerified: constraints(),
    };
  }

  const config = isRecord(parsed) ? parsed : {};
  const enabledPositions = uniqueSorted(stringArray(config.enabledPositions));
  const enabledSet = new Set(enabledPositions);
  const officialSet = new Set<string>(V2_POSITION_IDS);
  const mappingKeys = recordKeys(config.positionModelMapping);
  const overrideKeys = recordKeys(config.positionOverrides);
  const configuredPositions = uniqueSorted([...mappingKeys, ...overrideKeys]);
  const configuredOnlyPositions = configuredPositions.filter(
    (positionId) => !enabledSet.has(positionId),
  );
  const missingEnabledModelMappings = enabledPositions.filter(
    (positionId) => !mappingKeys.includes(positionId),
  );
  const missingEnabledOverrides = enabledPositions.filter(
    (positionId) => !overrideKeys.includes(positionId),
  );
  const nonV2EnabledPositions = enabledPositions.filter(
    (positionId) => !officialSet.has(positionId),
  );
  const warnings = [
    ...(configuredOnlyPositions.length > 0 ? ["configured_only_positions_present"] : []),
    ...(missingEnabledModelMappings.length > 0 ? ["enabled_position_model_mapping_missing"] : []),
    ...(missingEnabledOverrides.length > 0 ? ["enabled_position_override_missing"] : []),
    ...(nonV2EnabledPositions.length > 0 ? ["non_v2_enabled_positions_present"] : []),
  ];

  return {
    mode: "observe-only",
    auditedAt,
    configPath,
    available: true,
    enabledPositions,
    officialPositionIds: [...V2_POSITION_IDS],
    nonV2EnabledPositions,
    configuredOnlyPositions,
    missingEnabledModelMappings,
    missingEnabledOverrides,
    positionModelMappingCount: mappingKeys.length,
    positionOverrideCount: overrideKeys.length,
    warnings,
    constraintsVerified: constraints(),
  };
}
