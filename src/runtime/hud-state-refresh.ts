import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  generateHudState,
  type HudPendingReturnItem,
  type HudPositionState,
  type HudState,
  type HudTaskGraphItem,
} from "./hud-state.js";

export const HUD_STATE_RELATIVE_PATH = "runtime/main/tmp/task-hud-state.json";
const POSITIONS_STATE_REL = "system/positions/state";
const RETURNS_INBOX_REL = "system/returns/inbox";
const CASE_LIBRARY_REL = "system/case-library";
const TASK_GRAPH_SOURCE_REL = "runtime/main/tmp/v2-task-graph-01";
const TASK_GRAPH_VALIDATION_REL = "runtime/main/tmp";

export interface HudStateRefreshResult {
  refreshed: true;
  generatedAt: string;
  statePath: string;
  warnings: string[];
  state: HudState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstString(record: Record<string, unknown> | null, names: string[]): string | null {
  if (!record) return null;
  for (const name of names) {
    const value = stringValue(record[name]);
    if (value) return value;
  }
  return null;
}

function nestedString(record: Record<string, unknown> | null, dottedPath: string): string | null {
  if (!record) return null;
  let current: unknown = record;
  for (const segment of dottedPath.split(".")) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return stringValue(current);
}

function returnField(record: Record<string, unknown> | null, nestedPath: string, flatName: string): string | null {
  return nestedString(record, nestedPath) ?? firstString(record, [flatName]);
}

function truncateText(value: string | null, maxLength = 120): string | null {
  if (!value) return value;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function listFiles(dirPath: string, predicate: (name: string) => boolean): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function listFilesRecursive(dirPath: string, predicate: (name: string) => boolean): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return listFilesRecursive(fullPath, predicate);
      return entry.isFile() && predicate(entry.name) ? [fullPath] : [];
    });
  } catch {
    return [];
  }
}

function readPositionStates(workspaceRoot: string, warnings: string[]): Record<string, HudPositionState> {
  const positionsDir = path.join(workspaceRoot, POSITIONS_STATE_REL);
  if (!existsSync(positionsDir)) {
    warnings.push("positions state directory missing");
    return {};
  }

  const states: Record<string, HudPositionState> = {};
  for (const filePath of listFiles(positionsDir, (name) => name.endsWith(".json"))) {
    const state = readJsonFile(filePath);
    if (!state) {
      warnings.push(`Failed to read position state: ${filePath}`);
      continue;
    }
    const baseName = path.basename(filePath, ".json").replace(/_workspace-main$/u, "");
    const agentId = firstString(state, ["agentId", "positionId", "roleId"]) ?? baseName;
    states[agentId] = state as HudPositionState;
  }
  return states;
}

