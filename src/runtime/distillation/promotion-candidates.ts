import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PROMOTION_CANDIDATES_RELATIVE_PATH = "evolution/promotion-candidates.json";
export const PROMOTION_CANDIDATE_GATE_STATE_RELATIVE_PATH = "evolution/candidate-gate-state.json";

const ALLOWED_APPLY_TARGETS = new Set(["NEXT_ACTION.md", "RISKS.md", "MEMORY.md", "OPEN_LOOPS.md"]);
const VALID_RISKS = new Set(["low", "medium", "high"]);

type JsonRecord = Record<string, unknown>;

export type PromotionCandidateLifecycle =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "rolledback"
  | "invalid";

export type PromotionCandidateConsistency =
  | "ok"
  | "orphan-state"
  | "orphan-write"
  | "target-missing"
  | "target-not-allowed"
  | "invalid";

export interface PromotionCandidateSummary {
  index: number;
  targetFile: string | null;
  changeType: string | null;
  risk: string | null;
  state: PromotionCandidateLifecycle;
  consistency: PromotionCandidateConsistency;
  approvedAt: string | null;
  rejectedAt: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  rejectReason: string | null;
  checks: {
    targetAllowed: boolean;
    validRisk: boolean;
    appendOnly: boolean;
    singleLineHtmlComment: boolean;
    lowRiskApplyEligible: boolean;
    exactSnippetPresent: boolean | null;
  };
  blockers: string[];
}

export interface PromotionCandidatesScan {
  available: boolean;
  status: "ok" | "missing" | "error";
  workspaceRoot: string;
  sourceFile: string;
  stateFile: string;
  generatedAt: string | null;
  lastSyncedAt: string | null;
  stats: {
    total: number;
    byState: Record<string, number>;
    byRisk: Record<string, number>;
    byConsistency: Record<string, number>;
    invalid: number;
    safeApplyEligible: number;
  };
  candidates: PromotionCandidateSummary[];
  constraintsVerified: {
    readOnly: "yes";
    candidateStateWritten: "no";
    truthFilesWritten: "no";
    applied: "none";
    rolledBack: "none";
    autoPromote: "disabled";
  };
  errors: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function boolish(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== "";
}

function readJsonRecord(filePath: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`JSON root is not an object: ${filePath}`);
  }
  return parsed;
}

