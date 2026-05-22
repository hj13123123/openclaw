import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  TASK_GRAPH_SOURCE_RELATIVE_PATH,
  buildTaskGraphReturnPreview,
  listTaskGraphFiles,
  validateTaskGraphFile,
  type TaskGraphValidationReport,
  type TaskGraphValidationReportSeverity,
} from "../runtime/task-graph.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const TASK_GRAPH_VALIDATION_ROUTE = "/api/task-graph/validation";
const TASK_GRAPH_RETURN_PREVIEW_ROUTE = "/api/task-graph/return-preview";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
}

function summarizeSeverity(
  reports: readonly TaskGraphValidationReport[],
): Record<TaskGraphValidationReportSeverity, number> {
  return reports.reduce<Record<TaskGraphValidationReportSeverity, number>>(
    (summary, report) => {
      summary[report.severity] += 1;
      return summary;
    },
    { pass: 0, warning: 0, error: 0 },
  );
}

function reportForApi(
  workspaceRoot: string,
  report: TaskGraphValidationReport,
): TaskGraphValidationReport {
  return {
    ...report,
    graphPath: relativePath(workspaceRoot, report.graphPath),
  };
}

export function isTaskGraphApiPath(pathname: string): boolean {
  return pathname === TASK_GRAPH_VALIDATION_ROUTE || pathname === TASK_GRAPH_RETURN_PREVIEW_ROUTE;
}

export async function handleTaskGraphHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isTaskGraphApiPath(requestPath)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  if (requestPath === TASK_GRAPH_RETURN_PREVIEW_ROUTE) {
    sendJson(res, 200, {
      ok: true,
      data: buildTaskGraphReturnPreview(workspaceRoot),
    });
    return true;
  }

  const checkedAt = new Date().toISOString();
  const reports = listTaskGraphFiles(workspaceRoot)
    .map((filePath) => validateTaskGraphFile(filePath, checkedAt))
    .map((report) => reportForApi(workspaceRoot, report));

  sendJson(res, 200, {
    ok: true,
    available: reports.length > 0,
    mode: "observe-only",
    observeOnly: true,
    applied: false,
    wouldDispatch: false,
    sourcePath: `${TASK_GRAPH_SOURCE_RELATIVE_PATH}/`,
    checkedAt,
    total: reports.length,
    valid: reports.every((report) => report.valid),
    bySeverity: summarizeSeverity(reports),
    reports,
  });
  return true;
}
