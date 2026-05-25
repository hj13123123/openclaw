import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const DISTILL_CANDIDATES_RELATIVE_PATH = "runtime/main/tmp/distill-candidates";
export const REVIEW_CANDIDATES_RELATIVE_PATH = "runtime/main/tmp/review-candidates";
export const PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH = "runtime/main/tmp";
export const PROMOTE_GATE_REPORT_FILE_PREFIX = "d9-promote-gate-dryrun-";
export const PROMOTE_GATE_REPORT_FILE_SUFFIX = ".json";

const ALLOWED_CANDIDATE_TYPES = new Set([
  "skill",
  "rule",
  "memory",
  "engineering_rule",
  "checklist",
]);

type JsonRecord = Record<string, unknown>;

export interface PromoteGateSourceRef {
  sourceType: string | null;
  sourceId: string | null;
}

export interface PromoteGateCheck {
  name: string;
  pass: boolean;
  value?: unknown;
  minimum?: number;
  total?: number;
  sources?: PromoteGateSourceCheck[];
  reviewId?: string | null;
  reviewStatus?: string | null;
  verdict?: string | null;
  frozenActive?: boolean;
}

export interface PromoteGateSourceCheck extends PromoteGateSourceRef {
  pass: boolean;
  path: string | null;
  reason: string | null;
}

export interface PromoteGateCandidatePlan {
  candidatePath: string;
  reviewPath: string | null;
  candidateId: string;
  candidateType: string;
  title: string | null;
  reviewId: string | null;
  verdict:
    | "READY_FOR_PROMOTE_GATE"
    | "WAITING_REVIEW"
    | "NEEDS_EVIDENCE"
    | "FROZEN_BLOCKED"
    | "BLOCKED"
    | "ROUTE_D1_CONTROLLED_APPLY"
    | "WAITING_SEPARATE_ENGINEERING_RULE_APPROVAL";
  promoteTarget: string;
  requiredGate: string;
  blockers: string[];
  warnings: string[];
  checks: PromoteGateCheck[];
  dryRunAction: "NO_WRITE_NO_PROMOTE";
}

export interface PromoteGateDryRunReport {
  taskId: "DOMAIN9-L2-L3-AUTO-DISTILL-PROMOTE-RUNTIME-A";
  generatedAt: string;
  status: "PASS";
  mode: "dry-run";
  workspaceRoot: string;
  frozenActive: boolean;
  candidatesDir: string;
  reviewsDir: string;
  outputFile: string | null;
  stats: {
    total: number;
    byVerdict: Record<string, number>;
    byType: Record<string, number>;
  };
  plans: PromoteGateCandidatePlan[];
  constraintsVerified: {
    MEMORYWritten: "no";
    ENGINEERING_RULESWritten: "no";
    skillLibraryWritten: "no";
    caseLibraryWritten: "no";
    appliedLogWritten: "no";
    promoted: "none";
    autoPromote: "disabled";
  };
  verdict: "PASS / D9 PROMOTE GATE DRY-RUN COMPLETE / NO PROMOTION PERFORMED";
}

export interface PromoteGateDryRunOptions {
  generatedAt?: string;
  outputPath?: string | null;
}

export type PromoteGateStateSummary =
  | {
      available: false;
      reportDir: string;
      reportPath?: string;
      error?: string;
    }
  | ({
      available: true;
      reportPath: string;
    } & ReturnType<typeof summarizePromoteGateDryRun>);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function readJson(filePath: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`JSON root is not an object: ${filePath}`);
  }
  return parsed;
}

function listJsonFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
}

export function listPromoteGateReportFiles(workspaceRoot: string): string[] {
  const reportDir = path.join(workspaceRoot, PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(PROMOTE_GATE_REPORT_FILE_PREFIX) &&
        entry.name.endsWith(PROMOTE_GATE_REPORT_FILE_SUFFIX),
    )
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function detectFrozen(workspaceRoot: string): boolean {
  const texts = ["HEARTBEAT.md", "SESSION_SUMMARY.md"]
    .map((name) => path.join(workspaceRoot, name))
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => readFileSync(filePath, "utf8").toLowerCase());
  return /runtime frozen|auto-progression.*frozen|auto-chain.*frozen|auto-evolution.*frozen/u.test(
    texts.join("\n"),
  );
}

