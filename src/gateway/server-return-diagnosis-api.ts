import type { IncomingMessage, ServerResponse } from "node:http";
import { scanReturnDiagnosis } from "../runtime/returns/return-diagnosis.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RETURN_DIAGNOSIS_ROUTE = "/api/returns/diagnosis";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveLimit(value: string | null): number | undefined | null {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 0 ? limit : null;
}

export function isReturnDiagnosisApiPath(pathname: string): boolean {
  return pathname === RETURN_DIAGNOSIS_ROUTE;
}

export async function handleReturnDiagnosisHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isReturnDiagnosisApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const limit = resolveLimit(requestUrl.searchParams.get("limit"));
  if (limit === null) {
    sendJson(res, 400, {
      ok: false,
      error: "invalid_limit",
    });
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: scanReturnDiagnosis(workspaceRoot, { limit }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Return diagnosis scan failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        returnWritten: "no",
        returnConsumed: "no",
        archived: "no",
        receiptWritten: "no",
        taskGraphMutated: "no",
        applied: "no",
      },
    });
  }
  return true;
}
