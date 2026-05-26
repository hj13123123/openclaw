import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateReturnReconciliationGate } from "../runtime/returns/return-reconciliation-gate.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RETURN_RECONCILIATION_GATE_ROUTE = "/api/returns/reconciliation-gate";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isReturnReconciliationGateApiPath(pathname: string): boolean {
  return pathname === RETURN_RECONCILIATION_GATE_ROUTE;
}

export async function handleReturnReconciliationGateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isReturnReconciliationGateApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: evaluateReturnReconciliationGate(workspaceRoot),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Return reconciliation gate failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        returnWritten: "no",
        taskGraphWritten: "no",
        receiptWritten: "no",
        consumerTriggered: "no",
        dispatchTriggered: "no",
        applied: "no",
      },
    });
  }
  return true;
}
