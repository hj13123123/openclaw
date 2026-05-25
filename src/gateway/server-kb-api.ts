import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadConfig, type OpenClawConfig, type MemorySearchConfig } from "../config/config.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createEmbeddingProvider } from "../plugin-sdk/memory-core-bundled-runtime.js";
import {
  buildKnowledgeIndexFromWorkspace,
  KB_INDEX_FILE_RELATIVE_PATH,
  writeKnowledgeIndexSnapshot,
} from "../runtime/kb-index-refresh.js";
import {
  searchKnowledgeIndex,
  type KnowledgeIndex,
  type KnowledgeIndexItem,
  type KnowledgeMatchResult,
} from "../runtime/kb-index.js";
import {
  buildRuntimeLoopPreflight,
  type RuntimeLoopPreflightDispatchPlanEntry,
} from "../runtime/runtime-loop.js";
import { getTaskState, type TaskRecord } from "../runtime/task-state-machine.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const KB_STATE_ROUTE = "/api/kb/state";
const KB_REFRESH_ROUTE = "/api/kb/refresh";
const KB_SEMANTIC_REBUILD_PLAN_ROUTE = "/api/kb/semantic-rebuild-plan";
const KB_SEMANTIC_REBUILD_PLAN_STATE_ROUTE = "/api/kb/semantic-rebuild-plan/state";
const KB_SEMANTIC_REBUILD_PLAN_STATUS_ROUTE = "/api/kb/semantic-rebuild-plan/status";
const KB_SEMANTIC_REBUILD_PLAN_ACCEPTANCE_ROUTE = "/api/kb/semantic-rebuild-plan/acceptance";
const KB_SEMANTIC_REBUILD_ACCEPTANCE_RECORDS_ROUTE =
  "/api/kb/semantic-rebuild-plan/acceptance-records";
const KB_SEMANTIC_REBUILD_PREFLIGHT_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-preflight";
const KB_SEMANTIC_REBUILD_DRY_RUN_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-dry-run";
const KB_SEMANTIC_REBUILD_APPROVAL_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-approval";
const KB_SEMANTIC_REBUILD_APPROVAL_RECORDS_ROUTE =
  "/api/kb/semantic-rebuild-plan/rebuild-approval-records";
const KB_SEMANTIC_REBUILD_EXECUTION_ROUTE = "/api/kb/semantic-rebuild-plan/rebuild-execution";
const KB_SEMANTIC_REBUILD_EXECUTION_CONTRACT_ROUTE =
  "/api/kb/semantic-rebuild-plan/rebuild-execution-contract";
const KB_SEMANTIC_REBUILD_EXECUTION_STAGE_ROUTE =
  "/api/kb/semantic-rebuild-plan/rebuild-execution-stage";
const KB_SEMANTIC_REBUILD_EXECUTION_RUN_ROUTE =
  "/api/kb/semantic-rebuild-plan/rebuild-execution-run";
const KB_SEMANTIC_SEARCH_ROUTE = "/api/kb/semantic-search";
const KB_HYBRID_RECALL_ROUTE = "/api/kb/hybrid-recall";
const KB_DISPATCH_RECALL_PREVIEW_ROUTE = "/api/kb/dispatch-recall-preview";
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

type SemanticRebuildApprovalRecordSummary = {
  recordPath: string;
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
  constraintsVerified: SemanticRebuildApprovalRecord["constraintsVerified"];
};