function readPendingReturns(workspaceRoot: string, warnings: string[]): HudPendingReturnItem[] {
  const returnInboxDir = path.join(workspaceRoot, RETURNS_INBOX_REL);
  if (!existsSync(returnInboxDir)) {
    warnings.push("return inbox directory missing");
    return [];
  }

  const files = listFiles(returnInboxDir, (name) => (
    name.endsWith(".json") && !name.toLowerCase().startsWith("return.mock.")
  ));

  return files
    .map((filePath) => {
      const record = readJsonFile(filePath);
      if (!record) warnings.push(`Failed to parse return: ${path.basename(filePath)}`);
      const taskId = returnField(record, "routing.taskId", "taskId");
      const sourceRole = returnField(record, "routing.sourceRole", "sourceRole");
      const action = returnField(record, "routing.action", "action");
      const rawSummary = returnField(record, "outcome.summary", "summary");
      return {
        returnId: path.basename(filePath),
        taskId,
        sourceRole,
        action,
        status: "pending" as const,
        createdAt: statSync(filePath).mtime.toISOString(),
        needsReview: true,
        summary: taskId && sourceRole && action && rawSummary ? truncateText(rawSummary) : "[incomplete return]",
      };
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
}

function readCaseLibraryState(workspaceRoot: string, warnings: string[]): { totalCaseFiles: number; lastCaseAt: string | null } {
  const caseLibraryDir = path.join(workspaceRoot, CASE_LIBRARY_REL);
  if (!existsSync(caseLibraryDir)) {
    warnings.push("case library directory missing");
    return { totalCaseFiles: 0, lastCaseAt: null };
  }

  const files = listFilesRecursive(caseLibraryDir, (name) => name.endsWith(".json"));
  const lastCaseAt = files.length > 0
    ? files.map((filePath) => statSync(filePath).mtime).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null
    : null;
  return { totalCaseFiles: files.length, lastCaseAt };
}

function readValidationReports(workspaceRoot: string, warnings: string[]): Map<string, { checkedAt: string; severity: string | null }> {
  const validationDir = path.join(workspaceRoot, TASK_GRAPH_VALIDATION_REL);
  const reports = new Map<string, { checkedAt: string; severity: string | null }>();
  for (const filePath of listFiles(validationDir, (name) => /^task-graph-validation-.*\.json$/u.test(name))) {
    const report = readJsonFile(filePath);
    const graphId = firstString(report, ["graphId"]);
    const checkedAt = firstString(report, ["checkedAt"]);
    if (!graphId || !checkedAt) continue;
    const current = reports.get(graphId);
    if (current && Date.parse(current.checkedAt) >= Date.parse(checkedAt)) continue;
    reports.set(graphId, {
      checkedAt,
      severity: firstString(report, ["severity"]),
    });
  }
  if (!existsSync(validationDir)) warnings.push("task graph validation directory missing");
  return reports;
}

function nodeStatusSummary(nodes: unknown[]): HudTaskGraphItem["nodeSummary"] {
  const summary: HudTaskGraphItem["nodeSummary"] = {
    total: nodes.length,
    completed: 0,
    running: 0,
    ready: 0,
    planned: 0,
    blocked: 0,
    failed: 0,
  };
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const status = stringValue(node.status);
    if (status && status in summary && status !== "total") summary[status as keyof Omit<typeof summary, "total">] += 1;
  }
  return summary;
}

function readTaskGraphs(workspaceRoot: string, warnings: string[]): HudTaskGraphItem[] {
  const taskGraphDir = path.join(workspaceRoot, TASK_GRAPH_SOURCE_REL);
  if (!existsSync(taskGraphDir)) return [];

  const validationReports = readValidationReports(workspaceRoot, warnings);
  return listFiles(taskGraphDir, (name) => /^task-graph-.*\.json$/u.test(name))
    .map((filePath) => {
      const graph = readJsonFile(filePath);
      if (!graph) {
        warnings.push(`Failed to parse task graph: ${path.basename(filePath)}`);
        return null;
      }
      const graphId = firstString(graph, ["graphId"]);
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const matchedValidation = graphId ? validationReports.get(graphId) : undefined;
      return {
        graphId,
        title: firstString(graph, ["title"]),
        aggregateStatus: firstString(graph, ["aggregateStatus"]),
        nodeSummary: nodeStatusSummary(nodes),
        blockers: Array.isArray(graph.blockers) ? graph.blockers : [],
        nextRunnable: Array.isArray(graph.nextRunnable)
          ? graph.nextRunnable.filter((item): item is string => typeof item === "string")
          : [],
        lastValidatedAt: matchedValidation?.checkedAt ?? null,
        validationSeverity: matchedValidation?.severity ?? null,
      } satisfies HudTaskGraphItem;
    })
    .filter((item): item is HudTaskGraphItem => item !== null);
}

export function generateHudStateFromWorkspace(workspaceRoot: string, generatedAt = new Date().toISOString()): HudState {
  const warnings: string[] = [];
  const { totalCaseFiles, lastCaseAt } = readCaseLibraryState(workspaceRoot, warnings);
  return generateHudState({
    generatedAt,
    positionStatesByAgentId: readPositionStates(workspaceRoot, warnings),
    pendingReturnItems: readPendingReturns(workspaceRoot, warnings),
    totalCaseFiles,
    lastCaseAt,
    taskGraphItems: readTaskGraphs(workspaceRoot, warnings),
    taskGraphSourcePath: `${TASK_GRAPH_SOURCE_REL}/`,
    warnings,
  });
}

export function writeHudStateSnapshot(workspaceRoot: string, generatedAt = new Date().toISOString()): HudStateRefreshResult {
  const state = generateHudStateFromWorkspace(workspaceRoot, generatedAt);
  const statePath = path.join(workspaceRoot, HUD_STATE_RELATIVE_PATH);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return {
    refreshed: true,
    generatedAt: state.generatedAt,
    statePath: HUD_STATE_RELATIVE_PATH,
    warnings: state.warnings,
    state,
  };
}
