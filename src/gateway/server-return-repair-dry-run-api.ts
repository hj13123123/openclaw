import type { IncomingMessage, ServerResponse } from "node:http";
import { buildReturnRepairDryRun } from "../runtime/returns/return-repair-dry-run.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RETURN_REPAIR_DRY_RUN_ROUTE = "/api/returns/repair-dry-run";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveLimit(value: string | null): number | undefined | null {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 0 ? limit : null;
}

export function isReturnRepairDryRunApiPath(pathname: string): boolean {
  return pathname === RETURN_REPAIR_DRY_RUN_ROUTE;
}

export async function handleReturnRepairDryRunHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isReturnRepairDryRunApiPath(requestUrl.pathname)) {
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
      data: buildReturnRepairDryRun(workspaceRoot, { limit }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Return repair dry-run failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        returnWritten: "no",
        originalReturnMutated: "no",
        archived: "no",
        receiptWritten: "no",
        consumerTriggered: "no",
        applied: "no",
      },
    });
  }
  return true;
}