function sourceExists(workspaceRoot: string, source: unknown): PromoteGateSourceCheck {
  const record = isRecord(source) ? source : {};
  const sourceType = stringValue(record.sourceType);
  const sourceId = stringValue(record.sourceId);
  if (!sourceType || !sourceId) {
    return { sourceType, sourceId, pass: false, path: null, reason: "missing sourceType/sourceId" };
  }

  if (sourceType === "case") {
    const filePath = path.join(workspaceRoot, "system", "case-library", `${sourceId}.json`);
    return {
      sourceType,
      sourceId,
      pass: existsSync(filePath),
      path: relativePath(workspaceRoot, filePath),
      reason: null,
    };
  }

  if (sourceType === "skill") {
    const filePath = path.join(workspaceRoot, "system", "skill-library", `${sourceId}.json`);
    return {
      sourceType,
      sourceId,
      pass: existsSync(filePath),
      path: relativePath(workspaceRoot, filePath),
      reason: null,
    };
  }

  if (sourceType === "acceptance") {
    const candidates = [
      path.join(workspaceRoot, "acceptance-reports", `${sourceId}.md`),
      path.join(workspaceRoot, "acceptance-reports", `${sourceId}.json`),
    ];
    const matched = candidates.find((candidate) => existsSync(candidate));
    return {
      sourceType,
      sourceId,
      pass: Boolean(matched),
      path: relativePath(workspaceRoot, matched ?? candidates[0]!),
      reason: matched ? null : "acceptance report not found",
    };
  }

  if (sourceType === "return") {
    const processedDir = path.join(workspaceRoot, "system", "returns", "processed");
    const normalized = sourceId.replace(/^processed[\\/]/u, "");
    const exact = path.join(processedDir, `${normalized}.json`);
    const matched = existsSync(exact)
      ? exact
      : listJsonFiles(processedDir).find((filePath) =>
          path.basename(filePath, ".json").startsWith(normalized),
        );
    return {
      sourceType,
      sourceId,
      pass: Boolean(matched),
      path: relativePath(workspaceRoot, matched ?? exact),
      reason: matched ? null : "processed return not found",
    };
  }

  if (sourceType === "open_loop") {
    const filePath = path.join(workspaceRoot, "OPEN_LOOPS.md");
    return {
      sourceType,
      sourceId,
      pass: existsSync(filePath),
      path: relativePath(workspaceRoot, filePath),
      reason: null,
    };
  }

  return {
    sourceType,
    sourceId,
    pass: false,
    path: null,
    reason: `unsupported sourceType: ${sourceType}`,
  };
}

function resolvePromoteTarget(candidateType: string): {
  promoteTarget: string;
  requiredGate: string;
  warnings: string[];
} {
  if (candidateType === "memory") {
    return {
      promoteTarget: "D1 controlled apply candidate",
      requiredGate: "D1_CONTROLLED_APPLY_REQUIRED",
      warnings: [
        "memory candidates must be routed to D1 controlled apply; no direct MEMORY.md write",
      ],
    };
  }
  if (candidateType === "engineering_rule") {
    return {
      promoteTarget: "ENGINEERING_RULES.md proposal",
      requiredGate: "SEPARATE_ENGINEERING_RULE_APPROVAL_REQUIRED",
      warnings: [
        "engineering_rule candidates require separate explicit approval; no direct ENGINEERING_RULES.md write",
      ],
    };
  }
  if (candidateType === "skill" || candidateType === "rule" || candidateType === "checklist") {
    return {
      promoteTarget: "system/skill-library",
      requiredGate: "human_review_then_library_write",
      warnings: [],
    };
  }
  return { promoteTarget: "none", requiredGate: "human_review", warnings: [] };
}

function confidenceMinimum(candidateType: string): number {
  if (candidateType === "engineering_rule") return 0.85;
  if (candidateType === "skill") return 0.75;
  return 0.8;
}

