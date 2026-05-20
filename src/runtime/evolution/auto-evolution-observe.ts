import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH = "runtime/main/tmp";
export const AUTO_EVOLUTION_REPORT_PREFIX = "auto-evolution-observe-";

const MIRROR_REPORT_PREFIX = "mirror-observe-";
const PROMOTE_GATE_REPORT_PREFIX = "d9-promote-gate-dryrun-";
const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
const KB_INDEX_RELATIVE_PATH = "system/kb-index/index.json";
const RUNTIME_LOOP_STATE_RELATIVE_PATH = "runtime/main/tmp/runtime-loop-state.json";

type JsonRecord = Record<string, unknown>;

export type AutoEvolutionSuggestionSource = "mirror" | "promote_gate" | "kb" | "hud" | "runtime_loop" | "baseline";
export type AutoEvolutionSuggestionPriority = "P0" | "P1" | "P2";

export interface AutoEvolutionSuggestion {
  suggestionId: string;
  source: AutoEvolutionSuggestionSource;
  priority: AutoEvolutionSuggestionPriority;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  blockedBy: string[];
  allowedAction: "OBSERVE_ONLY_RECOMMENDATION";
}

export interface AutoEvolutionObserveReport {
  taskId: "DOMAIN11-AUTO-EVOLUTION-OBSERVE-ONLY-A";
  generatedAt: string;
  status: "PASS";
  mode: "observe-only";
  workspaceRoot: string;
  outputFile: string | null;
  stats: {
    totalSuggestions: number;
    byPriority: Record<string, number>;
    bySource: Record<string, number>;
  };
  inputs: {
    mirrorReportPath: string | null;
    promoteGateReportPath: string | null;
    hudStatePath: string | null;
    kbIndexPath: string | null;
    runtimeLoopStatePath: string | null;
  };
  suggestions: AutoEvolutionSuggestion[];
  constraintsVerified: {
    MEMORYWritten: "no";
    ENGINEERING_RULESWritten: "no";
    codeWritten: "no";
    skillLibraryWritten: "no";
    caseLibraryWritten: "no";
    promoted: "none";
    applyPerformed: "no";
    autoEvolutionApplied: "no";
    continuousAutoLoopTriggered: "no";
  };
  verdict: "PASS / AUTO-EVOLUTION OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED";
}

