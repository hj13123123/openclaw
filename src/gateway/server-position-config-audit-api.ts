import type { IncomingMessage, ServerResponse } from "node:http";
import { auditPositionConfig } from "../runtime/position-config-audit.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const POSITION_CONFIG_AUDIT_ROUTE = "/api/positions/audit";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isPositionConfigAuditApiPath(pathname: string): boolean {
  return pathname === POSITION_CONFIG_AUDIT_ROUTE;
}

export async function handlePositionConfigAuditHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isPositionConfigAuditApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: auditPositionConfig(workspaceRoot),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Position config audit failed: ${error instanceof Error ? error.message : String(error)}`,
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
