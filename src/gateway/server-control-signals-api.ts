import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONTROL_SIGNAL_TARGET_ROLES,
  scanControlSignals,
  type ControlSignalTargetRole,
} from "../runtime/control-signals.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const CONTROL_SIGNALS_SCAN_ROUTE = "/api/control-signals/scan";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveTargetRole(value: string | null): ControlSignalTargetRole | "" | null {
  if (!value) return "";
  return CONTROL_SIGNAL_TARGET_ROLES.includes(value as ControlSignalTargetRole)
    ? (value as ControlSignalTargetRole)
    : null;
}

export function isControlSignalsApiPath(pathname: string): boolean {
  return pathname === CONTROL_SIGNALS_SCAN_ROUTE;
}

export async function handleControlSignalsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isControlSignalsApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const targetRole = resolveTargetRole(requestUrl.searchParams.get("targetRole"));
  if (targetRole === null) {
    sendJson(res, 400, {
      ok: false,
      error: "invalid_targetRole",
      allowedTargetRoles: CONTROL_SIGNAL_TARGET_ROLES,
    });
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: scanControlSignals(workspaceRoot, { targetRole }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Control signal scan failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        signalWritten: "no",
        taskGraphMutated: "no",
        sessionsSent: "no",
        autoDispatchTriggered: "no",
        applied: "no",
      },
    });
  }
  return true;
}
