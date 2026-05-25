import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig, type OpenClawConfig, type MemorySearchConfig } from "../config/config.js";
import {
  buildKnowledgeIndexFromWorkspace,
  KB_INDEX_FILE_RELATIVE_PATH,
  writeKnowledgeIndexSnapshot,
} from "../runtime/kb-index-refresh.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const KB_STATE_ROUTE = "/api/kb/state";
const KB_REFRESH_ROUTE = "/api/kb/refresh";
const KB_SEMANTIC_REBUILD_PLAN_ROUTE = "/api/kb/semantic-rebuild-plan";
const KB_SEMANTIC_REBUILD_PLAN_STATE_ROUTE = "/api/kb/semantic-rebuild-plan/state";
const KB_SEMANTIC_REBUILD_PLAN_ACCEPTANCE_ROUTE = "/api/kb/semantic-rebuild-plan/acceptance";
const KB_SEMANTIC_REBUILD_ACCEPTANCE_RECORDS_ROUTE =
  "/api/kb/semantic-rebuild-plan/acceptance-records";
const KB_SEMANTIC_REBUILD_PREFLIGHT_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-preflight";
const KB_SEMANTIC_REBUILD_DRY_RUN_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-dry-run";
const KB_SEMANTIC_REBUILD_APPROVAL_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-approval";
const SEMANTIC_REBUILD_PLAN_REPORT_DIR = "runtime/main/tmp";
const SEMANTIC_REBUILD_PLAN_REPORT_PREFIX = "kb-semantic-rebuild-plan-";
const SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX = ".json";
const SEMANTIC_REBUILD_ACCEPTANCE_PREFIX = "kb-semantic-rebuild-acceptance-";
const SEMANTIC_REBUILD_APPROVAL_PREFIX = "kb-semantic-rebuild-approval-";

type KnowledgeIndexSummary = {
  generatedAt: string | null;
  totalItems: number;
  sourceCaseCount: number;
  sourceSkillCount: number;
  keywordCount: number;
};

type KnowledgeSemanticState = {
  status: "default" | "configured" | "disabled" | "config_error";
  mode: "observe-only";
  source: "agents.memorySearch";
  rebuild: "disabled";
  reason: "semantic_vector_refresh_deferred";
  provider: string | null;
  model: string | null;
  vectorEnabled: boolean | null;
  hybridEnabled: boolean | null;
  configuredScopes: string[];
  error?: string;
};

type KbHttpOptions = {
  config?: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
};

type KnowledgeSemanticRebuildPlan = {
  status: "ready" | "blocked";
  mode: "dry-run";
  dryRun: true;
  action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE";
  generatedAt: string;
  semantic: KnowledgeSemanticState;
  source: {
    totalItems: number;
    sourceCaseCount: number;
    sourceSkillCount: number;
    keywordCount: number;
    warnings: string[];
  };
  plannedBatches: number;
  plannedOutputs: string[];
  plannedSteps: string[];
  blockedReasons: string[];
  constraintsVerified: {
    embeddingCalls: "no";
    fileWrites: "no" | "dry-run-report-only";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    applied: "no";
    dryRunReportWritten?: "yes";
  };
  reportPath?: string;
  outputFile?: string;
};

type SemanticRebuildProposalAcceptanceBlockReason =
  | "proposal_missing"
  | "proposal_invalid_json"
  | "proposal_not_ready"
  | "proposal_constraints_invalid"
  | "blocked_reasons_present"
  | "semantic_boundary_drift"
  | "source_summary_drift"
  | "planned_batches_drift";

