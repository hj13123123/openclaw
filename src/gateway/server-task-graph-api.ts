import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildTaskGraphReturnPreview,
  buildTaskGraphValidationSummary,
} from "../runtime/task-graph.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const TASK_GRAPH_VALIDATION_ROUTE = "/api/task-graph/validation";
const TASK_GRAPH_RETURN_PREVIEW_ROUTE = "/api/task-graph/return-preview";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
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

  sendJson(res, 200, buildTaskGraphValidationSummary(workspaceRoot));
  return true;
}