export interface AutoEvolutionObserveOptions {
  generatedAt?: string;
  outputPath?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonIfPresent(workspaceRoot: string, relativePath: string): { path: string | null; data: JsonRecord | null; error: string | null } {
  const filePath = path.join(workspaceRoot, relativePath);
  if (!existsSync(filePath)) return { path: null, data: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
    return {
      path: relativePath,
      data: isRecord(parsed) ? parsed : null,
      error: isRecord(parsed) ? null : "JSON root is not an object",
    };
  } catch (error) {
    return { path: relativePath, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function latestReport(workspaceRoot: string, prefix: string): { path: string | null; data: JsonRecord | null; error: string | null } {
  const reportDir = path.join(workspaceRoot, AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return { path: null, data: null, error: null };
  const filePath = readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!filePath) return { path: null, data: null, error: null };
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
  return readJsonIfPresent(workspaceRoot, relativePath);
}

function nestedRecord(record: JsonRecord | null, key: string): JsonRecord | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function recordNumber(record: JsonRecord | null, key: string): number {
  return numberValue(record?.[key]) ?? 0;
}

function nextId(suggestions: AutoEvolutionSuggestion[]): string {
  return `auto-evolution-suggestion-${String(suggestions.length + 1).padStart(3, "0")}`;
}

function addSuggestion(suggestions: AutoEvolutionSuggestion[], suggestion: Omit<AutoEvolutionSuggestion, "suggestionId" | "allowedAction">): void {
  suggestions.push({
    suggestionId: nextId(suggestions),
    allowedAction: "OBSERVE_ONLY_RECOMMENDATION",
    ...suggestion,
  });
}

function addMirrorSuggestions(suggestions: AutoEvolutionSuggestion[], mirror: { path: string | null; data: JsonRecord | null; error: string | null }): void {
  if (mirror.error) {
    addSuggestion(suggestions, {
      source: "mirror",
      priority: "P1",
      title: "Repair mirror observe report parsing before enabling evolution planning",
      rationale: "Auto-evolution planning depends on mirror evidence; malformed mirror state must stay fail-closed.",
      evidence: { reportPath: mirror.path, error: mirror.error },
      blockedBy: ["human_review", "report_parse_error"],
    });
    return;
  }
  if (!mirror.data) {
    addSuggestion(suggestions, {
      source: "mirror",
      priority: "P1",
      title: "Generate mirror observe evidence before evolution planning",
      rationale: "D11 should not recommend system changes without a current D10 mirror observe report.",
      evidence: { reportPath: null },
      blockedBy: ["missing_mirror_observe_report"],
    });
    return;
  }

  const stats = nestedRecord(mirror.data, "stats");
  const bySeverity = nestedRecord(stats, "bySeverity");
  const attentionCount = recordNumber(bySeverity, "attention");
  const warningCount = recordNumber(bySeverity, "warning");
  if (attentionCount > 0 || warningCount > 0) {
    addSuggestion(suggestions, {
      source: "mirror",
      priority: attentionCount > 0 ? "P1" : "P2",
      title: "Review mirror observe findings before auto-evolution",
      rationale: "Mirror observe has active findings; evolution must remain advisory until these are triaged.",
      evidence: {
        reportPath: mirror.path,
        attentionCount,
        warningCount,
        generatedAt: stringValue(mirror.data.generatedAt),
      },
      blockedBy: ["human_review", "no_auto_apply"],
    });
  }
}

function addPromoteGateSuggestions(suggestions: AutoEvolutionSuggestion[], promoteGate: { path: string | null; data: JsonRecord | null; error: string | null }): void {
  if (promoteGate.error) {
    addSuggestion(suggestions, {
      source: "promote_gate",
      priority: "P1",
      title: "Repair promote gate dry-run parsing before evolution planning",
      rationale: "D11 must not plan promotions when the D9 gate evidence cannot be parsed.",
      evidence: { reportPath: promoteGate.path, error: promoteGate.error },
      blockedBy: ["human_review", "report_parse_error"],
    });
    return;
  }
  if (!promoteGate.data) {
    addSuggestion(suggestions, {
      source: "promote_gate",
      priority: "P1",
      title: "Run promote gate dry-run before auto-evolution planning",
      rationale: "Auto-evolution suggestions require D9 gate evidence and must not infer promotability.",
      evidence: { reportPath: null },
      blockedBy: ["missing_promote_gate_dry_run"],
    });
    return;
  }

  const stats = nestedRecord(promoteGate.data, "stats");
  const byVerdict = nestedRecord(stats, "byVerdict");
  const frozenBlocked = recordNumber(byVerdict, "FROZEN_BLOCKED");
  const blocked = recordNumber(byVerdict, "BLOCKED");
  const ready = recordNumber(byVerdict, "READY_FOR_PROMOTE_GATE");
  if (frozenBlocked > 0 || blocked > 0 || ready > 0) {
    addSuggestion(suggestions, {
      source: "promote_gate",
      priority: frozenBlocked > 0 || blocked > 0 ? "P1" : "P2",
      title: "Keep D9 promote candidates behind human gates",
      rationale: "Promote gate evidence may identify useful candidates, but D11 cannot promote or modify rules.",
      evidence: {
        reportPath: promoteGate.path,
        frozenBlocked,
        blocked,
        ready,
        generatedAt: stringValue(promoteGate.data.generatedAt),
      },
      blockedBy: ["human_gate", "no_auto_promote", "no_rule_write"],
    });
  }
}

function addKbSuggestions(suggestions: AutoEvolutionSuggestion[], kb: { path: string | null; data: JsonRecord | null; error: string | null }): void {
  if (kb.error || !kb.data) {
    addSuggestion(suggestions, {
      source: "kb",
      priority: "P2",
      title: "Refresh KB evidence before using evolution recommendations",
      rationale: "D11 recommendations should be grounded in the current KB index.",
      evidence: { indexPath: kb.path, error: kb.error },
      blockedBy: [kb.error ? "kb_parse_error" : "missing_kb_index"],
    });
    return;
  }

  const totalItems = recordNumber(kb.data, "totalItems");
  const sourceCaseCount = recordNumber(kb.data, "sourceCaseCount");
  const sourceSkillCount = recordNumber(kb.data, "sourceSkillCount");
  if (totalItems === 0 || sourceCaseCount === 0) {
    addSuggestion(suggestions, {
      source: "kb",
      priority: "P2",
      title: "Improve KB coverage before evolution planning",
      rationale: "Auto-evolution observe should not overfit when KB evidence is sparse.",
      evidence: { indexPath: kb.path, totalItems, sourceCaseCount, sourceSkillCount },
      blockedBy: ["insufficient_kb_evidence"],
    });
  }
}

function addHudSuggestions(suggestions: AutoEvolutionSuggestion[], hud: { path: string | null; data: JsonRecord | null; error: string | null }): void {
  if (hud.error || !hud.data) {
    addSuggestion(suggestions, {
      source: "hud",
      priority: "P2",
      title: "Refresh HUD state before evolution planning",
      rationale: "D11 observe uses HUD/watchdog context as an operator-facing safety signal.",
      evidence: { hudStatePath: hud.path, error: hud.error },
      blockedBy: [hud.error ? "hud_parse_error" : "missing_hud_state"],
    });
    return;
  }

  const watchdog = nestedRecord(hud.data, "watchdogSnapshot");
  const totalAlerts = recordNumber(watchdog, "totalAlerts");
  if (totalAlerts > 0) {
    addSuggestion(suggestions, {
      source: "hud",
      priority: "P1",
      title: "Resolve HUD watchdog alerts before enabling evolution actions",
      rationale: "Watchdog alerts are compatible with observe-only recommendations but block automatic apply.",
      evidence: {
        hudStatePath: hud.path,
        totalAlerts,
        byCondition: nestedRecord(watchdog, "byCondition") ?? {},
      },
      blockedBy: ["watchdog_attention", "no_auto_apply"],
    });
  }
}

function addRuntimeLoopSuggestions(suggestions: AutoEvolutionSuggestion[], runtimeLoop: { path: string | null; data: JsonRecord | null; error: string | null }): void {
  if (runtimeLoop.error) {
    addSuggestion(suggestions, {
      source: "runtime_loop",
      priority: "P1",
      title: "Repair runtime loop state parsing before evolution planning",
      rationale: "D11 must fail closed when runtime loop state is malformed.",
      evidence: { runtimeLoopStatePath: runtimeLoop.path, error: runtimeLoop.error },
      blockedBy: ["runtime_loop_parse_error"],
    });
    return;
  }
  if (!runtimeLoop.data) return;

  const warnings = Array.isArray(runtimeLoop.data.warnings)
    ? runtimeLoop.data.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const scheduler = nestedRecord(runtimeLoop.data, "scheduler");
  const schedulerPolicy = nestedRecord(scheduler, "schedulerPolicy");
  const continuousApply = schedulerPolicy?.enableContinuousApply === true;
  const schedulerEnabled = scheduler?.enabled === true;
  if (warnings.length > 0 || continuousApply || schedulerEnabled) {
    addSuggestion(suggestions, {
      source: "runtime_loop",
      priority: continuousApply || schedulerEnabled ? "P0" : "P2",
      title: "Keep runtime loop in observe mode before D11 actions",
      rationale: "D11 planning cannot coexist with uncontrolled apply or continuous dispatch.",
      evidence: {
        runtimeLoopStatePath: runtimeLoop.path,
        warnings,
        schedulerEnabled,
        continuousApply,
      },
      blockedBy: ["observe_mode_required", "continuous_auto_loop_forbidden"],
    });
  }
}

function buildStats(suggestions: AutoEvolutionSuggestion[]): AutoEvolutionObserveReport["stats"] {
  return suggestions.reduce<AutoEvolutionObserveReport["stats"]>(
    (acc, suggestion) => {
      acc.totalSuggestions += 1;
      acc.byPriority[suggestion.priority] = (acc.byPriority[suggestion.priority] ?? 0) + 1;
      acc.bySource[suggestion.source] = (acc.bySource[suggestion.source] ?? 0) + 1;
      return acc;
    },
    { totalSuggestions: 0, byPriority: {}, bySource: {} },
  );
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function runAutoEvolutionObserve(
  workspaceRoot: string,
  options: AutoEvolutionObserveOptions = {},
): AutoEvolutionObserveReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputFile = options.outputPath === undefined
    ? path.join(workspaceRoot, AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH, `${AUTO_EVOLUTION_REPORT_PREFIX}${generatedAt.replace(/[:.]/gu, "-")}.json`)
    : options.outputPath;
  const mirror = latestReport(workspaceRoot, MIRROR_REPORT_PREFIX);
  const promoteGate = latestReport(workspaceRoot, PROMOTE_GATE_REPORT_PREFIX);
  const hud = readJsonIfPresent(workspaceRoot, HUD_STATE_RELATIVE_PATH);
  const kb = readJsonIfPresent(workspaceRoot, KB_INDEX_RELATIVE_PATH);
  const runtimeLoop = readJsonIfPresent(workspaceRoot, RUNTIME_LOOP_STATE_RELATIVE_PATH);
  const suggestions: AutoEvolutionSuggestion[] = [];

  addMirrorSuggestions(suggestions, mirror);
  addPromoteGateSuggestions(suggestions, promoteGate);
  addKbSuggestions(suggestions, kb);
  addHudSuggestions(suggestions, hud);
  addRuntimeLoopSuggestions(suggestions, runtimeLoop);
  if (suggestions.length === 0) {
    addSuggestion(suggestions, {
      source: "baseline",
      priority: "P2",
      title: "Maintain observe-only auto-evolution baseline",
      rationale: "No immediate evolution risks were detected; D11 remains advisory until explicit human approval.",
      evidence: {},
      blockedBy: ["human_gate_required", "no_auto_apply"],
    });
  }

  const report: AutoEvolutionObserveReport = {
    taskId: "DOMAIN11-AUTO-EVOLUTION-OBSERVE-ONLY-A",
    generatedAt,
    status: "PASS",
    mode: "observe-only",
    workspaceRoot,
    outputFile,
    stats: buildStats(suggestions),
    inputs: {
      mirrorReportPath: mirror.path,
      promoteGateReportPath: promoteGate.path,
      hudStatePath: hud.path,
      kbIndexPath: kb.path,
      runtimeLoopStatePath: runtimeLoop.path,
    },
    suggestions,
    constraintsVerified: {
      MEMORYWritten: "no",
      ENGINEERING_RULESWritten: "no",
      codeWritten: "no",
      skillLibraryWritten: "no",
      caseLibraryWritten: "no",
      promoted: "none",
      applyPerformed: "no",
      autoEvolutionApplied: "no",
      continuousAutoLoopTriggered: "no",
    },
    verdict: "PASS / AUTO-EVOLUTION OBSERVE COMPLETE / NO APPLY OR PROMOTE PERFORMED",
  };
  if (outputFile) writeJson(outputFile, report);
  return report;
}

export function summarizeAutoEvolutionObserve(report: AutoEvolutionObserveReport): Pick<
  AutoEvolutionObserveReport,
  "generatedAt" | "status" | "mode" | "outputFile" | "stats" | "inputs" | "constraintsVerified" | "verdict"
> {
  return {
    generatedAt: report.generatedAt,
    status: report.status,
    mode: report.mode,
    outputFile: report.outputFile,
    stats: report.stats,
    inputs: report.inputs,
    constraintsVerified: report.constraintsVerified,
    verdict: report.verdict,
  };
}
