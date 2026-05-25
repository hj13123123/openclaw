import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readLatestPromoteGateReport } from "../distillation/promote-gate-dry-run.js";

export const MIRROR_REPORT_DIR_RELATIVE_PATH = "runtime/main/tmp";
export const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
export const SCHEDULER_STATE_RELATIVE_PATH = "runtime/main/tmp/task-scheduler-state.json";
export const KB_INDEX_RELATIVE_PATH = "system/kb-index/index.json";
export const MIRROR_REPORT_PREFIX = "mirror-observe-";

type JsonRecord = Record<string, unknown>;

export interface MirrorObservation {
  source: "hud" | "scheduler" | "kb" | "promote_gate";
  status: "ok" | "attention" | "missing" | "error";
  summary: string;
  metrics: Record<string, unknown>;
}

export interface MirrorFinding {
  findingId: string;
  source: MirrorObservation["source"];
  severity: "info" | "warning" | "attention";
  observedBehavior: string;
  deviation: string | null;
  suggestedAction: string[];
}

export interface MirrorObserveReport {
  taskId: "DOMAIN10-MIRROR-OBSERVE-ONLY-A";
  mirrorId: string;
  generatedAt: string;
  mode: "observe-only";
  workspaceRoot: string;
  outputFile: string | null;
  observations: MirrorObservation[];
  findings: MirrorFinding[];
  stats: {
    observationCount: number;
    findingCount: number;
    bySeverity: Record<string, number>;
  };
  constraintsVerified: {
    MEMORYWritten: "no";
    ENGINEERING_RULESWritten: "no";
    skillLibraryWritten: "no";
    caseLibraryWritten: "no";
    promoted: "none";
    autoLoopTriggered: "no";
    applyPerformed: "no";
  };
  verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED";
}

export interface MirrorObserveOptions {
  generatedAt?: string;
  outputPath?: string | null;
}

export interface MirrorObserveReportReadResult {
  path: string | null;
  data: MirrorObserveReport | null;
  error: string | null;
}

