import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readPromoteGateState,
  runPromoteGateDryRun,
  summarizePromoteGateDryRun,
} from "../runtime/distillation/promote-gate-dry-run.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const PROMOTE_GATE_STATE_ROUTE = "/api/promote-gate/state";
const PROMOTE_GATE_DRY_RUN_ROUTE = "/api/promote-gate/dry-run";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function isPromoteGateApiPath(pathname: string): boolean {
  return pathname === PROMOTE_GATE_STATE_ROUTE || pathname === PROMOTE_GATE_DRY_RUN_ROUTE;
}

export async function handlePromoteGateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isPromoteGateApiPath(requestPath)) {
    return false;
  }

  if (requestPath === PROMOTE_GATE_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const state = await readPromoteGateState(workspaceRoot);
    sendJson(res, state.available ? 200 : state.error ? 500 : 200, state);
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const report = runPromoteGateDryRun(workspaceRoot);
    sendJson(res, 200, {
      ...summarizePromoteGateDryRun(report),
      dryRun: true,
      promoted: "none",
    });
  } catch (error) {
    sendJson(res, 500, {
      status: "FAIL",
      mode: "dry-run",
      dryRun: true,
      promoted: "none",
      error: `Promote gate dry-run failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