function readOptionalJsonRecord(filePath: string): {
  data: JsonRecord | null;
  error: string | null;
} {
  if (!existsSync(filePath)) return { data: null, error: null };
  try {
    return { data: readJsonRecord(filePath), error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function lifecycle(state: JsonRecord | null): PromotionCandidateLifecycle {
  if (!state) return "pending";
  if (boolish(state.rolledBackAt)) return "rolledback";
  if (boolish(state.appliedAt)) return "applied";
  if (boolish(state.rejectedAt)) return "rejected";
  if (boolish(state.approvedAt) || boolish(state.humanApprovedAt)) return "approved";
  return "pending";
}

function targetContainsExactLine(
  workspaceRoot: string,
  targetFile: string,
  line: string,
): boolean | null {
  const targetPath = path.join(workspaceRoot, targetFile);
  if (!existsSync(targetPath)) return null;
  const normalizedLine = line.trimEnd();
  return readFileSync(targetPath, "utf8")
    .split(/\r?\n/u)
    .some((candidateLine) => candidateLine === normalizedLine);
}

function buildStateByIndex(stateFile: JsonRecord | null): Map<number, JsonRecord> {
  const stateByIndex = new Map<number, JsonRecord>();
  for (const state of asRecords(stateFile?.candidates)) {
    const index = typeof state.index === "number" ? state.index : Number(state.index);
    if (Number.isInteger(index) && index >= 0) {
      stateByIndex.set(index, state);
    }
  }
  return stateByIndex;
}

function summarizeCandidate(params: {
  workspaceRoot: string;
  index: number;
  candidate: JsonRecord;
  state: JsonRecord | null;
}): PromotionCandidateSummary {
  const { workspaceRoot, index, candidate, state } = params;
  const targetFile = stringValue(candidate.targetFile);
  const changeType = stringValue(candidate.changeType);
  const risk = stringValue(candidate.risk)?.toLowerCase() ?? null;
  const proposedSnippet = stringValue(candidate.proposedSnippet);
  const targetAllowed = Boolean(targetFile && ALLOWED_APPLY_TARGETS.has(targetFile));
  const validRisk = Boolean(risk && VALID_RISKS.has(risk));
  const appendOnly = Boolean(changeType?.startsWith("append_"));
  const singleLineHtmlComment = Boolean(
    proposedSnippet &&
    !/[\r\n]/u.test(proposedSnippet) &&
    proposedSnippet.startsWith("<!--") &&
    proposedSnippet.endsWith("-->"),
  );
  const stateName = lifecycle(state);
  const exactSnippetPresent =
    targetFile && proposedSnippet && targetAllowed
      ? targetContainsExactLine(workspaceRoot, targetFile, proposedSnippet)
      : null;
  const lowRiskApplyEligible =
    targetAllowed && validRisk && risk === "low" && appendOnly && singleLineHtmlComment;
  const blockers: string[] = [];
  if (!targetFile) blockers.push("missing_target_file");
  if (!targetAllowed) blockers.push("target_not_allowed");
  if (!validRisk) blockers.push("invalid_risk");
  if (!appendOnly) blockers.push("change_type_not_append_only");
  if (!singleLineHtmlComment) blockers.push("snippet_not_single_line_html_comment");

  let consistency: PromotionCandidateConsistency = "ok";
  if (blockers.length > 0) {
    consistency = "invalid";
  } else if (!targetAllowed) {
    consistency = "target-not-allowed";
  } else if (exactSnippetPresent === null) {
    consistency = "target-missing";
  } else {
    const appliedState = stateName === "applied";
    if (appliedState && !exactSnippetPresent) {
      consistency = "orphan-state";
    } else if (!appliedState && exactSnippetPresent) {
      consistency = "orphan-write";
    }
  }

  return {
    index,
    targetFile,
    changeType,
    risk,
    state: blockers.length > 0 ? "invalid" : stateName,
    consistency,
    approvedAt: stringValue(state?.approvedAt) ?? stringValue(state?.humanApprovedAt),
    rejectedAt: stringValue(state?.rejectedAt),
    appliedAt: stringValue(state?.appliedAt),
    rolledBackAt: stringValue(state?.rolledBackAt),
    rejectReason: stringValue(state?.rejectReason),
    checks: {
      targetAllowed,
      validRisk,
      appendOnly,
      singleLineHtmlComment,
      lowRiskApplyEligible,
      exactSnippetPresent,
    },
    blockers: [...new Set(blockers)],
  };
}

function emptyScan(
  workspaceRoot: string,
  status: PromotionCandidatesScan["status"],
): PromotionCandidatesScan {
  return {
    available: false,
    status,
    workspaceRoot,
    sourceFile: PROMOTION_CANDIDATES_RELATIVE_PATH,
    stateFile: PROMOTION_CANDIDATE_GATE_STATE_RELATIVE_PATH,
    generatedAt: null,
    lastSyncedAt: null,
    stats: {
      total: 0,
      byState: {},
      byRisk: {},
      byConsistency: {},
      invalid: 0,
      safeApplyEligible: 0,
    },
    candidates: [],
    constraintsVerified: {
      readOnly: "yes",
      candidateStateWritten: "no",
      truthFilesWritten: "no",
      applied: "none",
      rolledBack: "none",
      autoPromote: "disabled",
    },
    errors: [],
  };
}

export function scanPromotionCandidates(workspaceRoot: string): PromotionCandidatesScan {
  const candidatesPath = path.join(workspaceRoot, PROMOTION_CANDIDATES_RELATIVE_PATH);
  if (!existsSync(candidatesPath)) {
    return emptyScan(workspaceRoot, "missing");
  }

  let candidatesFile: JsonRecord;
  try {
    candidatesFile = readJsonRecord(candidatesPath);
  } catch (error) {
    const scan = emptyScan(workspaceRoot, "error");
    scan.errors.push(error instanceof Error ? error.message : String(error));
    return scan;
  }

  const statePath = path.join(workspaceRoot, PROMOTION_CANDIDATE_GATE_STATE_RELATIVE_PATH);
  const stateRead = readOptionalJsonRecord(statePath);
  const errors = stateRead.error ? [`Candidate gate state read failed: ${stateRead.error}`] : [];
  const stateByIndex = buildStateByIndex(stateRead.data);
  const candidates = asRecords(candidatesFile.candidates).map((candidate, index) =>
    summarizeCandidate({
      workspaceRoot,
      index,
      candidate,
      state: stateByIndex.get(index) ?? null,
    }),
  );

  const stats = candidates.reduce<PromotionCandidatesScan["stats"]>(
    (acc, candidate) => {
      acc.total += 1;
      acc.byState[candidate.state] = (acc.byState[candidate.state] ?? 0) + 1;
      acc.byConsistency[candidate.consistency] =
        (acc.byConsistency[candidate.consistency] ?? 0) + 1;
      if (candidate.risk) acc.byRisk[candidate.risk] = (acc.byRisk[candidate.risk] ?? 0) + 1;
      if (candidate.state === "invalid") acc.invalid += 1;
      if (candidate.checks.lowRiskApplyEligible) acc.safeApplyEligible += 1;
      return acc;
    },
    {
      total: 0,
      byState: {},
      byRisk: {},
      byConsistency: {},
      invalid: 0,
      safeApplyEligible: 0,
    },
  );

  return {
    available: true,
    status: errors.length > 0 ? "error" : "ok",
    workspaceRoot,
    sourceFile: PROMOTION_CANDIDATES_RELATIVE_PATH,
    stateFile: PROMOTION_CANDIDATE_GATE_STATE_RELATIVE_PATH,
    generatedAt: stringValue(candidatesFile.generatedAt),
    lastSyncedAt: stringValue(stateRead.data?.lastSyncedAt),
    stats,
    candidates,
    constraintsVerified: {
      readOnly: "yes",
      candidateStateWritten: "no",
      truthFilesWritten: "no",
      applied: "none",
      rolledBack: "none",
      autoPromote: "disabled",
    },
    errors,
  };
}
