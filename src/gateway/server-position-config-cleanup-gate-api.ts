import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluatePositionConfigCleanupGate } from "../runtime/position-config-cleanup-gate.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const POSITION_CONFIG_CLEANUP_GATE_ROUTE = "/api/positions/cleanup-gate";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isPositionConfigCleanupGateApiPath(pathname: string): boolean {
  return pathname === POSITION_CONFIG_CLEANUP_GATE_ROUTE;
}

export async function handlePositionConfigCleanupGateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isPositionConfigCleanupGateApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: evaluatePositionConfigCleanupGate(workspaceRoot),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Position config cleanup gate failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      constraintsVerified: {
        readOnly: "yes",
        positionConfigWritten: "no",
        agentsListMutated: "no",
        sessionsSent: "no",
        applied: "no",
      },
    });
  }
  return true;
}