type SemanticRebuildApprovalRecordList = {
  available: boolean;
  mode: "rebuild-approval-record-list";
  reportDir: string;
  reportPrefix: string;
  totalRecords: number;
  returnedRecords: number;
  invalidRecords: number;
  latestRecord: SemanticRebuildApprovalRecordSummary | null;
  records: SemanticRebuildApprovalRecordSummary[];
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

type SemanticRebuildExecutionEntryBlockReason =
  | SemanticRebuildPreflightBlockReason
  | "approval_record_missing"
  | "approval_record_invalid"
  | "approval_not_human_approved"
  | "approval_constraints_invalid"
  | "approval_record_drift"
  | "execution_dry_run_not_ready";

type SemanticRebuildExecutionEntry = {
  available: boolean;
  mode: "semantic-rebuild-execution-entry";
  checkedAt: string;
  requestMethod: "GET" | "POST";
  status: "ready_for_real_rebuild_implementation" | "blocked";
  wouldExecute: false;
  executed: false;
  readyForRealRebuildImplementation: boolean;
  blockReasons: SemanticRebuildExecutionEntryBlockReason[];
  latestApprovalRecord: SemanticRebuildApprovalRecordSummary | null;
  approvalRecords: SemanticRebuildApprovalRecordList;
  dryRun: SemanticRebuildExecutionDryRun;
  nextAction: "run_real_rebuild_executor" | "resolve_blockers";
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

type SemanticRebuildExecutionContract = {
  available: boolean;
  mode: "semantic-rebuild-execution-contract";
  checkedAt: string;
  status: "ready_for_executor_contract" | "blocked";
  readyForExecutorContract: boolean;
  wouldExecute: false;
  executed: false;
  blockReasons: SemanticRebuildExecutionEntryBlockReason[];
  executionEntry: Pick<
    SemanticRebuildExecutionEntry,
    | "status"
    | "readyForRealRebuildImplementation"
    | "blockReasons"
    | "wouldExecute"
    | "executed"
    | "nextAction"
  >;
  executorInput: {
    contractVersion: "v1";
    action: "SEMANTIC_VECTOR_REBUILD";
    idempotencyKey: string;
    workspaceRoot: string;
    sourceIndexPath: string;
    executionRecordPath: string;
    proposal: {
      proposalId: string;
      proposalPath: string;
      generatedAt: string;
    };
    acceptance: {
      acceptanceId: string;
      acceptanceRecordPath: string;
    };
    approval: {
      approvalId: string;
      approvalRecordPath: string;
    };
    semantic: {
      provider: string | null;
      model: string | null;
    };
    batchPlan: {
      totalItems: number;
      plannedBatches: number;
      maxItemsPerBatch: 100;
    };
    plannedOutputs: {
      semanticIndexPath: "system/kb-index/semantic-index.json";
      vectorIndexPath: "system/kb-index/vector-index.sqlite";
      rebuildReportPath: "system/kb-index/semantic-rebuild-report.json";
    };
    stagedOutputs: {
      semanticIndexPath: string;
      vectorIndexPath: string;
      rebuildReportPath: string;
    };
    plannedSteps: string[];
    executionPolicy: {
      requiredApproval: "human";
      approvedBy: "rebuild-approval-record";
      embeddingCallsAllowed: true;
      semanticIndexWritesAllowed: true;
      vectorIndexWritesAllowed: true;
      atomicWritesRequired: true;
      realRebuildExecutorImplemented: true;
      nextAction: "run_real_rebuild_executor";
    };
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

type SemanticRebuildExecutionStageConstraints = {
  fileWrites: "no" | "staged-execution-record-and-manifest-only";
  stateWritten: "no";
  embeddingCalls: "no";
  keywordIndexWritten: "no";
  vectorIndexWritten: "no";
  realRebuildTriggered: "no";
  applied: "no";
};

type SemanticRebuildExecutionStageBatch = {
  batchId: string;
  itemOffset: number;
  itemLimit: number;
  itemCount: number;
};

type SemanticRebuildExecutionStageManifest = {
  manifestVersion: "v1";
  createdAt: string;
  idempotencyKey: string;
  sourceIndexPath: string;
  provider: string | null;
  model: string | null;
  totalItems: number;
  plannedBatches: number;
  maxItemsPerBatch: 100;
  batches: SemanticRebuildExecutionStageBatch[];
  activeOutputs: NonNullable<SemanticRebuildExecutionContract["executorInput"]>["plannedOutputs"];
  stagedOutputs: NonNullable<SemanticRebuildExecutionContract["executorInput"]>["stagedOutputs"];
  executionPolicy: NonNullable<
    SemanticRebuildExecutionContract["executorInput"]
  >["executionPolicy"];
};

type SemanticRebuildExecutionStageRecord = {
  mode: "semantic-rebuild-execution-stage-record";
  executionId: string;
  createdAt: string;
  status: "staged_manifest_written";
  idempotencyKey: string;
  contractVersion: "v1";
  contract: NonNullable<SemanticRebuildExecutionContract["executorInput"]>;
  manifestPath: string;
  manifest: SemanticRebuildExecutionStageManifest;
  wouldExecute: false;
  executed: false;
  constraintsVerified: SemanticRebuildExecutionStageConstraints;
};

type SemanticRebuildExecutionStageWrite = {
  mode: "semantic-rebuild-execution-stage-write";
  checkedAt: string;
  status: "staged_manifest_written" | "blocked";
  readyForStagedExecution: boolean;
  wrote: boolean;
  idempotentReplay: boolean;
  recordPath: string | null;
  manifestPath: string | null;
  blockReasons: Array<SemanticRebuildExecutionEntryBlockReason | "executor_contract_not_ready">;
  contract: SemanticRebuildExecutionContract;
  record: SemanticRebuildExecutionStageRecord | null;
  constraintsVerified: SemanticRebuildExecutionStageConstraints;
};

type SemanticRebuildExecutionRunConstraints = {
  fileWrites: "no" | "staged-and-active-semantic-vector-indexes";
  stateWritten: "no";
  embeddingCalls: "no" | "yes";
  keywordIndexWritten: "no";
  semanticIndexWritten: "no" | "yes";
  vectorIndexWritten: "no" | "yes";
  realRebuildTriggered: "no" | "yes";
  applied: "no" | "yes";
};

type SemanticRebuildExecutionRunBlockReason =
  | SemanticRebuildExecutionEntryBlockReason
  | "executor_contract_not_ready"
  | "staged_execution_not_ready"
  | "source_index_drift"
  | "semantic_provider_missing"
  | "semantic_model_missing"
  | "memory_search_disabled"
  | "vector_store_disabled"
  | "embedding_provider_unavailable";

type SemanticRebuildVectorRecord = {
  vectorId: string;
  item: KnowledgeIndexItem;
  embeddingText: string;
  embeddingTextHash: string;
  embedding: number[];
};

type SemanticRebuildSemanticIndex = {
  version: "v1";
  generatedAt: string;
  idempotencyKey: string;
  sourceIndexPath: string;
  sourceIndexGeneratedAt: string;
  provider: string;
  model: string;
  dimensions: number;
  totalItems: number;
  items: Array<
    Pick<
      KnowledgeIndexItem,
      | "itemId"
      | "sourceType"
      | "sourcePath"
      | "title"
      | "summary"
      | "tags"
      | "keywords"
      | "risk"
      | "createdAt"
      | "status"
      | "sourceCases"
    > & {
      vectorId: string;
      embeddingTextHash: string;
      embeddingTextLength: number;
    }
  >;
};

type SemanticRebuildExecutionRunReport = {
  mode: "semantic-rebuild-execution-run-report";
  executionId: string;
  idempotencyKey: string;
  executedAt: string;
  status: "applied";
  provider: string;
  model: string;
  totalItems: number;
  batchesExecuted: number;
  embeddingDimensions: number;
  outputs: NonNullable<SemanticRebuildExecutionContract["executorInput"]>["plannedOutputs"];
  stagedOutputs: NonNullable<SemanticRebuildExecutionContract["executorInput"]>["stagedOutputs"];
  executionRecordPath: string;
  constraintsVerified: SemanticRebuildExecutionRunConstraints;
};

type SemanticRebuildExecutionRun = {
  mode: "semantic-rebuild-execution-run";
  checkedAt: string;
  status: "applied" | "blocked";
  readyForExecution: boolean;
  executed: boolean;
  idempotentReplay: boolean;
  recordPath: string | null;
  reportPath: string | null;
  outputPaths:
    | NonNullable<SemanticRebuildExecutionContract["executorInput"]>["plannedOutputs"]
    | null;
  blockReasons: SemanticRebuildExecutionRunBlockReason[];
  stage: SemanticRebuildExecutionStageWrite;
  totalItems: number;
  batchesExecuted: number;
  embeddingDimensions: number | null;
  provider: string | null;
  model: string | null;
  report: SemanticRebuildExecutionRunReport | null;
  constraintsVerified: SemanticRebuildExecutionRunConstraints;
};

type SemanticSearchConstraints = {
  fileWrites: "no";
  stateWritten: "no";
  embeddingCalls: "no" | "yes";
  keywordIndexWritten: "no";
  semanticIndexWritten: "no";
  vectorIndexWritten: "no";
  realRebuildTriggered: "no";
  applied: "no";
};

type SemanticSearchBlockReason =
  | "query_missing"
  | "semantic_index_missing"
  | "semantic_index_invalid"
  | "rebuild_report_missing"
  | "rebuild_report_invalid"
  | "vector_index_missing"
  | "vector_index_invalid"
  | "memory_search_disabled"
  | "vector_store_disabled"
  | "active_index_provider_mismatch"
  | "active_index_model_mismatch"
  | "embedding_provider_unavailable"
  | "embedding_dimension_mismatch";

type SemanticSearchResult = {
  item: SemanticRebuildSemanticIndex["items"][number];
  score: number;
  vectorId: string;
};

type SemanticSearch = {
  mode: "semantic-search";
  checkedAt: string;
  status: "ready" | "blocked";
  ready: boolean;
  query: string;
  limit: number;
  blockReasons: SemanticSearchBlockReason[];
  provider: string | null;
  model: string | null;
  embeddingDimensions: number | null;
  totalIndexed: number;
  totalVectors: number;
  returnedResults: number;
  results: SemanticSearchResult[];
  constraintsVerified: SemanticSearchConstraints;
};

type HybridRecallBlockReason =
  | "query_missing"
  | "keyword_index_missing"
  | "keyword_index_invalid"
  | "semantic_search_blocked"
  | "no_recall_results";

type HybridRecallSource = "keyword" | "semantic";

type HybridRecallItem = Pick<
  KnowledgeIndexItem,
  | "itemId"
  | "sourceType"
  | "sourcePath"
  | "title"
  | "summary"
  | "tags"
  | "keywords"
  | "risk"
  | "createdAt"
  | "status"
  | "sourceCases"
> & {
  vectorId?: string;
  embeddingTextHash?: string;
  embeddingTextLength?: number;
};

type HybridRecallResult = {
  item: HybridRecallItem;
  score: number;
  keywordScore: number;
  semanticScore: number;
  vectorId: string;
  sources: HybridRecallSource[];
  matchHits: KnowledgeMatchResult["matchHits"];
};

type HybridRecall = {
  mode: "hybrid-recall";
  checkedAt: string;
  status: "ready" | "blocked";
  ready: boolean;
  query: string;
  limit: number;
  blockReasons: HybridRecallBlockReason[];
  semanticBlockReasons: SemanticSearchBlockReason[];
  provider: string | null;
  model: string | null;
  embeddingDimensions: number | null;
  totalIndexed: number;
  totalVectors: number;
  keywordReturned: number;
  semanticReturned: number;
  returnedResults: number;
  results: HybridRecallResult[];
  constraintsVerified: SemanticSearchConstraints;
};

type DispatchRecallPreviewBlockReason = "candidate_recall_blocked";

type DispatchRecallPreviewWarning = "no_selected_candidates";

type DispatchRecallPreviewHit = {
  vectorId: string;
  score: number;
  keywordScore: number;
  semanticScore: number;
  sources: HybridRecallSource[];
  item: Pick<
    HybridRecallItem,
    "itemId" | "sourceType" | "sourcePath" | "title" | "risk" | "status"
  >;
};

type DispatchRecallPreviewCandidate = {
  taskId: string;
  dispatchTarget: string;
  query: string;
  recallStatus: HybridRecall["status"];
  recallReady: boolean;
  recallBlockReasons: HybridRecall["blockReasons"];
  semanticBlockReasons: HybridRecall["semanticBlockReasons"];
  returnedResults: number;
  topResults: DispatchRecallPreviewHit[];
};

type DispatchRecallPreview = {
  mode: "dispatch-recall-preview";
  checkedAt: string;
  status: "ready" | "blocked";
  ready: boolean;
  blockReasons: DispatchRecallPreviewBlockReason[];
  warnings: DispatchRecallPreviewWarning[];
  preflightSummary: {
    queuedCandidates: number;
    policyEligibleCandidates: number;
    wouldDispatchIfApplyEnabled: number;
    wouldDispatch: 0;
  };
  selectedCandidateCount: number;
  previewedCandidateCount: number;
  recallLimit: number;
  candidates: DispatchRecallPreviewCandidate[];
  constraintsVerified: {
    stateWritten: "no";
    artifactWritten: "no";
    eventEmitted: "no";
    dispatchTriggered: "no";
    sessionsSpawnCalled: "no";
    taskGraphMutated: "no";
    returnConsumed: "no";
    receiptWritten: "no";
    embeddingCalls: "no" | "yes";
    keywordIndexWritten: "no";
    semanticIndexWritten: "no";
    vectorIndexWritten: "no";
    realRebuildTriggered: "no";
    applied: "no";
  };
};

type SemanticRebuildStatusStage =
  | "plan_missing"
  | "acceptance_blocked"
  | "preflight_blocked"
  | "execution_dry_run_blocked"
  | "rebuild_approval_required"
  | "ready_for_real_rebuild_implementation"
  | "blocked";

type SemanticRebuildStatus = {
  available: boolean;
  mode: "semantic-rebuild-status";
  checkedAt: string;
  stage: SemanticRebuildStatusStage;
  status: "ready_for_real_rebuild_implementation" | "blocked";
  nextAction: "run_real_rebuild_executor" | "resolve_blockers";
  plan: {
    available: boolean;
    reportPath: string | null;
    proposalId: string | null;
    status: KnowledgeSemanticRebuildPlan["status"] | null;
    generatedAt: string | null;
    totalItems: number | null;
    plannedBatches: number | null;
  };
  acceptance: Pick<
    SemanticRebuildProposalAcceptance,
    "status" | "readyForHumanGate" | "blockReasons" | "proposalPath"
  >;
  acceptanceRecords: Pick<
    SemanticRebuildAcceptanceRecordList,
    "available" | "totalRecords" | "returnedRecords" | "invalidRecords"
  > & { latestRecord: SemanticRebuildAcceptanceRecordSummary | null };
  preflight: Pick<
    SemanticRebuildPreflight,
    "status" | "readyForRebuildHumanApproval" | "blockReasons" | "recordPath"
  >;
  executionDryRun: Pick<
    SemanticRebuildExecutionDryRun,
    "status" | "readyForExecutionHumanGate" | "blockReasons" | "wouldExecute"
  >;
  approvalRecords: Pick<
    SemanticRebuildApprovalRecordList,
    "available" | "totalRecords" | "returnedRecords" | "invalidRecords" | "latestRecord"
  >;
  executionEntry: Pick<
    SemanticRebuildExecutionEntry,
    | "status"
    | "readyForRealRebuildImplementation"
    | "blockReasons"
    | "wouldExecute"
    | "executed"
    | "nextAction"
  >;
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

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveRequestPath(req: IncomingMessage): string {
  return resolveRequestUrl(req).pathname;
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

function semanticRebuildExecutionPathSegment(idempotencyKey: string): string {
  return `semantic-rebuild-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
}

function semanticRebuildExecutionId(idempotencyKey: string): string {
  return `kb-${semanticRebuildExecutionPathSegment(idempotencyKey)}`;
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

function isSemanticRebuildApprovalRecord(value: unknown): value is SemanticRebuildApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const constraints = record.constraintsVerified;
  return (
    record.mode === "rebuild-approval-record" &&
    typeof record.approvalId === "string" &&
    typeof record.createdAt === "string" &&
    record.status === "rebuild_human_approved" &&
    typeof record.acceptanceId === "string" &&
    typeof record.proposalId === "string" &&
    typeof record.proposalPath === "string" &&
    typeof record.acceptanceRecordPath === "string" &&
    typeof record.plannedBatches === "number" &&
    typeof record.totalItems === "number" &&
    record.requiredApproval === "human" &&
    record.nextAction === "await_rebuild_execution" &&
    record.approved === true &&
    record.rebuildTriggered === false &&
    Boolean(constraints) &&
    typeof constraints === "object" &&
    !Array.isArray(constraints) &&
    (constraints as Record<string, unknown>).approvalRecordWritten === "yes" &&
    (constraints as Record<string, unknown>).stateWritten === "no" &&
    (constraints as Record<string, unknown>).embeddingCalls === "no" &&
    (constraints as Record<string, unknown>).keywordIndexWritten === "no" &&
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

function summarizeApprovalRecord(
  recordPath: string,
  record: SemanticRebuildApprovalRecord,
): SemanticRebuildApprovalRecordSummary {
  return {
    recordPath,
    approvalId: record.approvalId,
    createdAt: record.createdAt,
    status: record.status,
    acceptanceId: record.acceptanceId,
    proposalId: record.proposalId,
    proposalPath: record.proposalPath,
    acceptanceRecordPath: record.acceptanceRecordPath,
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

async function readLatestSemanticRebuildApprovalRecordEntry(
  workspaceRoot: string,
): Promise<{ recordPath: string; record: SemanticRebuildApprovalRecord | null } | null> {
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
        entry.startsWith(SEMANTIC_REBUILD_APPROVAL_PREFIX) &&
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
      record: isSemanticRebuildApprovalRecord(parsed) ? parsed : null,
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

function executionStageConstraints<T extends "no" | "staged-execution-record-and-manifest-only">(
  fileWrites: T,
) {
  return {
    fileWrites,
    stateWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

function executionRunConstraints(params: {
  fileWrites: SemanticRebuildExecutionRunConstraints["fileWrites"];
  embeddingCalls: SemanticRebuildExecutionRunConstraints["embeddingCalls"];
  semanticIndexWritten: SemanticRebuildExecutionRunConstraints["semanticIndexWritten"];
  vectorIndexWritten: SemanticRebuildExecutionRunConstraints["vectorIndexWritten"];
  realRebuildTriggered: SemanticRebuildExecutionRunConstraints["realRebuildTriggered"];
  applied: SemanticRebuildExecutionRunConstraints["applied"];
}): SemanticRebuildExecutionRunConstraints {
  return {
    fileWrites: params.fileWrites,
    stateWritten: "no",
    embeddingCalls: params.embeddingCalls,
    keywordIndexWritten: "no",
    semanticIndexWritten: params.semanticIndexWritten,
    vectorIndexWritten: params.vectorIndexWritten,
    realRebuildTriggered: params.realRebuildTriggered,
    applied: params.applied,
  };
}

function noExecutionRunConstraints(): SemanticRebuildExecutionRunConstraints {
  return executionRunConstraints({
    fileWrites: "no",
    embeddingCalls: "no",
    semanticIndexWritten: "no",
    vectorIndexWritten: "no",
    realRebuildTriggered: "no",
    applied: "no",
  });
}

function appliedExecutionRunConstraints(): SemanticRebuildExecutionRunConstraints {
  return executionRunConstraints({
    fileWrites: "staged-and-active-semantic-vector-indexes",
    embeddingCalls: "yes",
    semanticIndexWritten: "yes",
    vectorIndexWritten: "yes",
    realRebuildTriggered: "yes",
    applied: "yes",
  });
}

function approvalRecordConstraintsValid(record: SemanticRebuildApprovalRecord): boolean {
  return (
    record.status === "rebuild_human_approved" &&
    record.requiredApproval === "human" &&
    record.nextAction === "await_rebuild_execution" &&
    record.approved === true &&
    record.rebuildTriggered === false &&
    record.constraintsVerified.approvalRecordWritten === "yes" &&
    record.constraintsVerified.stateWritten === "no" &&
    record.constraintsVerified.embeddingCalls === "no" &&
    record.constraintsVerified.keywordIndexWritten === "no" &&
    record.constraintsVerified.vectorIndexWritten === "no" &&
    record.constraintsVerified.realRebuildTriggered === "no" &&
    record.constraintsVerified.applied === "no"
  );
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

export async function listSemanticRebuildApprovalRecords(
  workspaceRoot: string,
): Promise<SemanticRebuildApprovalRecordList> {
  const reportDir = path.join(workspaceRoot, ...SEMANTIC_REBUILD_PLAN_REPORT_DIR.split("/"));
  const constraintsVerified = {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
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
      mode: "rebuild-approval-record-list",
      reportDir: SEMANTIC_REBUILD_PLAN_REPORT_DIR,
      reportPrefix: SEMANTIC_REBUILD_APPROVAL_PREFIX,
      totalRecords: 0,
      returnedRecords: 0,
      invalidRecords: 0,
      latestRecord: null,
      records: [],
      constraintsVerified,
    };
  }

  const recordFiles = entries
    .filter(
      (entry) =>
        entry.startsWith(SEMANTIC_REBUILD_APPROVAL_PREFIX) &&
        entry.endsWith(SEMANTIC_REBUILD_PLAN_REPORT_SUFFIX),
    )
    .sort()
    .reverse();
  const records: SemanticRebuildApprovalRecordSummary[] = [];
  let invalidRecords = 0;
  for (const entry of recordFiles.slice(0, 20)) {
    const recordPath = [SEMANTIC_REBUILD_PLAN_REPORT_DIR, entry].join("/");
    try {
      const parsed = JSON.parse(await readFile(path.join(reportDir, entry), "utf8")) as unknown;
      if (!isSemanticRebuildApprovalRecord(parsed)) {
        invalidRecords += 1;
        continue;
      }
      records.push(summarizeApprovalRecord(recordPath, parsed));
    } catch {
      invalidRecords += 1;
    }
  }

  return {
    available: records.length > 0,
    mode: "rebuild-approval-record-list",
    reportDir: SEMANTIC_REBUILD_PLAN_REPORT_DIR,
    reportPrefix: SEMANTIC_REBUILD_APPROVAL_PREFIX,
    totalRecords: recordFiles.length,
    returnedRecords: records.length,
    invalidRecords,
    latestRecord: records[0] ?? null,
    records,
    constraintsVerified,
  };
}

function approvalRecordMatchesExecutionDryRun(
  record: SemanticRebuildApprovalRecord,
  dryRun: SemanticRebuildExecutionDryRun,
): boolean {
  const plannedExecution = dryRun.plannedExecution;
  return (
    dryRun.readyForExecutionHumanGate &&
    plannedExecution !== null &&
    record.acceptanceId === plannedExecution.acceptanceId &&
    record.proposalId === plannedExecution.proposalId &&
    record.proposalPath === plannedExecution.proposalPath &&
    record.acceptanceRecordPath === plannedExecution.recordPath &&
    record.plannedBatches === plannedExecution.plannedBatches &&
    record.totalItems === plannedExecution.totalItems
  );
}

export async function checkSemanticRebuildExecutionEntry(
  workspaceRoot: string,
  options?: KbHttpOptions,
  requestMethod: "GET" | "POST" = "GET",
): Promise<SemanticRebuildExecutionEntry> {
  const checkedAt = new Date().toISOString();
  const dryRun = await buildSemanticRebuildExecutionDryRun(workspaceRoot, options);
  const approvalRecords = await listSemanticRebuildApprovalRecords(workspaceRoot);
  const latest = await readLatestSemanticRebuildApprovalRecordEntry(workspaceRoot);
  const blockReasons: SemanticRebuildExecutionEntryBlockReason[] = [];
  let latestApprovalRecord: SemanticRebuildApprovalRecordSummary | null = null;

  if (!latest) {
    blockReasons.push("approval_record_missing");
  } else if (!latest.record) {
    blockReasons.push("approval_record_invalid");
  } else {
    latestApprovalRecord = summarizeApprovalRecord(latest.recordPath, latest.record);
    if (latest.record.status !== "rebuild_human_approved" || latest.record.approved !== true) {
      blockReasons.push("approval_not_human_approved");
    }
    if (!approvalRecordConstraintsValid(latest.record)) {
      blockReasons.push("approval_constraints_invalid");
    }
    if (!approvalRecordMatchesExecutionDryRun(latest.record, dryRun)) {
      blockReasons.push("approval_record_drift");
    }
  }

  if (!dryRun.readyForExecutionHumanGate) {
    blockReasons.push("execution_dry_run_not_ready", ...dryRun.blockReasons);
  }

  const uniqueBlockReasons = [...new Set(blockReasons)];
  const readyForRealRebuildImplementation = uniqueBlockReasons.length === 0;
  return {
    available: latestApprovalRecord !== null,
    mode: "semantic-rebuild-execution-entry",
    checkedAt,
    requestMethod,
    status: readyForRealRebuildImplementation ? "ready_for_real_rebuild_implementation" : "blocked",
    wouldExecute: false,
    executed: false,
    readyForRealRebuildImplementation,
    blockReasons: uniqueBlockReasons,
    latestApprovalRecord,
    approvalRecords,
    dryRun,
    nextAction: readyForRealRebuildImplementation
      ? "run_real_rebuild_executor"
      : "resolve_blockers",
    constraintsVerified: preflightConstraints(),
  };
}

export async function buildSemanticRebuildExecutionContract(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildExecutionContract> {
  const checkedAt = new Date().toISOString();
  const executionEntry = await checkSemanticRebuildExecutionEntry(workspaceRoot, options);
  const plannedExecution = executionEntry.dryRun.plannedExecution;
  const latestPlan = await readLatestSemanticRebuildPlanReportEntry(workspaceRoot);
  const latestApprovalRecord = executionEntry.latestApprovalRecord;
  const readyForExecutorContract =
    executionEntry.readyForRealRebuildImplementation &&
    plannedExecution !== null &&
    latestPlan !== null &&
    latestApprovalRecord !== null;
  const executorInput =
    readyForExecutorContract && plannedExecution && latestPlan && latestApprovalRecord
      ? (() => {
          const idempotencyKey = `semantic-rebuild:${plannedExecution.proposalId}:${latestApprovalRecord.approvalId}`;
          const pathSegment = semanticRebuildExecutionPathSegment(idempotencyKey);
          const stagingDir = `runtime/main/tmp/semantic-rebuild-staging/${pathSegment}`;
          return {
            contractVersion: "v1" as const,
            action: "SEMANTIC_VECTOR_REBUILD" as const,
            idempotencyKey,
            workspaceRoot,
            sourceIndexPath: KB_INDEX_FILE_RELATIVE_PATH,
            executionRecordPath: [
              SEMANTIC_REBUILD_PLAN_REPORT_DIR,
              `kb-semantic-rebuild-execution-${pathSegment}.json`,
            ].join("/"),
            proposal: {
              proposalId: plannedExecution.proposalId,
              proposalPath: plannedExecution.proposalPath,
              generatedAt: latestPlan.plan.generatedAt,
            },
            acceptance: {
              acceptanceId: plannedExecution.acceptanceId,
              acceptanceRecordPath: plannedExecution.recordPath,
            },
            approval: {
              approvalId: latestApprovalRecord.approvalId,
              approvalRecordPath: latestApprovalRecord.recordPath,
            },
            semantic: {
              provider: plannedExecution.provider,
              model: plannedExecution.model,
            },
            batchPlan: {
              totalItems: plannedExecution.totalItems,
              plannedBatches: plannedExecution.plannedBatches,
              maxItemsPerBatch: 100 as const,
            },
            plannedOutputs: {
              semanticIndexPath: "system/kb-index/semantic-index.json" as const,
              vectorIndexPath: "system/kb-index/vector-index.sqlite" as const,
              rebuildReportPath: "system/kb-index/semantic-rebuild-report.json" as const,
            },
            stagedOutputs: {
              semanticIndexPath: `${stagingDir}/semantic-index.json`,
              vectorIndexPath: `${stagingDir}/vector-index.sqlite`,
              rebuildReportPath: `${stagingDir}/semantic-rebuild-report.json`,
            },
            plannedSteps: plannedExecution.plannedSteps,
            executionPolicy: {
              requiredApproval: "human" as const,
              approvedBy: "rebuild-approval-record" as const,
              embeddingCallsAllowed: true as const,
              semanticIndexWritesAllowed: true as const,
              vectorIndexWritesAllowed: true as const,
              atomicWritesRequired: true as const,
              realRebuildExecutorImplemented: true as const,
              nextAction: "run_real_rebuild_executor" as const,
            },
          };
        })()
      : null;

  return {
    available: readyForExecutorContract,
    mode: "semantic-rebuild-execution-contract",
    checkedAt,
    status: readyForExecutorContract ? "ready_for_executor_contract" : "blocked",
    readyForExecutorContract,
    wouldExecute: false,
    executed: false,
    blockReasons: executionEntry.blockReasons,
    executionEntry: {
      status: executionEntry.status,
      readyForRealRebuildImplementation: executionEntry.readyForRealRebuildImplementation,
      blockReasons: executionEntry.blockReasons,
      wouldExecute: executionEntry.wouldExecute,
      executed: executionEntry.executed,
      nextAction: executionEntry.nextAction,
    },
    executorInput,
    constraintsVerified: preflightConstraints(),
  };
}

function buildExecutionStageBatches(
  totalItems: number,
  maxItemsPerBatch: 100,
): SemanticRebuildExecutionStageBatch[] {
  const batches: SemanticRebuildExecutionStageBatch[] = [];
  for (let itemOffset = 0; itemOffset < totalItems; itemOffset += maxItemsPerBatch) {
    const itemLimit = Math.min(itemOffset + maxItemsPerBatch, totalItems);
    batches.push({
      batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`,
      itemOffset,
      itemLimit,
      itemCount: itemLimit - itemOffset,
    });
  }
  return batches;
}

function buildSemanticRebuildExecutionStageRecord(
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>,
  createdAt: string,
): SemanticRebuildExecutionStageRecord {
  const manifest: SemanticRebuildExecutionStageManifest = {
    manifestVersion: "v1",
    createdAt,
    idempotencyKey: executorInput.idempotencyKey,
    sourceIndexPath: executorInput.sourceIndexPath,
    provider: executorInput.semantic.provider,
    model: executorInput.semantic.model,
    totalItems: executorInput.batchPlan.totalItems,
    plannedBatches: executorInput.batchPlan.plannedBatches,
    maxItemsPerBatch: executorInput.batchPlan.maxItemsPerBatch,
    batches: buildExecutionStageBatches(
      executorInput.batchPlan.totalItems,
      executorInput.batchPlan.maxItemsPerBatch,
    ),
    activeOutputs: executorInput.plannedOutputs,
    stagedOutputs: executorInput.stagedOutputs,
    executionPolicy: executorInput.executionPolicy,
  };
  return {
    mode: "semantic-rebuild-execution-stage-record",
    executionId: semanticRebuildExecutionId(executorInput.idempotencyKey),
    createdAt,
    status: "staged_manifest_written",
    idempotencyKey: executorInput.idempotencyKey,
    contractVersion: executorInput.contractVersion,
    contract: executorInput,
    manifestPath: executorInput.stagedOutputs.rebuildReportPath,
    manifest,
    wouldExecute: false,
    executed: false,
    constraintsVerified: executionStageConstraints("staged-execution-record-and-manifest-only"),
  };
}

function isSameSemanticRebuildExecutionPolicy(
  left: SemanticRebuildExecutionStageManifest["executionPolicy"],
  right: SemanticRebuildExecutionStageManifest["executionPolicy"],
): boolean {
  return (
    left.requiredApproval === right.requiredApproval &&
    left.approvedBy === right.approvedBy &&
    left.embeddingCallsAllowed === right.embeddingCallsAllowed &&
    left.semanticIndexWritesAllowed === right.semanticIndexWritesAllowed &&
    left.vectorIndexWritesAllowed === right.vectorIndexWritesAllowed &&
    left.atomicWritesRequired === right.atomicWritesRequired &&
    left.realRebuildExecutorImplemented === right.realRebuildExecutorImplemented &&
    left.nextAction === right.nextAction
  );
}

function isCurrentSemanticRebuildExecutionStageRecord(
  record: SemanticRebuildExecutionStageRecord,
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>,
): boolean {
  return (
    record.executionId === semanticRebuildExecutionId(executorInput.idempotencyKey) &&
    record.idempotencyKey === executorInput.idempotencyKey &&
    record.contractVersion === executorInput.contractVersion &&
    record.manifestPath === executorInput.stagedOutputs.rebuildReportPath &&
    record.contract.idempotencyKey === executorInput.idempotencyKey &&
    record.contract.sourceIndexPath === executorInput.sourceIndexPath &&
    record.contract.executionRecordPath === executorInput.executionRecordPath &&
    record.contract.semantic.provider === executorInput.semantic.provider &&
    record.contract.semantic.model === executorInput.semantic.model &&
    record.contract.batchPlan.totalItems === executorInput.batchPlan.totalItems &&
    record.contract.batchPlan.plannedBatches === executorInput.batchPlan.plannedBatches &&
    record.contract.batchPlan.maxItemsPerBatch === executorInput.batchPlan.maxItemsPerBatch &&
    record.manifest.idempotencyKey === executorInput.idempotencyKey &&
    record.manifest.sourceIndexPath === executorInput.sourceIndexPath &&
    record.manifest.provider === executorInput.semantic.provider &&
    record.manifest.model === executorInput.semantic.model &&
    record.manifest.totalItems === executorInput.batchPlan.totalItems &&
    record.manifest.plannedBatches === executorInput.batchPlan.plannedBatches &&
    isSameSemanticRebuildExecutionPolicy(
      record.contract.executionPolicy,
      executorInput.executionPolicy,
    ) &&
    isSameSemanticRebuildExecutionPolicy(
      record.manifest.executionPolicy,
      executorInput.executionPolicy,
    )
  );
}

function isSemanticRebuildExecutionStageRecord(
  value: unknown,
): value is SemanticRebuildExecutionStageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const constraints = record.constraintsVerified as Record<string, unknown> | undefined;
  if (!constraints) return false;
  return (
    record.mode === "semantic-rebuild-execution-stage-record" &&
    typeof record.executionId === "string" &&
    typeof record.createdAt === "string" &&
    record.status === "staged_manifest_written" &&
    typeof record.idempotencyKey === "string" &&
    record.contractVersion === "v1" &&
    typeof record.manifestPath === "string" &&
    record.wouldExecute === false &&
    record.executed === false &&
    Boolean(record.contract) &&
    typeof record.contract === "object" &&
    Boolean(record.manifest) &&
    typeof record.manifest === "object" &&
    constraints.fileWrites === "staged-execution-record-and-manifest-only" &&
    constraints.embeddingCalls === "no" &&
    constraints.vectorIndexWritten === "no" &&
    constraints.realRebuildTriggered === "no" &&
    constraints.applied === "no"
  );
}

async function readSemanticRebuildExecutionStageRecord(
  workspaceRoot: string,
  recordPath: string,
): Promise<SemanticRebuildExecutionStageRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(workspaceRoot, ...recordPath.split("/")), "utf8"),
    ) as unknown;
    return isSemanticRebuildExecutionStageRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSemanticRebuildExecutionStageRecord(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildExecutionStageWrite> {
  const checkedAt = new Date().toISOString();
  const contract = await buildSemanticRebuildExecutionContract(workspaceRoot, options);
  const executorInput = contract.executorInput;
  if (!contract.readyForExecutorContract || !executorInput) {
    return {
      mode: "semantic-rebuild-execution-stage-write",
      checkedAt,
      status: "blocked",
      readyForStagedExecution: false,
      wrote: false,
      idempotentReplay: false,
      recordPath: executorInput?.executionRecordPath ?? null,
      manifestPath: executorInput?.stagedOutputs.rebuildReportPath ?? null,
      blockReasons: ["executor_contract_not_ready", ...contract.blockReasons],
      contract,
      record: null,
      constraintsVerified: executionStageConstraints("no"),
    };
  }

  const existing = await readSemanticRebuildExecutionStageRecord(
    workspaceRoot,
    executorInput.executionRecordPath,
  );
  if (existing && isCurrentSemanticRebuildExecutionStageRecord(existing, executorInput)) {
    return {
      mode: "semantic-rebuild-execution-stage-write",
      checkedAt,
      status: "staged_manifest_written",
      readyForStagedExecution: true,
      wrote: false,
      idempotentReplay: true,
      recordPath: executorInput.executionRecordPath,
      manifestPath: existing.manifestPath,
      blockReasons: [],
      contract,
      record: existing,
      constraintsVerified: executionStageConstraints("no"),
    };
  }

  const record = buildSemanticRebuildExecutionStageRecord(executorInput, checkedAt);
  const recordFile = path.join(workspaceRoot, ...executorInput.executionRecordPath.split("/"));
  const manifestFile = path.join(workspaceRoot, ...record.manifestPath.split("/"));
  await mkdir(path.dirname(recordFile), { recursive: true });
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(record.manifest, null, 2)}\n`, "utf8");
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return {
    mode: "semantic-rebuild-execution-stage-write",
    checkedAt,
    status: "staged_manifest_written",
    readyForStagedExecution: true,
    wrote: true,
    idempotentReplay: false,
    recordPath: executorInput.executionRecordPath,
    manifestPath: record.manifestPath,
    blockReasons: [],
    contract,
    record,
    constraintsVerified: record.constraintsVerified,
  };
}

function semanticRebuildExecutionRunRecordPath(
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>,
): string {
  return executorInput.executionRecordPath.replace(
    "/kb-semantic-rebuild-execution-",
    "/kb-semantic-rebuild-execution-run-",
  );
}

function isAppliedExecutionRunReport(value: unknown): value is SemanticRebuildExecutionRunReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const constraints = report.constraintsVerified as Record<string, unknown> | undefined;
  if (!constraints) return false;
  return (
    report.mode === "semantic-rebuild-execution-run-report" &&
    typeof report.executionId === "string" &&
    typeof report.idempotencyKey === "string" &&
    typeof report.executedAt === "string" &&
    report.status === "applied" &&
    typeof report.provider === "string" &&
    typeof report.model === "string" &&
    typeof report.totalItems === "number" &&
    typeof report.batchesExecuted === "number" &&
    typeof report.embeddingDimensions === "number" &&
    Boolean(report.outputs) &&
    typeof report.outputs === "object" &&
    constraints.embeddingCalls === "yes" &&
    constraints.semanticIndexWritten === "yes" &&
    constraints.vectorIndexWritten === "yes" &&
    constraints.realRebuildTriggered === "yes" &&
    constraints.applied === "yes"
  );
}

function isSemanticRebuildSemanticIndex(value: unknown): value is SemanticRebuildSemanticIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  return (
    index.version === "v1" &&
    typeof index.generatedAt === "string" &&
    typeof index.idempotencyKey === "string" &&
    typeof index.provider === "string" &&
    typeof index.model === "string" &&
    typeof index.dimensions === "number" &&
    typeof index.totalItems === "number" &&
    Array.isArray(index.items)
  );
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

type ActiveKnowledgeIndexRead =
  | { status: "ready"; index: KnowledgeIndex }
  | { status: "missing" | "invalid"; index: null };

function isKnowledgeIndex(value: unknown): value is KnowledgeIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  return (
    index.version === "1.0" &&
    index.indexStrategy === "keyword-first" &&
    typeof index.generatedAt === "string" &&
    typeof index.totalItems === "number" &&
    Array.isArray(index.items) &&
    Boolean(index.keywords) &&
    typeof index.keywords === "object" &&
    !Array.isArray(index.keywords)
  );
}

async function readActiveKnowledgeIndex(workspaceRoot: string): Promise<ActiveKnowledgeIndexRead> {
  const indexPath = path.join(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    return { status: "missing", index: null };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isKnowledgeIndex(parsed)) return { status: "invalid", index: null };
    return { status: "ready", index: parsed };
  } catch {
    return { status: "invalid", index: null };
  }
}

async function activeExecutionReportReplay(
  workspaceRoot: string,
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>,
): Promise<SemanticRebuildExecutionRunReport | null> {
  const reportPath = path.join(
    workspaceRoot,
    ...executorInput.plannedOutputs.rebuildReportPath.split("/"),
  );
  const parsed = await readJsonFile(reportPath);
  if (
    !isAppliedExecutionRunReport(parsed) ||
    parsed.idempotencyKey !== executorInput.idempotencyKey
  ) {
    return null;
  }
  const semanticIndex = await readJsonFile(
    path.join(workspaceRoot, ...executorInput.plannedOutputs.semanticIndexPath.split("/")),
  );
  try {
    await readFile(
      path.join(workspaceRoot, ...executorInput.plannedOutputs.vectorIndexPath.split("/")),
    );
  } catch {
    return null;
  }
  if (!semanticIndex || typeof semanticIndex !== "object") {
    return null;
  }
  return parsed;
}

function semanticEmbeddingText(item: KnowledgeIndexItem): string {
  return [
    `id: ${item.itemId}`,
    `type: ${item.sourceType}`,
    `title: ${item.title}`,
    item.summary ? `summary: ${item.summary}` : null,
    item.tags.length > 0 ? `tags: ${item.tags.join(", ")}` : null,
    item.keywords.length > 0 ? `keywords: ${item.keywords.join(", ")}` : null,
    `risk: ${item.risk}`,
    item.status ? `status: ${item.status}` : null,
    item.sourceCases?.length ? `sourceCases: ${item.sourceCases.join(", ")}` : null,
    `sourcePath: ${item.sourcePath}`,
  ]
    .filter((entry): entry is string => entry !== null)
    .join("\n");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorIdForItem(item: KnowledgeIndexItem): string {
  return `${item.sourceType}:${item.itemId}`;
}

function assertValidEmbeddingBatch(
  vectors: number[][],
  expectedLength: number,
  expectedDimensions: number | null,
): number {
  if (vectors.length !== expectedLength) {
    throw new Error(
      `Embedding batch returned ${vectors.length} vectors for ${expectedLength} inputs.`,
    );
  }
  let dimensions = expectedDimensions;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Embedding provider returned an empty vector.");
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new Error("Embedding provider returned a non-finite vector value.");
    }
    dimensions ??= vector.length;
    if (vector.length !== dimensions) {
      throw new Error("Embedding provider returned inconsistent vector dimensions.");
    }
  }
  return dimensions ?? 0;
}

async function embedSemanticRebuildItems(params: {
  workspaceRoot: string;
  config: OpenClawConfig;
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>;
  stageRecord: SemanticRebuildExecutionStageRecord;
  index: KnowledgeIndex;
}): Promise<{
  records: SemanticRebuildVectorRecord[];
  dimensions: number;
  provider: string;
  model: string;
}> {
  const providerId = params.executorInput.semantic.provider;
  const model = params.executorInput.semantic.model;
  if (!providerId) {
    throw new Error("semantic_provider_missing");
  }
  if (!model) {
    throw new Error("semantic_model_missing");
  }
  const memorySearch = resolveMemorySearchConfig(params.config, "main");
  if (!memorySearch) {
    throw new Error("memory_search_disabled");
  }
  if (!memorySearch.store.vector.enabled) {
    throw new Error("vector_store_disabled");
  }
  const result = await createEmbeddingProvider({
    config: params.config,
    agentDir: resolveAgentDir(params.config, "main"),
    provider: providerId,
    fallback: memorySearch.fallback,
    model,
    local: memorySearch.local,
    remote: memorySearch.remote
      ? {
          baseUrl: memorySearch.remote.baseUrl,
          apiKey: memorySearch.remote.apiKey,
          headers: memorySearch.remote.headers,
        }
      : undefined,
    outputDimensionality: memorySearch.outputDimensionality,
  });
  if (!result.provider) {
    throw new Error(result.providerUnavailableReason ?? "embedding_provider_unavailable");
  }

  const records: SemanticRebuildVectorRecord[] = [];
  let dimensions: number | null = null;
  for (const batch of params.stageRecord.manifest.batches) {
    const items = params.index.items.slice(batch.itemOffset, batch.itemLimit);
    const texts = items.map(semanticEmbeddingText);
    const vectors = await result.provider.embedBatch(texts);
    dimensions = assertValidEmbeddingBatch(vectors, items.length, dimensions);
    for (const [index, item] of items.entries()) {
      const embeddingText = texts[index] ?? "";
      records.push({
        vectorId: vectorIdForItem(item),
        item,
        embeddingText,
        embeddingTextHash: sha256Text(embeddingText),
        embedding: vectors[index] ?? [],
      });
    }
  }

  return {
    records,
    dimensions: dimensions ?? 0,
    provider: result.provider.id,
    model: result.provider.model,
  };
}

function buildSemanticIndex(params: {
  executedAt: string;
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>;
  index: KnowledgeIndex;
  records: SemanticRebuildVectorRecord[];
  dimensions: number;
  provider: string;
  model: string;
}): SemanticRebuildSemanticIndex {
  return {
    version: "v1",
    generatedAt: params.executedAt,
    idempotencyKey: params.executorInput.idempotencyKey,
    sourceIndexPath: params.executorInput.sourceIndexPath,
    sourceIndexGeneratedAt: params.index.generatedAt,
    provider: params.provider,
    model: params.model,
    dimensions: params.dimensions,
    totalItems: params.records.length,
    items: params.records.map((record) => ({
      itemId: record.item.itemId,
      sourceType: record.item.sourceType,
      sourcePath: record.item.sourcePath,
      title: record.item.title,
      summary: record.item.summary,
      tags: record.item.tags,
      keywords: record.item.keywords,
      risk: record.item.risk,
      createdAt: record.item.createdAt,
      ...(record.item.status ? { status: record.item.status } : {}),
      ...(record.item.sourceCases ? { sourceCases: record.item.sourceCases } : {}),
      vectorId: record.vectorId,
      embeddingTextHash: record.embeddingTextHash,
      embeddingTextLength: record.embeddingText.length,
    })),
  };
}

async function writeJsonFile(
  workspaceRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function noSemanticSearchConstraints(): SemanticSearchConstraints {
  return {
    fileWrites: "no",
    stateWritten: "no",
    embeddingCalls: "no",
    keywordIndexWritten: "no",
    semanticIndexWritten: "no",
    vectorIndexWritten: "no",
    realRebuildTriggered: "no",
    applied: "no",
  };
}

function semanticSearchConstraintsWithEmbedding(): SemanticSearchConstraints {
  return {
    ...noSemanticSearchConstraints(),
    embeddingCalls: "yes",
  };
}

function blockedSemanticSearch(params: {
  checkedAt: string;
  query: string;
  limit: number;
  blockReasons: SemanticSearchBlockReason[];
  provider?: string | null;
  model?: string | null;
  embeddingDimensions?: number | null;
  totalIndexed?: number;
  totalVectors?: number;
}): SemanticSearch {
  return {
    mode: "semantic-search",
    checkedAt: params.checkedAt,
    status: "blocked",
    ready: false,
    query: params.query,
    limit: params.limit,
    blockReasons: [...new Set(params.blockReasons)],
    provider: params.provider ?? null,
    model: params.model ?? null,
    embeddingDimensions: params.embeddingDimensions ?? null,
    totalIndexed: params.totalIndexed ?? 0,
    totalVectors: params.totalVectors ?? 0,
    returnedResults: 0,
    results: [],
    constraintsVerified: noSemanticSearchConstraints(),
  };
}

function normalizeSemanticSearchLimit(raw: number | null | undefined): number {
  if (!Number.isFinite(raw)) return 5;
  return Math.min(20, Math.max(1, Math.floor(raw ?? 5)));
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function parseEmbeddingJson(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

async function readSemanticVectors(
  workspaceRoot: string,
  relativePath: string,
): Promise<SemanticRebuildVectorRecord[] | null> {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  try {
    await readFile(filePath);
  } catch {
    return null;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath);
  try {
    const rows = db
      .prepare(
        `SELECT vector_id, item_id, source_type, source_path, text_hash, dimensions, embedding_json
         FROM vectors`,
      )
      .all() as Array<{
      vector_id: string;
      item_id: string;
      source_type: string;
      source_path: string;
      text_hash: string;
      dimensions: number | bigint;
      embedding_json: string;
    }>;
    return rows.map((row) => ({
      vectorId: row.vector_id,
      item: {
        itemId: row.item_id,
        sourceType: row.source_type === "skill" ? "skill" : "case",
        sourcePath: row.source_path,
        title: row.item_id,
        summary: "",
        tags: [],
        keywords: [],
        risk: "unknown",
        createdAt: "",
      },
      embeddingText: "",
      embeddingTextHash: row.text_hash,
      embedding: parseEmbeddingJson(row.embedding_json) ?? [],
    }));
  } finally {
    db.close();
  }
}

export async function executeSemanticSearch(
  workspaceRoot: string,
  params: { query: string; limit?: number | null },
  options?: KbHttpOptions,
): Promise<SemanticSearch> {
  const checkedAt = new Date().toISOString();
  const query = params.query.trim();
  const limit = normalizeSemanticSearchLimit(params.limit ?? null);
  if (!query) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["query_missing"],
    });
  }

  const reportPath = path.join(workspaceRoot, "system", "kb-index", "semantic-rebuild-report.json");
  const report = await readJsonFile(reportPath);
  if (!report) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["rebuild_report_missing"],
    });
  }
  if (!isAppliedExecutionRunReport(report)) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["rebuild_report_invalid"],
    });
  }

  const semanticIndexPath = path.join(
    workspaceRoot,
    ...report.outputs.semanticIndexPath.split("/"),
  );
  const semanticIndex = await readJsonFile(semanticIndexPath);
  if (!semanticIndex) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["semantic_index_missing"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
    });
  }
  if (!isSemanticRebuildSemanticIndex(semanticIndex)) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["semantic_index_invalid"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
    });
  }
  if (semanticIndex.provider !== report.provider) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["active_index_provider_mismatch"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
    });
  }
  if (semanticIndex.model !== report.model) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["active_index_model_mismatch"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
    });
  }

  const vectors = await readSemanticVectors(workspaceRoot, report.outputs.vectorIndexPath);
  if (!vectors) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["vector_index_missing"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
    });
  }
  const config = options?.config ?? (options?.loadConfig ?? loadConfig)();
  const memorySearch = resolveMemorySearchConfig(config, "main");
  if (!memorySearch) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["memory_search_disabled"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }
  if (!memorySearch.store.vector.enabled) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["vector_store_disabled"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }
  if (memorySearch.provider !== "auto" && memorySearch.provider !== report.provider) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["active_index_provider_mismatch"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }
  if (memorySearch.model && memorySearch.model !== report.model) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["active_index_model_mismatch"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }

  const providerResult = await createEmbeddingProvider({
    config,
    agentDir: resolveAgentDir(config, "main"),
    provider: report.provider,
    fallback: memorySearch.fallback,
    model: report.model,
    local: memorySearch.local,
    remote: memorySearch.remote
      ? {
          baseUrl: memorySearch.remote.baseUrl,
          apiKey: memorySearch.remote.apiKey,
          headers: memorySearch.remote.headers,
        }
      : undefined,
    outputDimensionality: memorySearch.outputDimensionality,
  });
  if (!providerResult.provider) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["embedding_provider_unavailable"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }
  const queryVector = await providerResult.provider.embedQuery(query);
  if (queryVector.length !== report.embeddingDimensions) {
    return blockedSemanticSearch({
      checkedAt,
      query,
      limit,
      blockReasons: ["embedding_dimension_mismatch"],
      provider: report.provider,
      model: report.model,
      embeddingDimensions: report.embeddingDimensions,
      totalIndexed: semanticIndex.totalItems,
      totalVectors: vectors.length,
    });
  }

  const semanticItems = new Map(semanticIndex.items.map((item) => [item.vectorId, item]));
  const results: SemanticSearchResult[] = [];
  for (const vector of vectors) {
    const item = semanticItems.get(vector.vectorId);
    if (!item) continue;
    if (vector.embedding.length !== queryVector.length) {
      return blockedSemanticSearch({
        checkedAt,
        query,
        limit,
        blockReasons: ["embedding_dimension_mismatch"],
        provider: report.provider,
        model: report.model,
        embeddingDimensions: report.embeddingDimensions,
        totalIndexed: semanticIndex.totalItems,
        totalVectors: vectors.length,
      });
    }
    results.push({
      item,
      score: cosineSimilarity(queryVector, vector.embedding),
      vectorId: vector.vectorId,
    });
  }

  const sortedResults = results
    .sort((left, right) => right.score - left.score || left.vectorId.localeCompare(right.vectorId))
    .slice(0, limit);
  return {
    mode: "semantic-search",
    checkedAt,
    status: "ready",
    ready: true,
    query,
    limit,
    blockReasons: [],
    provider: report.provider,
    model: report.model,
    embeddingDimensions: report.embeddingDimensions,
    totalIndexed: semanticIndex.totalItems,
    totalVectors: vectors.length,
    returnedResults: sortedResults.length,
    results: sortedResults,
    constraintsVerified: semanticSearchConstraintsWithEmbedding(),
  };
}

function hybridRecallConstraints(embeddingCalls: "no" | "yes"): SemanticSearchConstraints {
  return {
    ...noSemanticSearchConstraints(),
    embeddingCalls,
  };
}

function blockedHybridRecall(params: {
  checkedAt: string;
  query: string;
  limit: number;
  blockReasons: HybridRecallBlockReason[];
  semanticBlockReasons?: SemanticSearchBlockReason[];
  provider?: string | null;
  model?: string | null;
  embeddingDimensions?: number | null;
  totalIndexed?: number;
  totalVectors?: number;
  keywordReturned?: number;
  semanticReturned?: number;
  embeddingCalls?: "no" | "yes";
}): HybridRecall {
  return {
    mode: "hybrid-recall",
    checkedAt: params.checkedAt,
    status: "blocked",
    ready: false,
    query: params.query,
    limit: params.limit,
    blockReasons: [...new Set(params.blockReasons)],
    semanticBlockReasons: [...new Set(params.semanticBlockReasons ?? [])],
    provider: params.provider ?? null,
    model: params.model ?? null,
    embeddingDimensions: params.embeddingDimensions ?? null,
    totalIndexed: params.totalIndexed ?? 0,
    totalVectors: params.totalVectors ?? 0,
    keywordReturned: params.keywordReturned ?? 0,
    semanticReturned: params.semanticReturned ?? 0,
    returnedResults: 0,
    results: [],
    constraintsVerified: hybridRecallConstraints(params.embeddingCalls ?? "no"),
  };
}

function hybridItemFromKnowledgeItem(item: KnowledgeIndexItem, vectorId: string): HybridRecallItem {
  return {
    itemId: item.itemId,
    sourceType: item.sourceType,
    sourcePath: item.sourcePath,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    keywords: item.keywords,
    risk: item.risk,
    createdAt: item.createdAt,
    ...(item.status ? { status: item.status } : {}),
    ...(item.sourceCases ? { sourceCases: item.sourceCases } : {}),
    vectorId,
  };
}

function hybridItemFromSemanticItem(item: SemanticSearchResult["item"]): HybridRecallItem {
  return {
    itemId: item.itemId,
    sourceType: item.sourceType,
    sourcePath: item.sourcePath,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    keywords: item.keywords,
    risk: item.risk,
    createdAt: item.createdAt,
    ...(item.status ? { status: item.status } : {}),
    ...(item.sourceCases ? { sourceCases: item.sourceCases } : {}),
    vectorId: item.vectorId,
    embeddingTextHash: item.embeddingTextHash,
    embeddingTextLength: item.embeddingTextLength,
  };
}

function pushHybridSource(sources: HybridRecallSource[], source: HybridRecallSource): void {
  if (!sources.includes(source)) sources.push(source);
}

export async function executeHybridRecall(
  workspaceRoot: string,
  params: { query: string; limit?: number | null },
  options?: KbHttpOptions,
): Promise<HybridRecall> {
  const checkedAt = new Date().toISOString();
  const query = params.query.trim();
  const limit = normalizeSemanticSearchLimit(params.limit ?? null);
  if (!query) {
    return blockedHybridRecall({
      checkedAt,
      query,
      limit,
      blockReasons: ["query_missing"],
    });
  }

  const blockReasons: HybridRecallBlockReason[] = [];
  const keywordIndexState = await readActiveKnowledgeIndex(workspaceRoot);
  let keywordResults: KnowledgeMatchResult[] = [];
  if (keywordIndexState.status === "ready") {
    keywordResults = searchKnowledgeIndex(keywordIndexState.index, query, { limit: 20 });
  } else {
    blockReasons.push(
      keywordIndexState.status === "missing" ? "keyword_index_missing" : "keyword_index_invalid",
    );
  }

  const semantic = await executeSemanticSearch(workspaceRoot, { query, limit: 20 }, options);
  if (semantic.status !== "ready") {
    blockReasons.push("semantic_search_blocked");
  }

  type HybridRecallAccumulator = {
    item: HybridRecallItem;
    vectorId: string;
    keywordScore: number;
    semanticScore: number;
    sources: HybridRecallSource[];
    matchHits: KnowledgeMatchResult["matchHits"];
  };

  const byVectorId = new Map<string, HybridRecallAccumulator>();
  const maxKeywordScore = Math.max(0, ...keywordResults.map((result) => result.score));
  for (const result of keywordResults) {
    const vectorId = vectorIdForItem(result.item);
    const keywordScore = maxKeywordScore > 0 ? result.score / maxKeywordScore : 0;
    byVectorId.set(vectorId, {
      item: hybridItemFromKnowledgeItem(result.item, vectorId),
      vectorId,
      keywordScore,
      semanticScore: 0,
      sources: ["keyword"],
      matchHits: result.matchHits,
    });
  }

  if (semantic.status === "ready") {
    for (const result of semantic.results) {
      const existing = byVectorId.get(result.vectorId);
      const semanticScore = Math.max(0, Math.min(1, result.score));
      if (existing) {
        existing.item = hybridItemFromSemanticItem(result.item);
        existing.semanticScore = semanticScore;
        pushHybridSource(existing.sources, "semantic");
      } else {
        byVectorId.set(result.vectorId, {
          item: hybridItemFromSemanticItem(result.item),
          vectorId: result.vectorId,
          keywordScore: 0,
          semanticScore,
          sources: ["semantic"],
          matchHits: [],
        });
      }
    }
  }

  const results = [...byVectorId.values()]
    .map((result) => ({
      item: result.item,
      score: Number((result.keywordScore * 0.45 + result.semanticScore * 0.55).toFixed(6)),
      keywordScore: Number(result.keywordScore.toFixed(6)),
      semanticScore: Number(result.semanticScore.toFixed(6)),
      vectorId: result.vectorId,
      sources: result.sources,
      matchHits: result.matchHits,
    }))
    .sort((left, right) => right.score - left.score || left.vectorId.localeCompare(right.vectorId))
    .slice(0, limit);

  if (results.length === 0) {
    blockReasons.push("no_recall_results");
    return blockedHybridRecall({
      checkedAt,
      query,
      limit,
      blockReasons,
      semanticBlockReasons: semantic.blockReasons,
      provider: semantic.provider,
      model: semantic.model,
      embeddingDimensions: semantic.embeddingDimensions,
      totalIndexed: Math.max(keywordIndexState.index?.totalItems ?? 0, semantic.totalIndexed),
      totalVectors: semantic.totalVectors,
      keywordReturned: keywordResults.length,
      semanticReturned: semantic.returnedResults,
      embeddingCalls: semantic.constraintsVerified.embeddingCalls,
    });
  }

  return {
    mode: "hybrid-recall",
    checkedAt,
    status: "ready",
    ready: true,
    query,
    limit,
    blockReasons: [...new Set(blockReasons)],
    semanticBlockReasons: semantic.blockReasons,
    provider: semantic.provider,
    model: semantic.model,
    embeddingDimensions: semantic.embeddingDimensions,
    totalIndexed: Math.max(keywordIndexState.index?.totalItems ?? 0, semantic.totalIndexed),
    totalVectors: semantic.totalVectors,
    keywordReturned: keywordResults.length,
    semanticReturned: semantic.returnedResults,
    returnedResults: results.length,
    results,
    constraintsVerified: hybridRecallConstraints(semantic.constraintsVerified.embeddingCalls),
  };
}

function normalizeDispatchRecallPreviewLimit(raw: number | null | undefined): number {
  if (!Number.isFinite(raw)) return 5;
  return Math.min(10, Math.max(0, Math.floor(raw ?? 5)));
}

function normalizeDispatchRecallResultLimit(raw: number | null | undefined): number {
  if (!Number.isFinite(raw)) return 3;
  return Math.min(10, Math.max(1, Math.floor(raw ?? 3)));
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataText(task: TaskRecord | undefined, fields: string[]): string[] {
  if (!task) return [];
  return fields
    .map((field) => optionalText(task.metadata[field]))
    .filter((value): value is string => value !== null);
}

function dispatchRecallQuery(
  candidate: RuntimeLoopPreflightDispatchPlanEntry,
  task: TaskRecord | undefined,
): string {
  return [
    task?.taskId ?? candidate.taskId,
    task?.summary,
    task?.sourceRole,
    candidate.dispatchTarget,
    candidate.policyDecision,
    candidate.riskLevel,
    ...metadataText(task, ["title", "summary", "description", "intent", "goal", "task"]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function dispatchRecallPreviewConstraints(embeddingCalls: "no" | "yes") {
  return {
    stateWritten: "no" as const,
    artifactWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

function dispatchRecallHit(result: HybridRecallResult): DispatchRecallPreviewHit {
  return {
    vectorId: result.vectorId,
    score: result.score,
    keywordScore: result.keywordScore,
    semanticScore: result.semanticScore,
    sources: result.sources,
    item: {
      itemId: result.item.itemId,
      sourceType: result.item.sourceType,
      sourcePath: result.item.sourcePath,
      title: result.item.title,
      risk: result.item.risk,
      ...(result.item.status ? { status: result.item.status } : {}),
    },
  };
}

export async function executeDispatchRecallPreview(
  workspaceRoot: string,
  params: { limit?: number | null; recallLimit?: number | null } = {},
  options?: KbHttpOptions,
): Promise<DispatchRecallPreview> {
  const checkedAt = new Date().toISOString();
  const limit = normalizeDispatchRecallPreviewLimit(params.limit ?? null);
  const recallLimit = normalizeDispatchRecallResultLimit(params.recallLimit ?? null);
  const preflight = buildRuntimeLoopPreflight(workspaceRoot);
  const taskState = getTaskState(workspaceRoot);
  const tasksById = new Map(taskState.tasks.map((task) => [task.taskId, task]));
  const selectedCandidates = preflight.dispatch_plan
    .filter((entry) => entry.would_dispatch_if_apply_enabled)
    .slice(0, limit);

  const candidates: DispatchRecallPreviewCandidate[] = [];
  let embeddingCalls: "no" | "yes" = "no";
  for (const candidate of selectedCandidates) {
    const query = dispatchRecallQuery(candidate, tasksById.get(candidate.taskId));
    const recall = await executeHybridRecall(workspaceRoot, { query, limit: recallLimit }, options);
    if (recall.constraintsVerified.embeddingCalls === "yes") embeddingCalls = "yes";
    candidates.push({
      taskId: candidate.taskId,
      dispatchTarget: candidate.dispatchTarget,
      query,
      recallStatus: recall.status,
      recallReady: recall.ready,
      recallBlockReasons: recall.blockReasons,
      semanticBlockReasons: recall.semanticBlockReasons,
      returnedResults: recall.returnedResults,
      topResults: recall.results.map(dispatchRecallHit),
    });
  }

  const blockReasons: DispatchRecallPreviewBlockReason[] = candidates.some(
    (candidate) => !candidate.recallReady,
  )
    ? ["candidate_recall_blocked"]
    : [];

  return {
    mode: "dispatch-recall-preview",
    checkedAt,
    status: blockReasons.length > 0 ? "blocked" : "ready",
    ready: blockReasons.length === 0,
    blockReasons,
    warnings: selectedCandidates.length === 0 ? ["no_selected_candidates"] : [],
    preflightSummary: {
      queuedCandidates: preflight.tasks.queued_candidates,
      policyEligibleCandidates: preflight.tasks.policy_eligible_candidates,
      wouldDispatchIfApplyEnabled: preflight.tasks.would_dispatch_if_apply_enabled,
      wouldDispatch: 0,
    },
    selectedCandidateCount: selectedCandidates.length,
    previewedCandidateCount: candidates.length,
    recallLimit,
    candidates,
    constraintsVerified: dispatchRecallPreviewConstraints(embeddingCalls),
  };
}

async function writeVectorIndexSqlite(params: {
  workspaceRoot: string;
  relativePath: string;
  executedAt: string;
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>;
  provider: string;
  model: string;
  dimensions: number;
  records: SemanticRebuildVectorRecord[];
}): Promise<void> {
  const filePath = path.join(params.workspaceRoot, ...params.relativePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await rm(filePath, { force: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE vectors (
        vector_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        embedding_blob BLOB NOT NULL
      );
      CREATE INDEX vectors_item_id_idx ON vectors(item_id);
      CREATE INDEX vectors_source_path_idx ON vectors(source_path);
    `);
    const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insertMeta.run("version", "v1");
    insertMeta.run("idempotencyKey", params.executorInput.idempotencyKey);
    insertMeta.run("executedAt", params.executedAt);
    insertMeta.run("provider", params.provider);
    insertMeta.run("model", params.model);
    insertMeta.run("dimensions", String(params.dimensions));
    insertMeta.run("totalItems", String(params.records.length));
    const insertVector = db.prepare(
      `INSERT INTO vectors
        (vector_id, item_id, source_type, source_path, text_hash, dimensions, embedding_json, embedding_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    try {
      for (const record of params.records) {
        insertVector.run(
          record.vectorId,
          record.item.itemId,
          record.item.sourceType,
          record.item.sourcePath,
          record.embeddingTextHash,
          record.embedding.length,
          JSON.stringify(record.embedding),
          vectorToBlob(record.embedding),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function copyStagedFileToActive(
  workspaceRoot: string,
  stagedRelativePath: string,
  activeRelativePath: string,
): Promise<void> {
  const stagedPath = path.join(workspaceRoot, ...stagedRelativePath.split("/"));
  const activePath = path.join(workspaceRoot, ...activeRelativePath.split("/"));
  await mkdir(path.dirname(activePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(activePath),
    `.${basename(activePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await copyFile(stagedPath, tmpPath);
  await rename(tmpPath, activePath);
}

async function backupActiveFile(
  filePath: string,
): Promise<{ filePath: string; backupPath: string; existed: boolean }> {
  const backupPath = `${filePath}.${process.pid}.${Date.now()}.bak`;
  try {
    await copyFile(filePath, backupPath);
    return { filePath, backupPath, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filePath, backupPath, existed: false };
    }
    throw error;
  }
}

async function restoreActiveBackups(
  backups: Array<{ filePath: string; backupPath: string; existed: boolean }>,
): Promise<void> {
  for (const backup of backups.toReversed()) {
    if (backup.existed) {
      await copyFile(backup.backupPath, backup.filePath);
    } else {
      await rm(backup.filePath, { force: true });
    }
  }
}

async function cleanupActiveBackups(
  backups: Array<{ filePath: string; backupPath: string; existed: boolean }>,
): Promise<void> {
  for (const backup of backups) {
    await rm(backup.backupPath, { force: true });
  }
}

async function applySemanticRebuildOutputs(params: {
  workspaceRoot: string;
  executorInput: NonNullable<SemanticRebuildExecutionContract["executorInput"]>;
}): Promise<void> {
  const activeFiles = [
    params.executorInput.plannedOutputs.vectorIndexPath,
    params.executorInput.plannedOutputs.semanticIndexPath,
    params.executorInput.plannedOutputs.rebuildReportPath,
  ].map((relativePath) => path.join(params.workspaceRoot, ...relativePath.split("/")));
  const backups = await Promise.all(activeFiles.map(backupActiveFile));
  try {
    await copyStagedFileToActive(
      params.workspaceRoot,
      params.executorInput.stagedOutputs.vectorIndexPath,
      params.executorInput.plannedOutputs.vectorIndexPath,
    );
    await copyStagedFileToActive(
      params.workspaceRoot,
      params.executorInput.stagedOutputs.semanticIndexPath,
      params.executorInput.plannedOutputs.semanticIndexPath,
    );
    await copyStagedFileToActive(
      params.workspaceRoot,
      params.executorInput.stagedOutputs.rebuildReportPath,
      params.executorInput.plannedOutputs.rebuildReportPath,
    );
  } catch (error) {
    await restoreActiveBackups(backups);
    throw error;
  } finally {
    await cleanupActiveBackups(backups);
  }
}

function blockedExecutionRun(params: {
  checkedAt: string;
  stage: SemanticRebuildExecutionStageWrite;
  blockReasons: SemanticRebuildExecutionRunBlockReason[];
}): SemanticRebuildExecutionRun {
  return {
    mode: "semantic-rebuild-execution-run",
    checkedAt: params.checkedAt,
    status: "blocked",
    readyForExecution: false,
    executed: false,
    idempotentReplay: false,
    recordPath: null,
    reportPath: null,
    outputPaths: null,
    blockReasons: [...new Set(params.blockReasons)],
    stage: params.stage,
    totalItems: 0,
    batchesExecuted: 0,
    embeddingDimensions: null,
    provider: params.stage.contract.executorInput?.semantic.provider ?? null,
    model: params.stage.contract.executorInput?.semantic.model ?? null,
    report: null,
    constraintsVerified: noExecutionRunConstraints(),
  };
}

export async function executeSemanticRebuild(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildExecutionRun> {
  const checkedAt = new Date().toISOString();
  const stage = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, options);
  const executorInput = stage.contract.executorInput;
  if (!stage.readyForStagedExecution || !stage.record || !executorInput) {
    return blockedExecutionRun({
      checkedAt,
      stage,
      blockReasons: [
        ...(executorInput ? [] : ["executor_contract_not_ready" as const]),
        "staged_execution_not_ready",
        ...stage.blockReasons,
      ],
    });
  }

  const replay = await activeExecutionReportReplay(workspaceRoot, executorInput);
  if (replay) {
    return {
      mode: "semantic-rebuild-execution-run",
      checkedAt,
      status: "applied",
      readyForExecution: true,
      executed: false,
      idempotentReplay: true,
      recordPath: semanticRebuildExecutionRunRecordPath(executorInput),
      reportPath: executorInput.plannedOutputs.rebuildReportPath,
      outputPaths: executorInput.plannedOutputs,
      blockReasons: [],
      stage,
      totalItems: replay.totalItems,
      batchesExecuted: replay.batchesExecuted,
      embeddingDimensions: replay.embeddingDimensions,
      provider: replay.provider,
      model: replay.model,
      report: replay,
      constraintsVerified: noExecutionRunConstraints(),
    };
  }

  const config = options?.config ?? (options?.loadConfig ?? loadConfig)();
  const { index } = buildKnowledgeIndexFromWorkspace(workspaceRoot, checkedAt);
  if (index.totalItems !== executorInput.batchPlan.totalItems) {
    return blockedExecutionRun({ checkedAt, stage, blockReasons: ["source_index_drift"] });
  }
  const providerId = executorInput.semantic.provider;
  const model = executorInput.semantic.model;
  const preflightBlockReasons: SemanticRebuildExecutionRunBlockReason[] = [
    ...(!providerId ? (["semantic_provider_missing"] as const) : []),
    ...(!model ? (["semantic_model_missing"] as const) : []),
  ];
  const memorySearch = resolveMemorySearchConfig(config, "main");
  if (!memorySearch) {
    preflightBlockReasons.push("memory_search_disabled");
  } else if (!memorySearch.store.vector.enabled) {
    preflightBlockReasons.push("vector_store_disabled");
  }
  if (preflightBlockReasons.length > 0) {
    return blockedExecutionRun({ checkedAt, stage, blockReasons: preflightBlockReasons });
  }

  const {
    records,
    dimensions,
    provider,
    model: resolvedModel,
  } = await embedSemanticRebuildItems({
    workspaceRoot,
    config,
    executorInput,
    stageRecord: stage.record,
    index,
  });
  const reportPath = semanticRebuildExecutionRunRecordPath(executorInput);
  const report: SemanticRebuildExecutionRunReport = {
    mode: "semantic-rebuild-execution-run-report",
    executionId: semanticRebuildExecutionId(executorInput.idempotencyKey),
    idempotencyKey: executorInput.idempotencyKey,
    executedAt: checkedAt,
    status: "applied",
    provider,
    model: resolvedModel,
    totalItems: records.length,
    batchesExecuted: stage.record.manifest.batches.length,
    embeddingDimensions: dimensions,
    outputs: executorInput.plannedOutputs,
    stagedOutputs: executorInput.stagedOutputs,
    executionRecordPath: reportPath,
    constraintsVerified: appliedExecutionRunConstraints(),
  };
  const semanticIndex = buildSemanticIndex({
    executedAt: checkedAt,
    executorInput,
    index,
    records,
    dimensions,
    provider,
    model: resolvedModel,
  });

  await writeJsonFile(workspaceRoot, executorInput.stagedOutputs.semanticIndexPath, semanticIndex);
  await writeVectorIndexSqlite({
    workspaceRoot,
    relativePath: executorInput.stagedOutputs.vectorIndexPath,
    executedAt: checkedAt,
    executorInput,
    provider,
    model: resolvedModel,
    dimensions,
    records,
  });
  await writeJsonFile(workspaceRoot, executorInput.stagedOutputs.rebuildReportPath, report);
  await applySemanticRebuildOutputs({ workspaceRoot, executorInput });
  await writeJsonFile(workspaceRoot, reportPath, report);

  return {
    mode: "semantic-rebuild-execution-run",
    checkedAt,
    status: "applied",
    readyForExecution: true,
    executed: true,
    idempotentReplay: false,
    recordPath: reportPath,
    reportPath: executorInput.plannedOutputs.rebuildReportPath,
    outputPaths: executorInput.plannedOutputs,
    blockReasons: [],
    stage,
    totalItems: records.length,
    batchesExecuted: stage.record.manifest.batches.length,
    embeddingDimensions: dimensions,
    provider,
    model: resolvedModel,
    report,
    constraintsVerified: appliedExecutionRunConstraints(),
  };
}

function resolveSemanticRebuildStatusStage(
  latestPlan: { reportPath: string; plan: KnowledgeSemanticRebuildPlan } | null,
  acceptance: SemanticRebuildProposalAcceptance,
  preflight: SemanticRebuildPreflight,
  executionDryRun: SemanticRebuildExecutionDryRun,
  approvalRecords: SemanticRebuildApprovalRecordList,
  executionEntry: SemanticRebuildExecutionEntry,
): SemanticRebuildStatusStage {
  if (!latestPlan) return "plan_missing";
  if (!acceptance.readyForHumanGate) return "acceptance_blocked";
  if (!preflight.readyForRebuildHumanApproval) return "preflight_blocked";
  if (!executionDryRun.readyForExecutionHumanGate) return "execution_dry_run_blocked";
  if (!approvalRecords.latestRecord) return "rebuild_approval_required";
  if (executionEntry.readyForRealRebuildImplementation) {
    return "ready_for_real_rebuild_implementation";
  }
  return "blocked";
}

export async function getSemanticRebuildStatus(
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<SemanticRebuildStatus> {
  const checkedAt = new Date().toISOString();
  const latestPlan = await readLatestSemanticRebuildPlanReportEntry(workspaceRoot);
  const acceptance = await checkSemanticRebuildProposalAcceptance(workspaceRoot, options);
  const acceptanceRecords = await listSemanticRebuildAcceptanceRecords(workspaceRoot);
  const preflight = await checkSemanticRebuildPreflight(workspaceRoot, options);
  const executionDryRun = await buildSemanticRebuildExecutionDryRun(workspaceRoot, options);
  const approvalRecords = await listSemanticRebuildApprovalRecords(workspaceRoot);
  const executionEntry = await checkSemanticRebuildExecutionEntry(workspaceRoot, options);
  const stage = resolveSemanticRebuildStatusStage(
    latestPlan,
    acceptance,
    preflight,
    executionDryRun,
    approvalRecords,
    executionEntry,
  );

  return {
    available: latestPlan !== null,
    mode: "semantic-rebuild-status",
    checkedAt,
    stage,
    status: executionEntry.status,
    nextAction: executionEntry.nextAction,
    plan: {
      available: latestPlan !== null,
      reportPath: latestPlan?.reportPath ?? null,
      proposalId: latestPlan ? proposalIdForSemanticRebuildPlan(latestPlan.plan) : null,
      status: latestPlan?.plan.status ?? null,
      generatedAt: latestPlan?.plan.generatedAt ?? null,
      totalItems: latestPlan?.plan.source.totalItems ?? null,
      plannedBatches: latestPlan?.plan.plannedBatches ?? null,
    },
    acceptance: {
      status: acceptance.status,
      readyForHumanGate: acceptance.readyForHumanGate,
      blockReasons: acceptance.blockReasons,
      proposalPath: acceptance.proposalPath,
    },
    acceptanceRecords: {
      available: acceptanceRecords.available,
      totalRecords: acceptanceRecords.totalRecords,
      returnedRecords: acceptanceRecords.returnedRecords,
      invalidRecords: acceptanceRecords.invalidRecords,
      latestRecord: acceptanceRecords.records[0] ?? null,
    },
    preflight: {
      status: preflight.status,
      readyForRebuildHumanApproval: preflight.readyForRebuildHumanApproval,
      blockReasons: preflight.blockReasons,
      recordPath: preflight.recordPath,
    },
    executionDryRun: {
      status: executionDryRun.status,
      readyForExecutionHumanGate: executionDryRun.readyForExecutionHumanGate,
      blockReasons: executionDryRun.blockReasons,
      wouldExecute: executionDryRun.wouldExecute,
    },
    approvalRecords: {
      available: approvalRecords.available,
      totalRecords: approvalRecords.totalRecords,
      returnedRecords: approvalRecords.returnedRecords,
      invalidRecords: approvalRecords.invalidRecords,
      latestRecord: approvalRecords.latestRecord,
    },
    executionEntry: {
      status: executionEntry.status,
      readyForRealRebuildImplementation: executionEntry.readyForRealRebuildImplementation,
      blockReasons: executionEntry.blockReasons,
      wouldExecute: executionEntry.wouldExecute,
      executed: executionEntry.executed,
      nextAction: executionEntry.nextAction,
    },
    constraintsVerified: preflightConstraints(),
  };
}

export function isKbApiPath(pathname: string): boolean {
  return (
    pathname === KB_STATE_ROUTE ||
    pathname === KB_REFRESH_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_STATE_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_STATUS_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PLAN_ACCEPTANCE_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_ACCEPTANCE_RECORDS_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_PREFLIGHT_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_DRY_RUN_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_APPROVAL_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_APPROVAL_RECORDS_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_EXECUTION_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_EXECUTION_CONTRACT_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_EXECUTION_STAGE_ROUTE ||
    pathname === KB_SEMANTIC_REBUILD_EXECUTION_RUN_ROUTE ||
    pathname === KB_SEMANTIC_SEARCH_ROUTE ||
    pathname === KB_HYBRID_RECALL_ROUTE ||
    pathname === KB_DISPATCH_RECALL_PREVIEW_ROUTE
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

  if (requestPath === KB_SEMANTIC_REBUILD_PLAN_STATUS_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await getSemanticRebuildStatus(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "semantic-rebuild-status",
        status: "blocked",
        stage: "blocked",
        error: `KB semantic rebuild status read failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: preflightConstraints(),
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

  if (requestPath === KB_SEMANTIC_REBUILD_APPROVAL_RECORDS_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await listSemanticRebuildApprovalRecords(workspaceRoot));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "rebuild-approval-record-list",
        error: `KB semantic rebuild approval records read failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: {
          fileWrites: "no",
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

  if (requestPath === KB_SEMANTIC_REBUILD_EXECUTION_ROUTE) {
    if (req.method !== "GET" && req.method !== "POST") {
      sendMethodNotAllowed(res, "GET, POST");
      return true;
    }

    try {
      sendJson(
        res,
        200,
        await checkSemanticRebuildExecutionEntry(workspaceRoot, options, req.method),
      );
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "semantic-rebuild-execution-entry",
        status: "blocked",
        wouldExecute: false,
        executed: false,
        readyForRealRebuildImplementation: false,
        error: `KB semantic rebuild execution entry failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: preflightConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_EXECUTION_CONTRACT_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      sendJson(res, 200, await buildSemanticRebuildExecutionContract(workspaceRoot, options));
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        mode: "semantic-rebuild-execution-contract",
        status: "blocked",
        readyForExecutorContract: false,
        wouldExecute: false,
        executed: false,
        executorInput: null,
        error: `KB semantic rebuild execution contract failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: preflightConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_EXECUTION_STAGE_ROUTE) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    try {
      const result = await writeSemanticRebuildExecutionStageRecord(workspaceRoot, options);
      sendJson(res, result.wrote ? 201 : result.idempotentReplay ? 200 : 409, result);
    } catch (error) {
      sendJson(res, 500, {
        mode: "semantic-rebuild-execution-stage-write",
        status: "blocked",
        readyForStagedExecution: false,
        wrote: false,
        idempotentReplay: false,
        recordPath: null,
        manifestPath: null,
        blockReasons: ["executor_contract_not_ready"],
        record: null,
        error: `KB semantic rebuild execution stage failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: executionStageConstraints("no"),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_EXECUTION_RUN_ROUTE) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    try {
      const result = await executeSemanticRebuild(workspaceRoot, options);
      sendJson(
        res,
        result.status === "applied" ? (result.idempotentReplay ? 200 : 201) : 409,
        result,
      );
    } catch (error) {
      sendJson(res, 500, {
        mode: "semantic-rebuild-execution-run",
        status: "blocked",
        readyForExecution: false,
        executed: false,
        idempotentReplay: false,
        recordPath: null,
        reportPath: null,
        outputPaths: null,
        blockReasons: ["embedding_provider_unavailable"],
        error: `KB semantic rebuild execution failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: noExecutionRunConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_SEARCH_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const url = resolveRequestUrl(req);
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const result = await executeSemanticSearch(
        workspaceRoot,
        {
          query,
          limit: rawLimit ? Number.parseInt(rawLimit, 10) : null,
        },
        options,
      );
      sendJson(
        res,
        result.status === "ready" ? 200 : result.blockReasons.includes("query_missing") ? 400 : 409,
        result,
      );
    } catch (error) {
      sendJson(res, 500, {
        mode: "semantic-search",
        status: "blocked",
        ready: false,
        error: `KB semantic search failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: noSemanticSearchConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_HYBRID_RECALL_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const url = resolveRequestUrl(req);
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const result = await executeHybridRecall(
        workspaceRoot,
        {
          query,
          limit: rawLimit ? Number.parseInt(rawLimit, 10) : null,
        },
        options,
      );
      sendJson(
        res,
        result.status === "ready" ? 200 : result.blockReasons.includes("query_missing") ? 400 : 409,
        result,
      );
    } catch (error) {
      sendJson(res, 500, {
        mode: "hybrid-recall",
        status: "blocked",
        ready: false,
        error: `KB hybrid recall failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: noSemanticSearchConstraints(),
      });
    }
    return true;
  }

  if (requestPath === KB_DISPATCH_RECALL_PREVIEW_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const url = resolveRequestUrl(req);
      const rawLimit = url.searchParams.get("limit");
      const rawRecallLimit = url.searchParams.get("recallLimit");
      const result = await executeDispatchRecallPreview(
        workspaceRoot,
        {
          limit: rawLimit ? Number.parseInt(rawLimit, 10) : null,
          recallLimit: rawRecallLimit ? Number.parseInt(rawRecallLimit, 10) : null,
        },
        options,
      );
      sendJson(res, result.status === "ready" ? 200 : 409, result);
    } catch (error) {
      sendJson(res, 500, {
        mode: "dispatch-recall-preview",
        status: "blocked",
        ready: false,
        error: `KB dispatch recall preview failed: ${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: dispatchRecallPreviewConstraints("no"),
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