export type MirrorObserveStateSummary =
  | {
      available: false;
      reportDir: string;
      reportPath?: string;
      error?: string;
    }
  | ({
      available: true;
      reportPath: string;
    } & ReturnType<typeof summarizeMirrorObserve>);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readJsonIfPresent(
  workspaceRoot: string,
  relativePath: string,
): { path: string; data: JsonRecord | null; error: string | null } {
  const filePath = path.join(workspaceRoot, relativePath);
  if (!existsSync(filePath)) return { path: relativePath, data: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
    return {
      path: relativePath,
      data: isRecord(parsed) ? parsed : null,
      error: isRecord(parsed) ? null : "JSON root is not an object",
    };
  } catch (error) {
    return {
      path: relativePath,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
}

export function listMirrorObserveReportFiles(workspaceRoot: string): string[] {
  const reportDir = path.join(workspaceRoot, MIRROR_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(MIRROR_REPORT_PREFIX) &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function readLatestMirrorObserveReport(
  workspaceRoot: string,
): MirrorObserveReportReadResult {
  const latestReport = listMirrorObserveReportFiles(workspaceRoot)[0];
  if (!latestReport) {
    return { path: null, data: null, error: null };
  }
  const reportPath = relativePath(workspaceRoot, latestReport);
  try {
    return {
      path: reportPath,
      data: JSON.parse(
        readFileSync(latestReport, "utf8").replace(/^\uFEFF/u, ""),
      ) as MirrorObserveReport,
      error: null,
    };
  } catch (error) {
    return {
      path: reportPath,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeHud(data: JsonRecord | null, error: string | null): MirrorObservation {
  if (error)
    return {
      source: "hud",
      status: "error",
      summary: "HUD state could not be parsed",
      metrics: { error },
    };
  if (!data)
    return {
      source: "hud",
      status: "missing",
      summary: "HUD state has not been generated",
      metrics: {},
    };
  const globalStatus = isRecord(data.globalStatus) ? data.globalStatus : {};
  const status = stringValue(globalStatus.status) ?? "unknown";
  const pendingReviewCount = numberValue(globalStatus.pendingReviewCount) ?? 0;
  const alertCount = numberValue(globalStatus.alertCount) ?? 0;
  return {
    source: "hud",
    status: status === "ok" && pendingReviewCount === 0 && alertCount === 0 ? "ok" : "attention",
    summary: `HUD global status is ${status}`,
    metrics: {
      status,
      pendingReviewCount,
      alertCount,
      generatedAt: stringValue(data.generatedAt),
    },
  };
}

function summarizeScheduler(data: JsonRecord | null, error: string | null): MirrorObservation {
  if (error)
    return {
      source: "scheduler",
      status: "error",
      summary: "Scheduler state could not be parsed",
      metrics: { error },
    };
  if (!data)
    return {
      source: "scheduler",
      status: "missing",
      summary: "Scheduler state has not been generated",
      metrics: {},
    };
  const enabled = data.enabled === true;
  const mode = stringValue(data.mode) ?? "unknown";
  const status = stringValue(data.status) ?? "unknown";
  return {
    source: "scheduler",
    status: enabled ? "attention" : "ok",
    summary: enabled
      ? `Scheduler is enabled in ${mode} mode`
      : `Scheduler is ${status} in ${mode} mode`,
    metrics: {
      enabled,
      mode,
      status,
      totalTicks: numberValue(data.totalTicks) ?? 0,
      observeOnlyTicks: numberValue(data.observeOnlyTicks) ?? 0,
      skippedBecauseDisabled: numberValue(data.skippedBecauseDisabled) ?? 0,
    },
  };
}

function summarizeKb(data: JsonRecord | null, error: string | null): MirrorObservation {
  if (error)
    return {
      source: "kb",
      status: "error",
      summary: "KB index could not be parsed",
      metrics: { error },
    };
  if (!data)
    return {
      source: "kb",
      status: "missing",
      summary: "KB index has not been generated",
      metrics: {},
    };
  const totalItems = numberValue(data.totalItems) ?? 0;
  const keywordCount = isRecord(data.keywords) ? Object.keys(data.keywords).length : 0;
  return {
    source: "kb",
    status: totalItems > 0 && keywordCount > 0 ? "ok" : "attention",
    summary: `KB keyword index has ${totalItems} items and ${keywordCount} keywords`,
    metrics: {
      generatedAt: stringValue(data.generatedAt),
      totalItems,
      keywordCount,
      sourceCaseCount: numberValue(data.sourceCaseCount) ?? 0,
      sourceSkillCount: numberValue(data.sourceSkillCount) ?? 0,
    },
  };
}

function summarizePromoteGate(
  data: JsonRecord | null,
  error: string | null,
  reportPath: string | null,
): MirrorObservation {
  if (error)
    return {
      source: "promote_gate",
      status: "error",
      summary: "Promote gate report could not be parsed",
      metrics: { error, reportPath },
    };
  if (!data)
    return {
      source: "promote_gate",
      status: "missing",
      summary: "Promote gate dry-run report has not been generated",
      metrics: {},
    };
  const stats = isRecord(data.stats) ? data.stats : {};
  const byVerdict = isRecord(stats.byVerdict) ? stats.byVerdict : {};
  const frozenCount = numberValue(byVerdict.FROZEN_BLOCKED) ?? 0;
  const blockedCount = numberValue(byVerdict.BLOCKED) ?? 0;
  return {
    source: "promote_gate",
    status: frozenCount > 0 || blockedCount > 0 ? "attention" : "ok",
    summary: `Promote gate dry-run has ${frozenCount} frozen and ${blockedCount} blocked candidates`,
    metrics: {
      reportPath,
      generatedAt: stringValue(data.generatedAt),
      total: numberValue(stats.total) ?? 0,
      frozenBlocked: frozenCount,
      blocked: blockedCount,
      promoted: isRecord(data.constraintsVerified)
        ? (data.constraintsVerified.promoted ?? null)
        : null,
    },
  };
}

function buildFindings(observations: MirrorObservation[]): MirrorFinding[] {
  const findings: MirrorFinding[] = [];
  const nextId = () => `mirror-finding-${String(findings.length + 1).padStart(3, "0")}`;
  for (const observation of observations) {
    if (observation.status === "ok") {
      findings.push({
        findingId: nextId(),
        source: observation.source,
        severity: "info",
        observedBehavior: observation.summary,
        deviation: null,
        suggestedAction: ["keep observing"],
      });
      continue;
    }
    if (observation.source === "promote_gate" && observation.status !== "missing") {
      findings.push({
        findingId: nextId(),
        source: observation.source,
        severity: "attention",
        observedBehavior: observation.summary,
        deviation: "D9 candidates are not promotable under current gates",
        suggestedAction: ["review blocked candidates", "keep promote gate in dry-run mode"],
      });
      continue;
    }
    findings.push({
      findingId: nextId(),
      source: observation.source,
      severity: observation.status === "missing" ? "warning" : "attention",
      observedBehavior: observation.summary,
      deviation:
        observation.status === "missing"
          ? "expected runtime evidence is missing"
          : "runtime state needs operator attention",
      suggestedAction: ["inspect source state", "do not auto-apply changes from mirror observe"],
    });
  }
  return findings;
}

function reportIdFromTimestamp(generatedAt: string): string {
  return `mirror-${generatedAt.replace(/[-:.]/gu, "").replace(/T/u, "-").replace(/Z$/u, "Z")}`;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function runMirrorObserve(
  workspaceRoot: string,
  options: MirrorObserveOptions = {},
): MirrorObserveReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const mirrorId = reportIdFromTimestamp(generatedAt);
  const outputFile =
    options.outputPath === undefined
      ? path.join(
          workspaceRoot,
          MIRROR_REPORT_DIR_RELATIVE_PATH,
          `${MIRROR_REPORT_PREFIX}${generatedAt.replace(/[:.]/gu, "-")}.json`,
        )
      : options.outputPath;
  const hud = readJsonIfPresent(workspaceRoot, HUD_STATE_RELATIVE_PATH);
  const scheduler = readJsonIfPresent(workspaceRoot, SCHEDULER_STATE_RELATIVE_PATH);
  const kb = readJsonIfPresent(workspaceRoot, KB_INDEX_RELATIVE_PATH);
  const latestPromoteGate = readLatestPromoteGateReport(workspaceRoot);
  const promoteGate = {
    path: latestPromoteGate.path,
    data: latestPromoteGate.data as unknown as JsonRecord | null,
    error: latestPromoteGate.error,
  };
  const observations = [
    summarizeHud(hud.data, hud.error),
    summarizeScheduler(scheduler.data, scheduler.error),
    summarizeKb(kb.data, kb.error),
    summarizePromoteGate(promoteGate.data, promoteGate.error, promoteGate.path),
  ];
  const findings = buildFindings(observations);
  const stats = findings.reduce<MirrorObserveReport["stats"]>(
    (acc, finding) => {
      acc.findingCount += 1;
      acc.bySeverity[finding.severity] = (acc.bySeverity[finding.severity] ?? 0) + 1;
      return acc;
    },
    { observationCount: observations.length, findingCount: 0, bySeverity: {} },
  );
  const report: MirrorObserveReport = {
    taskId: "DOMAIN10-MIRROR-OBSERVE-ONLY-A",
    mirrorId,
    generatedAt,
    mode: "observe-only",
    workspaceRoot,
    outputFile,
    observations,
    findings,
    stats,
    constraintsVerified: {
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      promoted: "none",
      autoLoopTriggered: "no",
      applyPerformed: "no",
    },
    verdict: "PASS / MIRROR OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
  };
  if (outputFile) writeJson(outputFile, report);
  return report;
}

export function summarizeMirrorObserve(
  report: MirrorObserveReport,
): Pick<
  MirrorObserveReport,
  "mirrorId" | "generatedAt" | "mode" | "outputFile" | "stats" | "constraintsVerified" | "verdict"
> {
  return {
    mirrorId: report.mirrorId,
    generatedAt: report.generatedAt,
    mode: report.mode,
    outputFile: report.outputFile,
    stats: report.stats,
    constraintsVerified: report.constraintsVerified,
    verdict: report.verdict,
  };
}

export function readMirrorObserveState(workspaceRoot: string): MirrorObserveStateSummary {
  const latestReport = readLatestMirrorObserveReport(workspaceRoot);
  if (!latestReport.path) {
    return {
      available: false,
      reportDir: MIRROR_REPORT_DIR_RELATIVE_PATH,
    };
  }

  if (latestReport.error || !latestReport.data) {
    return {
      available: false,
      reportDir: MIRROR_REPORT_DIR_RELATIVE_PATH,
      reportPath: latestReport.path,
      error: `Mirror observe state read failed: ${latestReport.error ?? "report missing"}`,
    };
  }

  return {
    available: true,
    reportPath: latestReport.path,
    ...summarizeMirrorObserve(latestReport.data),
  };
}