type SemanticRebuildProposalAcceptance = {
  mode: "acceptance-stub";
  checkedAt: string;
  proposalPath: string | null;
  status: "ready_for_human_gate" | "blocked" | "missing" | "invalid";
  readyForHumanGate: boolean;
  blockReasons: SemanticRebuildProposalAcceptanceBlockReason[];
  proposalSummary: {
    proposalId: string;
    status: KnowledgeSemanticRebuildPlan["status"];
    generatedAt: string;
    provider: string | null;
    model: string | null;
    totalItems: number;
    plannedBatches: number;
    blockedReasons: string[];
  } | null;
  currentSummary: {
    status: KnowledgeSemanticRebuildPlan["status"];
    provider: string | null;
    model: string | null;
    totalItems: number;
    plannedBatches: number;
    blockedReasons: string[];
  } | null;
  constraintsVerified: {
    acceptanceRecordWritten: "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildAcceptanceRecordDryRun = {
  mode: "acceptance-record-dry-run";
  checkedAt: string;
  proposalPath: string | null;
  wouldWrite: false;
  wouldWritePath: string | null;
  acceptance: SemanticRebuildProposalAcceptance;
  recordPreview: {
    acceptanceId: string;
    createdAt: string;
    status: "human_gate_ready";
    proposalId: string;
    proposalPath: string;
    plannedBatches: number;
    totalItems: number;
    requiredApproval: "human";
    nextAction: "await_human_approval";
    approved: false;
    rebuildTriggered: false;
  } | null;
  constraintsVerified: {
    recordWritten: "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildAcceptanceRecord = {
  mode: "acceptance-record";
  acceptanceId: string;
  createdAt: string;
  status: "human_gate_ready";
  proposalId: string;
  proposalPath: string;
  plannedBatches: number;
  totalItems: number;
  requiredApproval: "human";
  nextAction: "await_human_approval";
  approved: false;
  rebuildTriggered: false;
  acceptance: SemanticRebuildProposalAcceptance;
  constraintsVerified: {
    recordWritten: "yes";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildAcceptanceRecordWrite = {
  mode: "acceptance-record-write";
  checkedAt: string;
  proposalPath: string | null;
  wrote: boolean;
  recordPath: string | null;
  acceptance: SemanticRebuildProposalAcceptance;
  record: SemanticRebuildAcceptanceRecord | null;
  constraintsVerified: {
    recordWritten: "yes" | "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildAcceptanceRecordSummary = {
  recordPath: string;
  acceptanceId: string;
  createdAt: string;
  status: "human_gate_ready";
  proposalId: string;
  proposalPath: string;
  plannedBatches: number;
  totalItems: number;
  requiredApproval: "human";
  nextAction: "await_human_approval";
  approved: false;
  rebuildTriggered: false;
  constraintsVerified: SemanticRebuildAcceptanceRecord["constraintsVerified"];
};

type SemanticRebuildAcceptanceRecordList = {
  available: boolean;
  mode: "acceptance-record-list";
  reportDir: string;
  reportPrefix: string;
  totalRecords: number;
  returnedRecords: number;
  invalidRecords: number;
  records: SemanticRebuildAcceptanceRecordSummary[];
  constraintsVerified: {
    fileWrites: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildPreflightBlockReason =
  | SemanticRebuildProposalAcceptanceBlockReason
  | "acceptance_record_missing"
  | "acceptance_record_invalid"
  | "acceptance_record_not_human_gate_ready"
  | "acceptance_constraints_invalid"
  | "record_proposal_mismatch"
  | "record_summary_mismatch";

type SemanticRebuildPreflight = {
  available: boolean;
  mode: "semantic-rebuild-preflight";
  checkedAt: string;
  status: "ready_for_rebuild_human_approval" | "blocked";
  readyForRebuildHumanApproval: boolean;
  blockReasons: SemanticRebuildPreflightBlockReason[];
  recordPath: string | null;
  acceptanceRecord: SemanticRebuildAcceptanceRecordSummary | null;
  acceptance: SemanticRebuildProposalAcceptance;
  constraintsVerified: {
    fileWrites: "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildExecutionDryRun = {
  available: boolean;
  mode: "semantic-rebuild-execution-dry-run";
  checkedAt: string;
  status: "ready_for_execution_human_gate" | "blocked";
  wouldExecute: false;
  readyForExecutionHumanGate: boolean;
  blockReasons: SemanticRebuildPreflightBlockReason[];
  preflight: SemanticRebuildPreflight;
  plannedExecution: {
    acceptanceId: string;
    proposalId: string;
    proposalPath: string;
    recordPath: string;
    provider: string | null;
    model: string | null;
    totalItems: number;
    plannedBatches: number;
    plannedOutputs: string[];
    plannedSteps: string[];
    requiredApproval: "human";
    nextAction: "await_human_rebuild_approval";
    wouldCallEmbeddingProvider: false;
    wouldWriteSemanticIndex: false;
    wouldWriteVectorIndex: false;
  } | null;
  constraintsVerified: {
    fileWrites: "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildApprovalRecordDryRun = {
  mode: "rebuild-approval-record-dry-run";
  checkedAt: string;
  wouldWrite: false;
  wouldWritePath: string | null;
  dryRun: SemanticRebuildExecutionDryRun;
  recordPreview: {
    approvalId: string;
    createdAt: string;
    status: "rebuild_human_approved";
    acceptanceId: string;
    proposalId: string;
    proposalPath: string;
    acceptanceRecordPath: string;
    plannedBatches: number;
    totalItems: number;
    requiredApproval: "human";
    nextAction: "await_rebuild_execution";
    approved: true;
    rebuildTriggered: false;
  } | null;
  constraintsVerified: {
    approvalRecordWritten: "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildApprovalRecord = {
  mode: "rebuild-approval-record";
  approvalId: string;
  createdAt: string;
  status: "rebuild_human_approved";
  acceptanceId: string;
  proposalId: string;
  proposalPath: string;
  acceptanceRecordPath: string;
  plannedBatches: number;
  totalItems: number;
  requiredApproval: "human";
  nextAction: "await_rebuild_execution";
  approved: true;
  rebuildTriggered: false;
  dryRun: SemanticRebuildExecutionDryRun;
  constraintsVerified: {
    approvalRecordWritten: "yes";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildApprovalRecordWrite = {
  mode: "rebuild-approval-record-write";
  checkedAt: string;
  wrote: boolean;
  recordPath: string | null;
  dryRun: SemanticRebuildExecutionDryRun;
  record: SemanticRebuildApprovalRecord | null;
  constraintsVerified: {
    approvalRecordWritten: "yes" | "no";
    stateWritten: "no";
    embeddingCalls: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function summarizeIndex(value: unknown): KnowledgeIndexSummary {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const keywords =
    record.keywords && typeof record.keywords === "object" && !Array.isArray(record.keywords)
      ? (record.keywords as Record<string, unknown>)
      : {};
  return {
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : null,
    totalItems: typeof record.totalItems === "number" ? record.totalItems : 0,
    sourceCaseCount: typeof record.sourceCaseCount === "number" ? record.sourceCaseCount : 0,
    sourceSkillCount: typeof record.sourceSkillCount === "number" ? record.sourceSkillCount : 0,
    keywordCount: Object.keys(keywords).length,
  };
}

function hasMemorySearchConfig(value: MemorySearchConfig | undefined): value is MemorySearchConfig {
  return Boolean(value);
}

function firstString(values: Array<string | undefined>): string | null {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function firstBoolean(
  values: Array<boolean | undefined>,
  fallback: boolean | null,
): boolean | null {
  return values.find((value) => typeof value === "boolean") ?? fallback;
}

export function summarizeSemanticBoundary(config: OpenClawConfig): KnowledgeSemanticState {
  const defaults = config.agents?.defaults?.memorySearch;
  const scoped = [
    ...(hasMemorySearchConfig(defaults)
      ? [
          {
            scope: "agents.defaults",
            config: defaults,
            effectiveEnabled: defaults.enabled ?? true,
            provider: defaults.provider,
            model: defaults.model,
            vectorEnabled: defaults.store?.vector?.enabled,
            hybridEnabled: defaults.query?.hybrid?.enabled,
          },
        ]
      : []),
    ...(config.agents?.list ?? [])
      .filter((agent) => hasMemorySearchConfig(agent.memorySearch))
      .map((agent) => ({
        scope: `agents.list.${agent.id}`,
        config: agent.memorySearch as MemorySearchConfig,
        effectiveEnabled: agent.memorySearch?.enabled ?? defaults?.enabled ?? true,
        provider: agent.memorySearch?.provider ?? defaults?.provider,
        model: agent.memorySearch?.model ?? defaults?.model,
        vectorEnabled:
          agent.memorySearch?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled,
        hybridEnabled:
          agent.memorySearch?.query?.hybrid?.enabled ?? defaults?.query?.hybrid?.enabled,
      })),
  ];
  const hasConfiguredScope = scoped.length > 0;
  const hasEnabledScope = !hasConfiguredScope || scoped.some((entry) => entry.effectiveEnabled);
  const status = hasConfiguredScope ? (hasEnabledScope ? "configured" : "disabled") : "default";
  return {
    status,
    mode: "observe-only",
    source: "agents.memorySearch",
    rebuild: "disabled",
    reason: "semantic_vector_refresh_deferred",
    provider:
      status === "disabled" ? null : (firstString(scoped.map((entry) => entry.provider)) ?? "auto"),
    model: status === "disabled" ? null : firstString(scoped.map((entry) => entry.model)),
    vectorEnabled:
      status === "disabled"
        ? false
        : firstBoolean(
            scoped.map((entry) => entry.vectorEnabled),
            true,
          ),
    hybridEnabled:
      status === "disabled"
        ? false
        : firstBoolean(
            scoped.map((entry) => entry.hybridEnabled),
            true,
          ),
    configuredScopes: scoped.map((entry) => entry.scope),
  };
}

function resolveSemanticBoundary(options?: KbHttpOptions): KnowledgeSemanticState {
  try {
    return summarizeSemanticBoundary(options?.config ?? (options?.loadConfig ?? loadConfig)());
  } catch (error) {
    return {
      status: "config_error",
      mode: "observe-only",
      source: "agents.memorySearch",
      rebuild: "disabled",
      reason: "semantic_vector_refresh_deferred",
      provider: null,
      model: null,
      vectorEnabled: null,
      hybridEnabled: null,
      configuredScopes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildSemanticRebuildPlan(
  workspaceRoot: string,
  semantic: KnowledgeSemanticState,
  generatedAt = new Date().toISOString(),
): KnowledgeSemanticRebuildPlan {
  const { index, sources } = buildKnowledgeIndexFromWorkspace(workspaceRoot, generatedAt);
  const blockedReasons = [
    ...(semantic.status === "disabled" ? ["semantic memorySearch is disabled"] : []),
    ...(semantic.status === "config_error"
      ? ["semantic memorySearch config could not be resolved"]
      : []),
    ...(semantic.vectorEnabled === false ? ["vector store is disabled"] : []),
    ...(index.totalItems === 0 ? ["no KB items available for semantic rebuild"] : []),
  ];
  return {
    status: blockedReasons.length > 0 ? "blocked" : "ready",
    mode: "dry-run",
    dryRun: true,
    action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE",
    generatedAt,
    semantic,
    source: {
      totalItems: index.totalItems,
      sourceCaseCount: index.sourceCaseCount,
      sourceSkillCount: index.sourceSkillCount,
      keywordCount: Object.keys(index.keywords).length,
      warnings: sources.warnings,
    },
    plannedBatches: index.totalItems === 0 ? 0 : Math.ceil(index.totalItems / 100),
    plannedOutputs: [
      "system/kb-index/semantic-index.json",
      "system/kb-index/vector-index.sqlite",
      "system/kb-index/semantic-rebuild-report.json",
    ],
    plannedSteps: [
      "read case-library and skill-library sources",
      "normalize KB items using keyword index schema",
      "plan embedding batches",
      "plan semantic index and vector index output paths",
      "stop before embedding calls or file writes",
    ],
    blockedReasons,
    constraintsVerified: {
      embeddingCalls: "no",
      fileWrites: "no",
      keywordIndexWritten: "no",
      vectorIndexWritten: "no",
      applied: "no",
    },
  };
}

function toReportTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z-]/g, "-");
}

function buildSemanticRebuildPlanReportPath(generatedAt: string): string {
  return [
    SEMANTIC_REBUILD_PLAN_REPORT_DIR,
    `${SEMANTIC_REBUILD_PLAN_REPORT_PREFIX}${toReportTimestamp(generatedAt)}${SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX}`,
  ].join("/");
}

async function writeSemanticRebuildPlanReport(
  workspaceRoot: string,
  plan: KnowledgeSemanticRebuildPlan,
): Promise<KnowledgeSemanticRebuildPlan> {
  const reportPath = buildSemanticRebuildPlanReportPath(plan.generatedAt);
  const outputFile = path.join(workspaceRoot, ...reportPath.split("/"));
  const persisted: KnowledgeSemanticRebuildPlan = {
    ...plan,
    reportPath,
    outputFile,
    constraintsVerified: {
      ...plan.constraintsVerified,
      fileWrites: "dry-run-report-only",
      dryRunReportWritten: "yes",
    },
  };
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return persisted;
}

async function readLatestSemanticRebuildPlanReport(
  workspaceRoot: string,
): Promise<KnowledgeSemanticRebuildPlan | null> {
  const latest = await readLatestSemanticRebuildPlanReportEntry(workspaceRoot);
  return latest?.plan ?? null;
}

async function readLatestSemanticRebuildPlanReportEntry(
  workspaceRoot: string,
): Promise<{ reportPath: string; plan: KnowledgeSemanticRebuildPlan } | null> {
  const reportDir = path.join(workspaceRoot, ...SEMANTIC_REBUILD_PLAN_REPORT_DIR.split("/"));
  let entries: string[];
  try {
    entries = await readdir(reportDir);
  } catch {
    return null;
  }
  const latest = entries
    .filter(
      (entry) =>
        entry.startsWith(SEMANTIC_REBUILD_PLAN_REPORT_PREFIX) &&
        entry.endsWith(SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX),
    )
    .sort()
    .at(-1);
  if (!latest) {
    return null;
  }
  const reportPath = [SEMANTIC_REBUILD_PLAN_REPORT_DIR, latest].join("/");
  return {
    reportPath,
    plan: JSON.parse(
      await readFile(path.join(reportDir, latest), "utf8"),
    ) as KnowledgeSemanticRebuildPlan,
  };
}

function proposalIdForSemanticRebuildPlan(plan: KnowledgeSemanticRebuildPlan): string {
  return `kb-semantic-rebuild-${toReportTimestamp(plan.generatedAt)}`;
}

function semanticSummaryForAcceptance(plan: KnowledgeSemanticRebuildPlan) {
  return {
    status: plan.status,
    provider: plan.semantic.provider,
    model: plan.semantic.model,
    totalItems: plan.source.totalItems,
    plannedBatches: plan.plannedBatches,
    blockedReasons: plan.blockedReasons,
  };
}

function semanticPlanConstraintsValid(plan: KnowledgeSemanticRebuildPlan): boolean {
  return (
    plan.mode === "dry-run" &&
    plan.dryRun === true &&
    plan.action === "PLAN_ONLY_NO_EMBEDDING_NO_WRITE" &&
    plan.constraintsVerified.embeddingCalls === "no" &&
    plan.constraintsVerified.keywordIndexWritten === "no" &&
    plan.constraintsVerified.vectorIndexWritten === "no" &&
    plan.constraintsVerified.applied === "no" &&
    plan.constraintsVerified.fileWrites === "dry-run-report-only" &&
    plan.constraintsVerified.dryRunReportWritten === "yes"
  );
}

function isSemanticRebuildAcceptanceRecord(
  value: unknown,
): value is SemanticRebuildAcceptanceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const constraints = record.constraintsVerified;
  return (
    record.mode === "acceptance-record" &&
    typeof record.acceptanceId === "string" &&
    typeof record.createdAt === "string" &&
    record.status === "human_gate_ready" &&
    typeof record.proposalId === "string" &&
    typeof record.proposalPath === "string" &&
    typeof record.plannedBatches === "number" &&
    typeof record.totalItems === "number" &&
    record.requiredApproval === "human" &&
    record.nextAction === "await_human_approval" &&
    record.approved === false &&
    record.rebuildTriggered === false &&
    Boolean(constraints) &&
    typeof constraints === "object" &&
    !Array.isArray(constraints) &&
    (constraints as Record<string, unknown>).recordWritten === "yes" &&
    (constraints as Record<string, unknown>).embeddingCalls === "no" &&
    (constraints as Record<string, unknown>).vectorIndexWritten === "no" &&
    (constraints as Record<string, unknown>).realRebuildTriggered === "no" &&
    (constraints as Record<string, unknown>).applied === "no"
  );
}

function summarizeAcceptanceRecord(
  recordPath: string,
  record: SemanticRebuildAcceptanceRecord,
): SemanticRebuildAcceptanceRecordSummary {
  return {
    recordPath,
    acceptanceId: record.acceptanceId,
    createdAt: record.createdAt,
    status: record.status,
    proposalId: record.proposalId,
    proposalPath: record.proposalPath,
    plannedBatches: record.plannedBatches,
    totalItems: record.totalItems,
    requiredApproval: record.requiredApproval,
    nextAction: record.nextAction,
    approved: record.approved,
    rebuildTriggered: record.rebuildTriggered,
    constraintsVerified: record.constraintsVerified,
  };
}

async function readLatestSemanticRebuildAcceptanceRecordEntry(
  workspaceRoot: string,
): Promise<{ recordPath: string; record: SemanticRebuildAcceptanceRecord | null } | null> {
  const reportDir = path.join(workspaceRoot, ...SEMANTIC_REBUILD_PLAN_REPORT_DIR.split("/"));
  let entries: string[];
  try {
    entries = await readdir(reportDir);
  } catch {
    return null;
  }
  const latest = entries
    .filter(
      (entry) =>
        entry.startsWith(SEMANTIC_REBUILD_ACCEPTANCE_PREFIX) &&
        entry.endsWith(SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX),
    )
    .sort()
    .at(-1);
  if (!latest) {
    return null;
  }

  const recordPath = [SEMANTIC_REBUILD_PLAN_REPORT_DIR, latest].join("/");
  try {
    const parsed = JSON.parse(await readFile(path.join(reportDir, latest), "utf8")) as unknown;
    return {
      recordPath,
      record: isSemanticRebuildAcceptanceRecord(parsed) ? parsed : null,
    };
  } catch {
    return { recordPath, record: null };
  }
}

function sameSemanticBoundary(
  left: KnowledgeSemanticRebuildPlan,
  right: KnowledgeSemanticRebuildPlan,
): boolean {
  return (
    left.semantic.status === right.semantic.status &&
    left.semantic.provider === right.semantic.provider &&
    left.semantic.model === right.semantic.model &&
    left.semantic.vectorEnabled === right.semantic.vectorEnabled &&
    left.semantic.hybridEnabled === right.semantic.hybridEnabled &&
    JSON.stringify(left.semantic.configuredScopes) ===
      JSON.stringify(right.semantic.configuredScopes)
  );
}

function sameSourceSummary(
  left: KnowledgeSemanticRebuildPlan,
  right: KnowledgeSemanticRebuildPlan,
): boolean {
  return (
    left.source.totalItems === right.source.totalItems &&
    left.source.sourceCaseCount === right.source.sourceCaseCount &&
    left.source.sourceSkillCount === right.source.sourceSkillCount &&
    left.source.keywordCount === right.source.keywordCount &&
    JSON.stringify(left.source.warnings) === JSON.stringify(right.source.warnings)
  );
}

function acceptanceConstraints() {
  return {
    acceptanceRecordWritten: "no" as const,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

function preflightConstraints() {
  return {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

function approvalRecordConstraints<T extends "yes" | "no">(recordWritten: T) {
  return {
    approvalRecordWritten: recordWritten,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

function acceptanceRecordConstraintsValid(record: SemanticRebuildAcceptanceRecord): boolean {
  return (
    record.status === "human_gate_ready" &&
    record.requiredApproval === "human" &&
    record.nextAction === "await_human_approval" &&
    record.approved === false &&
    record.rebuildTriggered === false &&
    record.constraintsVerified.recordWritten === "yes" &&
    record.constraintsVerified.stateWritten === "no" &&
    record.constraintsVerified.embeddingCalls === "no" &&
    record.constraintsVerified.keywordIndexWritten === "no" &&
    record.constraintsVerified.vectorIndexWritten === "no" &&
    record.constraintsVerified.realRebuildTriggered === "no" &&
    record.constraintsVerified.applied === "no"
  );
}

export async function checkSemanticRebuildProposalAcceptance(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildProposalAcceptance> {
  const checkedAt = new Date().toISOString();
  const latest = await readLatestSemanticRebuildPlanReportEntry(workspaceRoot);
  const base = {
    mode: "acceptance-stub" as const,
    checkedAt,
    proposalPath: latest?.reportPath ?? null,
    constraintsVerified: acceptanceConstraints(),
  };
  if (!latest) {
    return {
      ...base,
      status: "missing",
      readyForHumanGate: false,
      blockReasons: ["proposal_missing"],
      proposalSummary: null,
      currentSummary: null,
    };
  }

  const proposal = latest.plan;
  if (
    !proposal ||
    proposal.mode !== "dry-run" ||
    proposal.dryRun !== true ||
    !proposal.semantic ||
    !proposal.source
  ) {
    return {
      ...base,
      status: "invalid",
      readyForHumanGate: false,
      blockReasons: ["proposal_invalid_json"],
      proposalSummary: null,
      currentSummary: null,
    };
  }

  const current = buildSemanticRebuildPlan(
    workspaceRoot,
    resolveSemanticBoundary(options),
    proposal.generatedAt,
  );
  const blockReasons: SemanticRebuildProposalAcceptanceBlockReason[] = [];
  if (proposal.status !== "ready") blockReasons.push("proposal_not_ready");
  if (!semanticPlanConstraintsValid(proposal)) blockReasons.push("proposal_constraints_invalid");
  if (proposal.blockedReasons.length > 0) blockReasons.push("blocked_reasons_present");
  if (!sameSemanticBoundary(proposal, current)) blockReasons.push("semantic_boundary_drift");
  if (!sameSourceSummary(proposal, current)) blockReasons.push("source_summary_drift");
  if (proposal.plannedBatches !== current.plannedBatches)
    blockReasons.push("planned_batches_drift");
  const readyForHumanGate = blockReasons.length === 0;

  return {
    ...base,
    status: readyForHumanGate ? "ready_for_human_gate" : "blocked",
    readyForHumanGate,
    blockReasons,
    proposalSummary: {
      proposalId: proposalIdForSemanticRebuildPlan(proposal),
      generatedAt: proposal.generatedAt,
      ...semanticSummaryForAcceptance(proposal),
    },
    currentSummary: semanticSummaryForAcceptance(current),
  };
}

export async function buildSemanticRebuildAcceptanceRecordDryRun(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildAcceptanceRecordDryRun> {
  const checkedAt = new Date().toISOString();
  const acceptance = await checkSemanticRebuildProposalAcceptance(workspaceRoot, options);
  const acceptanceId = `kb-semantic-rebuild-acceptance-${randomUUID()}`;
  const wouldWritePath = acceptance.readyForHumanGate
    ? [
        SEMANTIC_REBUILD_PLAN_REPORT_DIR,
        `${SEMANTIC_REBUILD_ACCEPTANCE_PREFIX}${toReportTimestamp(checkedAt)}.json`,
      ].join("/")
    : null;
  const recordPreview =
    acceptance.readyForHumanGate && acceptance.proposalPath && acceptance.proposalSummary
      ? {
          acceptanceId,
          createdAt: checkedAt,
          status: "human_gate_ready" as const,
          proposalId: acceptance.proposalSummary.proposalId,
          proposalPath: acceptance.proposalPath,
          plannedBatches: acceptance.proposalSummary.plannedBatches,
          totalItems: acceptance.proposalSummary.totalItems,
          requiredApproval: "human" as const,
          nextAction: "await_human_approval" as const,
          approved: false as const,
          rebuildTriggered: false as const,
        }
      : null;
  return {
    mode: "acceptance-record-dry-run",
    checkedAt,
    proposalPath: acceptance.proposalPath,
    wouldWrite: false,
    wouldWritePath,
    acceptance,
    recordPreview,
    constraintsVerified: {
      recordWritten: "no",
      stateWritten: "no",
      embeddingCalls: "no",
      keywordIndexWritten: "no",
      vectorIndexWritten: "no",
      realRebuildTriggered: "no",
      applied: "no",
    },
  };
}

export async function writeSemanticRebuildAcceptanceRecord(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildAcceptanceRecordWrite> {
  const checkedAt = new Date().toISOString();
  const acceptance = await checkSemanticRebuildProposalAcceptance(workspaceRoot, options);
  const blockedConstraints = {
    recordWritten: "no" as const,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
  if (!acceptance.readyForHumanGate || !acceptance.proposalPath || !acceptance.proposalSummary) {
    return {
      mode: "acceptance-record-write",
      checkedAt,
      proposalPath: acceptance.proposalPath,
      wrote: false,
      recordPath: null,
      acceptance,
      record: null,
      constraintsVerified: blockedConstraints,
    };
  }

  const acceptanceId = `kb-semantic-rebuild-acceptance-${randomUUID()}`;
  const recordPath = [
    SEMANTIC_REBUILD_PLAN_REPORT_DIR,
    `${SEMANTIC_REBUILD_ACCEPTANCE_PREFIX}${toReportTimestamp(checkedAt)}.json`,
  ].join("/");
  const outputFile = path.join(workspaceRoot, ...recordPath.split("/"));
  const writtenConstraints = {
    recordWritten: "yes" as const,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
  const record: SemanticRebuildAcceptanceRecord = {
    mode: "acceptance-record",
    acceptanceId,
    createdAt: checkedAt,
    status: "human_gate_ready",
    proposalId: acceptance.proposalSummary.proposalId,
    proposalPath: acceptance.proposalPath,
    plannedBatches: acceptance.proposalSummary.plannedBatches,
    totalItems: acceptance.proposalSummary.totalItems,
    requiredApproval: "human",
    nextAction: "await_human_approval",
    approved: false,
    rebuildTriggered: false,
    acceptance,
    constraintsVerified: writtenConstraints,
  };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    mode: "acceptance-record-write",
    checkedAt,
    proposalPath: acceptance.proposalPath,
    wrote: true,
    recordPath,
    acceptance,
    record,
    constraintsVerified: writtenConstraints,
  };
}

export async function listSemanticRebuildAcceptanceRecords(
  workspaceRoot: string,
): Promise<SemanticRebuildAcceptanceRecordList> {
  const reportDir = path.join(workspaceRoot, ...SEMANTIC_REBUILD_PLAN_REPORT_DIR.split("/"));
  const constraintsVerified = {
    fileWrites: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
  let entries: string[];
  try {
    entries = await readdir(reportDir);
  } catch {
    return {
      available: false,
      mode: "acceptance-record-list",
      reportDir: SEMANTIC_REBUILD_PLAN_REPORT_DIR,
      reportPrefix: SEMANTIC_REBUILD_ACCEPTANCE_PREFIX,
      totalRecords: 0,
      returnedRecords: 0,
      invalidRecords: 0,
      records: [],
      constraintsVerified,
    };
  }

  const recordFiles = entries
    .filter(
      (entry) =>
        entry.startsWith(SEMANTIC_REBUILD_ACCEPTANCE_PREFIX) &&
        entry.endsWith(SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX),
    )
    .sort()
    .reverse();
  const records: SemanticRebuildAcceptanceRecordSummary[] = [];
  let invalidRecords = 0;
  for (const entry of recordFiles.slice(0, 20)) {
    const recordPath = [SEMANTIC_REBUILD_PLAN_REPORT_DIR, entry].join("/");
    try {
      const parsed = JSON.parse(await readFile(path.join(reportDir, entry), "utf8")) as unknown;
      if (!isSemanticRebuildAcceptanceRecord(parsed)) {
        invalidRecords += 1;
        continue;
      }
      records.push(summarizeAcceptanceRecord(recordPath, parsed));
    } catch {
      invalidRecords += 1;
    }
  }

  return {
    available: records.length > 0,
    mode: "acceptance-record-list",
    reportDir: SEMANTIC_REBUILD_PLAN_REPORT_DIR,
    reportPrefix: SEMANTIC_REBUILD_ACCEPTANCE_PREFIX,
    totalRecords: recordFiles.length,
    returnedRecords: records.length,
    invalidRecords,
    records,
    constraintsVerified,
  };
}

export async function checkSemanticRebuildPreflight(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildPreflight> {
  const checkedAt = new Date().toISOString();
  const acceptance = await checkSemanticRebuildProposalAcceptance(workspaceRoot, options);
  const latest = await readLatestSemanticRebuildAcceptanceRecordEntry(workspaceRoot);
  const blockReasons: SemanticRebuildPreflightBlockReason[] = [];
  let acceptanceRecord: SemanticRebuildAcceptanceRecordSummary | null = null;

  if (!latest) {
    blockReasons.push("acceptance_record_missing");
  } else if (!latest.record) {
    blockReasons.push("acceptance_record_invalid");
  } else {
    acceptanceRecord = summarizeAcceptanceRecord(latest.recordPath, latest.record);
    if (latest.record.status !== "human_gate_ready") {
      blockReasons.push("acceptance_record_not_human_gate_ready");
    }
    if (!acceptanceRecordConstraintsValid(latest.record)) {
      blockReasons.push("acceptance_constraints_invalid");
    }
    if (
      acceptance.proposalPath &&
      acceptance.proposalSummary &&
      (latest.record.proposalPath !== acceptance.proposalPath ||
        latest.record.proposalId !== acceptance.proposalSummary.proposalId)
    ) {
      blockReasons.push("record_proposal_mismatch");
    }
    if (
      acceptance.proposalSummary &&
      (latest.record.plannedBatches !== acceptance.proposalSummary.plannedBatches ||
        latest.record.totalItems !== acceptance.proposalSummary.totalItems)
    ) {
      blockReasons.push("record_summary_mismatch");
    }
  }

  if (!acceptance.readyForHumanGate) {
    blockReasons.push(...acceptance.blockReasons);
  }

  const uniqueBlockReasons = [...new Set(blockReasons)];
  const readyForRebuildHumanApproval = uniqueBlockReasons.length === 0;
  return {
    available: acceptanceRecord !== null,
    mode: "semantic-rebuild-preflight",
    checkedAt,
    status: readyForRebuildHumanApproval ? "ready_for_rebuild_human_approval" : "blocked",
    readyForRebuildHumanApproval,
    blockReasons: uniqueBlockReasons,
    recordPath: latest?.recordPath ?? null,
    acceptanceRecord,
    acceptance,
    constraintsVerified: preflightConstraints(),
  };
}

export async function buildSemanticRebuildExecutionDryRun(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildExecutionDryRun> {
  const checkedAt = new Date().toISOString();
  const preflight = await checkSemanticRebuildPreflight(workspaceRoot, options);
  const latestPlan = await readLatestSemanticRebuildPlanReportEntry(workspaceRoot);
  const readyForExecutionHumanGate =
    preflight.readyForRebuildHumanApproval &&
    preflight.acceptanceRecord !== null &&
    latestPlan?.reportPath === preflight.acceptanceRecord.proposalPath;

  return {
    available: preflight.available,
    mode: "semantic-rebuild-execution-dry-run",
    checkedAt,
    status: readyForExecutionHumanGate ? "ready_for_execution_human_gate" : "blocked",
    wouldExecute: false,
    readyForExecutionHumanGate,
    blockReasons: preflight.blockReasons,
    preflight,
    plannedExecution:
      readyForExecutionHumanGate && preflight.acceptanceRecord && latestPlan
        ? {
            acceptanceId: preflight.acceptanceRecord.acceptanceId,
            proposalId: preflight.acceptanceRecord.proposalId,
            proposalPath: preflight.acceptanceRecord.proposalPath,
            recordPath: preflight.acceptanceRecord.recordPath,
            provider: latestPlan.plan.semantic.provider,
            model: latestPlan.plan.semantic.model,
            totalItems: preflight.acceptanceRecord.totalItems,
            plannedBatches: preflight.acceptanceRecord.plannedBatches,
            plannedOutputs: latestPlan.plan.plannedOutputs,
            plannedSteps: [
              ...latestPlan.plan.plannedSteps.filter(
                (step) => step !== "stop before embedding calls or file writes",
              ),
              "stop before real rebuild until explicit human approval",
            ],
            requiredApproval: "human",
            nextAction: "await_human_rebuild_approval",
            wouldCallEmbeddingProvider: false,
            wouldWriteSemanticIndex: false,
            wouldWriteVectorIndex: false,
          }
        : null,
    constraintsVerified: preflightConstraints(),
  };
}

export async function buildSemanticRebuildApprovalRecordDryRun(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildApprovalRecordDryRun> {
  const checkedAt = new Date().toISOString();
  const dryRun = await buildSemanticRebuildExecutionDryRun(workspaceRoot, options);
  const approvalId = `kb-semantic-rebuild-approval-${randomUUID()}`;
  const plannedExecution = dryRun.plannedExecution;
  const wouldWritePath =
    dryRun.readyForExecutionHumanGate && plannedExecution
      ? [
          SEMANTIC_REBUILD_PLAN_REPORT_DIR,
          `${SEMANTIC_REBUILD_APPROVAL_PREFIX}${toReportTimestamp(checkedAt)}.json`,
        ].join("/")
      : null;

  return {
    mode: "rebuild-approval-record-dry-run",
    checkedAt,
    wouldWrite: false,
    wouldWritePath,
    dryRun,
    recordPreview:
      dryRun.readyForExecutionHumanGate && plannedExecution
        ? {
            approvalId,
            createdAt: checkedAt,
            status: "rebuild_human_approved",
            acceptanceId: plannedExecution.acceptanceId,
            proposalId: plannedExecution.proposalId,
            proposalPath: plannedExecution.proposalPath,
            acceptanceRecordPath: plannedExecution.recordPath,
            plannedBatches: plannedExecution.plannedBatches,
            totalItems: plannedExecution.totalItems,
            requiredApproval: "human",
            nextAction: "await_rebuild_execution",
            approved: true,
            rebuildTriggered: false,
          }
        : null,
    constraintsVerified: approvalRecordConstraints("no"),
  };
}

export async function writeSemanticRebuildApprovalRecord(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildApprovalRecordWrite> {
  const checkedAt = new Date().toISOString();
  const dryRun = await buildSemanticRebuildExecutionDryRun(workspaceRoot, options);
  const plannedExecution = dryRun.plannedExecution;
  if (!dryRun.readyForExecutionHumanGate || !plannedExecution) {
    return {
      mode: "rebuild-approval-record-write",
      checkedAt,
      wrote: false,
      recordPath: null,
      dryRun,
      record: null,
      constraintsVerified: approvalRecordConstraints("no"),
    };
  }

  const approvalId = `kb-semantic-rebuild-approval-${randomUUID()}`;
  const recordPath = [
    SEMANTIC_REBUILD_PLAN_REPORT_DIR,
    `${SEMANTIC_REBUILD_APPROVAL_PREFIX}${toReportTimestamp(checkedAt)}.json`,
  ].join("/");
  const record: SemanticRebuildApprovalRecord = {
    mode: "rebuild-approval-record",
    approvalId,
    createdAt: checkedAt,
    status: "rebuild_human_approved",
    acceptanceId: plannedExecution.acceptanceId,
    proposalId: plannedExecution.proposalId,
    proposalPath: plannedExecution.proposalPath,
    acceptanceRecordPath: plannedExecution.recordPath,
    plannedBatches: plannedExecution.plannedBatches,
    totalItems: plannedExecution.totalItems,
    requiredApproval: "human",
    nextAction: "await_rebuild_execution",
    approved: true,
    rebuildTriggered: false,
    dryRun,
    constraintsVerified: approvalRecordConstraints("yes"),
  };

  const outputFile = path.join(workspaceRoot, ...recordPath.split("/"));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    mode: "rebuild-approval-record-write",
    checkedAt,
    wrote: true,
    recordPath,
    dryRun,
    record,
    constraintsVerified: approvalRecordConstraints("yes"),
  };
}

export function isKbApiPath(pathname: string): boolean {
  return (
    pathname === KB_STATE_ROUTE ||
    pathname === KB_REFRESH_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_STATE_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_ACCEPTANCE_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_ACCEPTANCE_RECORDS_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PREFLIGHT_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_DRY_RUN_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_APPROVAL_ROUTE
  );
}

export async function handleKbHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isKbApiPath(requestPath)) {
    return false;
  }

  if (requestPath === KB_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const index = JSON.parse(
        await readFile(path.join(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH), "utf8"),
      ) as unknown;
      sendJson(res, 200, {
        available: true,
        indexPath: KB_INDEX_FILE_RELATIVE_PATH,
        semantic: resolveSemanticBoundary(options),
        ...summarizeIndex(index),
      });
    } catch {
      sendJson(res, 200, {
        available: false,
        indexPath: KB_INDEX_FILE_RELATIVE_PATH,
        semantic: resolveSemanticBoundary(options),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_PLAN_ROUTE) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    try {
      const semantic = resolveSemanticBoundary(options);
      sendJson(
        res,
        200,
        await writeSemanticRebuildPlanReport(
          workspaceRoot,
          buildSemanticRebuildPlan(workspaceRoot, semantic),
        ),
      );
    } catch (error) {
      sendJson(res, 500, {
        status: "blocked",
        mode: "dry-run",
        dryRun: true,
        action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE",
        error: `知识库语义重建计划生成失败：${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: {
          embeddingCalls: "no",
          fileWrites: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          applied: "no",
        },
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_PLAN_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const latest = await readLatestSemanticRebuildPlanReport(workspaceRoot);
      sendJson(
        res,
        200,
        latest
          ? { available: true, ...latest }
          : {
              available: false,
              mode: "dry-run",
              dryRun: true,
              reportDir: SEMANTIC_REBUILD_PLAN_REPORT_DIR,
              reportPrefix: SEMANTIC_REBUILD_PLAN_REPORT_PREFIX,
            },
      );
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "dry-run",
        dryRun: true,
        error: `鐭ヨ瘑搴撹涔夐噸寤鸿鍒掓姤鍛婅鍙栧け璐ワ細${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_PLAN_ACCEPTANCE_ROUTE) {
    if (req.method !== "GET" && req.method !== "POST") {
      sendMethodNotAllowed(res, "GET, POST");
      return true;
    }

    try {
      if (req.method === "POST") {
        const result = await writeSemanticRebuildAcceptanceRecord(workspaceRoot, options);
        sendJson(res, result.wrote ? 201 : 409, result);
        return true;
      }

      sendJson(res, 200, await buildSemanticRebuildAcceptanceRecordDryRun(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        mode: req.method === "POST" ? "acceptance-record-write" : "acceptance-record-dry-run",
        wrote: false,
        error: `KB semantic rebuild acceptance check failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: {
          recordWritten: "no",
          stateWritten: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_ACCEPTANCE_RECORDS_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await listSemanticRebuildAcceptanceRecords(workspaceRoot));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "acceptance-record-list",
        error: `KB semantic rebuild acceptance records read failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: {
          fileWrites: "no",
          embeddingCalls: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          realRebuildTriggered: "no",
          applied: "no",
        },
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_PREFLIGHT_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await checkSemanticRebuildPreflight(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "semantic-rebuild-preflight",
        status: "blocked",
        readyForRebuildHumanApproval: false,
        error: `KB semantic rebuild preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: preflightConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_DRY_RUN_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await buildSemanticRebuildExecutionDryRun(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "semantic-rebuild-execution-dry-run",
        status: "blocked",
        wouldExecute: false,
        readyForExecutionHumanGate: false,
        error: `KB semantic rebuild execution dry-run failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: preflightConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_APPROVAL_ROUTE) {
    if (req.method !== "GET" && req.method !== "POST") {
      sendMethodNotAllowed(res, "GET, POST");
      return true;
    }

    try {
      if (req.method === "POST") {
        const result = await writeSemanticRebuildApprovalRecord(workspaceRoot, options);
        sendJson(res, result.wrote ? 201 : 409, result);
        return true;
      }

      sendJson(res, 200, await buildSemanticRebuildApprovalRecordDryRun(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        mode:
          req.method === "POST"
            ? "rebuild-approval-record-write"
            : "rebuild-approval-record-dry-run",
        wrote: false,
        error: `KB semantic rebuild approval check failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: approvalRecordConstraints("no"),
      });
    }
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const result = writeKnowledgeIndexSnapshot(workspaceRoot);
    sendJson(res, 200, {
      ...result,
      refreshMode: "runtime",
    });
  } catch (error) {
    sendJson(res, 500, {
      refreshed: false,
      error: `知识库索引刷新失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