function evaluateCandidate(params: {
  candidate: JsonRecord;
  candidatePath: string;
  review: JsonRecord | null;
  reviewPath: string | null;
  workspaceRoot: string;
  frozenActive: boolean;
}): PromoteGateCandidatePlan {
  const { candidate, review, workspaceRoot, frozenActive } = params;
  const checks: PromoteGateCheck[] = [];
  const blockers: string[] = [];
  const candidateId = stringValue(candidate.candidateId) ?? "unknown";
  const candidateType = stringValue(candidate.candidateType) ?? "unknown";

  checks.push({ name: "candidateId_present", pass: candidateId !== "unknown" });
  checks.push({
    name: "candidateType_allowed",
    pass: ALLOWED_CANDIDATE_TYPES.has(candidateType),
    value: candidateType,
  });
  checks.push({
    name: "review_exists",
    pass: Boolean(review),
    reviewId: stringValue(review?.reviewId),
  });

  if (candidateId === "unknown") blockers.push("missing_candidate_id");
  if (!ALLOWED_CANDIDATE_TYPES.has(candidateType)) blockers.push("unsupported_candidate_type");
  if (!review) blockers.push("missing_review_candidate");

  const gates = isRecord(candidate.gates) ? candidate.gates : {};
  for (const gateName of [
    "duplicateCheck",
    "conflictCheck",
    "minimumOccurrence",
    "confidenceThreshold",
  ]) {
    const value = stringValue(gates[gateName]);
    const pass = value === "passed";
    checks.push({ name: `candidate_gate_${gateName}`, pass, value });
    if (!pass) blockers.push(`candidate_gate_failed:${gateName}`);
  }

  const confidence = numberValue(candidate.confidence);
  const minConfidence = confidenceMinimum(candidateType);
  const confidencePass = confidence !== null && confidence >= minConfidence;
  checks.push({
    name: "confidence_minimum",
    pass: confidencePass,
    value: confidence,
    minimum: minConfidence,
  });
  if (!confidencePass) blockers.push("confidence_below_runtime_threshold");

  const occurrenceCount = numberValue(candidate.occurrenceCount);
  const occurrencePass = occurrenceCount !== null && occurrenceCount >= 2;
  checks.push({
    name: "occurrence_minimum",
    pass: occurrencePass,
    value: occurrenceCount,
    minimum: 2,
  });
  if (!occurrencePass) blockers.push("occurrence_below_minimum");

  const sourceResults = Array.isArray(candidate.sources)
    ? candidate.sources.map((source) => sourceExists(workspaceRoot, source))
    : [];
  const sourcePass = sourceResults.length > 0 && sourceResults.every((result) => result.pass);
  checks.push({
    name: "sources_resolvable",
    pass: sourcePass,
    total: sourceResults.length,
    sources: sourceResults,
  });
  if (!sourcePass) blockers.push("source_resolution_failed");

  if (review) {
    const checklist = isRecord(review.checklistResults) ? review.checklistResults : {};
    for (const item of [
      "evidenceSufficient",
      "noDuplicate",
      "noConflict",
      "notOverfit",
      "noPrivilegeExpansion",
    ]) {
      const pass = checklist[item] === true;
      checks.push({ name: `review_check_${item}`, pass, value: checklist[item] ?? null });
      if (!pass) blockers.push(`review_check_failed:${item}`);
    }

    const needsMoreEvidencePass = checklist.needsMoreEvidence === false;
    checks.push({
      name: "review_check_needsMoreEvidence_false",
      pass: needsMoreEvidencePass,
      value: checklist.needsMoreEvidence ?? null,
    });
    if (!needsMoreEvidencePass) blockers.push("review_needs_more_evidence");

    const noTruthFileTouch = checklist.noTruthFileTouch === true;
    checks.push({
      name: "review_check_noTruthFileTouch",
      pass: noTruthFileTouch,
      value: checklist.noTruthFileTouch ?? null,
    });
    if (!noTruthFileTouch && candidateType !== "memory")
      blockers.push("truth_file_touch_not_allowed_for_type");

    const reviewApproved =
      ["approved", "accepted"].includes((stringValue(review.reviewStatus) ?? "").toLowerCase()) ||
      ["approved", "approve", "accepted"].includes(
        (stringValue(review.verdict) ?? "").toLowerCase(),
      );
    checks.push({
      name: "review_approved",
      pass: reviewApproved,
      reviewStatus: stringValue(review.reviewStatus),
      verdict: stringValue(review.verdict),
    });
    if (!reviewApproved) blockers.push("waiting_for_human_review_approval");
  }

  if (frozenActive) {
    checks.push({ name: "frozen_blocks_auto_promote", pass: true, frozenActive });
    blockers.push("frozen_active_no_auto_promote");
  }

  const target = resolvePromoteTarget(candidateType);
  let verdict: PromoteGateCandidatePlan["verdict"] = "READY_FOR_PROMOTE_GATE";
  if (
    blockers.includes("waiting_for_human_review_approval") ||
    blockers.includes("missing_review_candidate")
  )
    verdict = "WAITING_REVIEW";
  if (
    blockers.includes("review_needs_more_evidence") ||
    blockers.includes("confidence_below_runtime_threshold")
  )
    verdict = "NEEDS_EVIDENCE";
  if (blockers.includes("frozen_active_no_auto_promote")) verdict = "FROZEN_BLOCKED";
  if (
    blockers.some(
      (blocker) =>
        blocker === "unsupported_candidate_type" ||
        blocker === "missing_candidate_id" ||
        blocker === "source_resolution_failed" ||
        blocker === "truth_file_touch_not_allowed_for_type" ||
        blocker.startsWith("candidate_gate_failed") ||
        blocker.startsWith("review_check_failed"),
    )
  ) {
    verdict = "BLOCKED";
  }
  if (blockers.length === 0 && candidateType === "memory") verdict = "ROUTE_D1_CONTROLLED_APPLY";
  if (blockers.length === 0 && candidateType === "engineering_rule")
    verdict = "WAITING_SEPARATE_ENGINEERING_RULE_APPROVAL";

  return {
    candidatePath: params.candidatePath,
    reviewPath: params.reviewPath,
    candidateId,
    candidateType,
    title: stringValue(candidate.title),
    reviewId: stringValue(review?.reviewId),
    verdict,
    promoteTarget: target.promoteTarget,
    requiredGate: target.requiredGate,
    blockers: [...new Set(blockers)],
    warnings: target.warnings,
    checks,
    dryRunAction: "NO_WRITE_NO_PROMOTE",
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function runPromoteGateDryRun(
  workspaceRoot: string,
  options: PromoteGateDryRunOptions = {},
): PromoteGateDryRunReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const distillDir = path.join(workspaceRoot, DISTILL_CANDIDATES_RELATIVE_PATH);
  const reviewDir = path.join(workspaceRoot, REVIEW_CANDIDATES_RELATIVE_PATH);
  const outputFile =
    options.outputPath === undefined
      ? path.join(
          workspaceRoot,
          PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH,
          `d9-promote-gate-dryrun-${generatedAt.replace(/[:.]/gu, "-")}.json`,
        )
      : options.outputPath;
  const reviewByCandidateId = new Map(
    listJsonFiles(reviewDir).map((filePath) => {
      const review = readJson(filePath);
      return [stringValue(review.candidateId) ?? "", { filePath, review }] as const;
    }),
  );
  const frozenActive = detectFrozen(workspaceRoot);
  const plans = listJsonFiles(distillDir).map((filePath) => {
    const candidate = readJson(filePath);
    const reviewMatch = reviewByCandidateId.get(stringValue(candidate.candidateId) ?? "");
    return evaluateCandidate({
      candidate,
      candidatePath: relativePath(workspaceRoot, filePath),
      review: reviewMatch?.review ?? null,
      reviewPath: reviewMatch ? relativePath(workspaceRoot, reviewMatch.filePath) : null,
      workspaceRoot,
      frozenActive,
    });
  });
  const stats = plans.reduce<PromoteGateDryRunReport["stats"]>(
    (acc, plan) => {
      acc.total += 1;
      acc.byVerdict[plan.verdict] = (acc.byVerdict[plan.verdict] ?? 0) + 1;
      acc.byType[plan.candidateType] = (acc.byType[plan.candidateType] ?? 0) + 1;
      return acc;
    },
    { total: 0, byVerdict: {}, byType: {} },
  );
  const report: PromoteGateDryRunReport = {
    taskId: "DOMAIN9-L2-L3-AUTO-DISTILL-PROMOTE-RUNTIME-A",
    generatedAt,
    status: "PASS",
    mode: "dry-run",
    workspaceRoot,
    frozenActive,
    candidatesDir: DISTILL_CANDIDATES_RELATIVE_PATH,
    reviewsDir: REVIEW_CANDIDATES_RELATIVE_PATH,
    outputFile,
    stats,
    plans,
    constraintsVerified: {
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      appliedLogWritten: "no",
      promoted: "none",
      autoPromote: "disabled",
    },
    verdict: "PASS / D9 PROMOTE GATE DRY-RUN COMPLETE / NO PROMOTION PERFORMED",
  };
  if (outputFile) {
    writeJson(outputFile, report);
  }
  return report;
}

export function summarizePromoteGateDryRun(
  report: PromoteGateDryRunReport,
): Pick<
  PromoteGateDryRunReport,
  | "status"
  | "mode"
  | "generatedAt"
  | "frozenActive"
  | "outputFile"
  | "stats"
  | "constraintsVerified"
> {
  return {
    status: report.status,
    mode: report.mode,
    generatedAt: report.generatedAt,
    frozenActive: report.frozenActive,
    outputFile: report.outputFile,
    stats: report.stats,
    constraintsVerified: report.constraintsVerified,
  };
}

export async function readPromoteGateState(
  workspaceRoot: string,
): Promise<PromoteGateStateSummary> {
  const latestReport = listPromoteGateReportFiles(workspaceRoot)[0];
  if (!latestReport) {
    return {
      available: false,
      reportDir: PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH,
    };
  }

  try {
    const report = JSON.parse(await readFile(latestReport, "utf8")) as PromoteGateDryRunReport;
    return {
      available: true,
      reportPath: relativePath(workspaceRoot, latestReport),
      ...summarizePromoteGateDryRun(report),
    };
  } catch (error) {
    return {
      available: false,
      reportDir: PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH,
      reportPath: relativePath(workspaceRoot, latestReport),
      error: `Promote gate state read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
