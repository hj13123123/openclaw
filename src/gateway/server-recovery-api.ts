import type { IncomingMessage, ServerResponse } from "node:http";
import { scanRecoveryCandidates } from "../runtime/recovery-candidates.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RECOVERY_CANDIDATES_SCAN_ROUTE = "/api/recovery-candidates/scan";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isRecoveryApiPath(pathname: string): boolean {
  return pathname === RECOVERY_CANDIDATES_SCAN_ROUTE;
}

export async function handleRecoveryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isRecoveryApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: scanRecoveryCandidates(workspaceRoot, {
        graphId: requestUrl.searchParams.get("graphId") ?? undefined,
      }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Recovery candidate scan failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        recoveryDecisionWritten: "no",
        taskGraphMutated: "no",
        sessionsSent: "no",
        autoDispatchTriggered: "no",
        applied: "no",
      },
    });
  }
  return true;
}
