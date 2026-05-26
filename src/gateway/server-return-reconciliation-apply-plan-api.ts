import type { IncomingMessage, ServerResponse } from "node:http";
import { buildReturnReconciliationApplyPlan } from "../runtime/returns/return-reconciliation-apply-plan.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RETURN_RECONCILIATION_APPLY_PLAN_ROUTE = "/api/returns/reconciliation-apply-plan";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isReturnReconciliationApplyPlanApiPath(pathname: string): boolean {
  return pathname === RETURN_RECONCILIATION_APPLY_PLAN_ROUTE;
}

export async function handleReturnReconciliationApplyPlanHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isReturnReconciliationApplyPlanApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: buildReturnReconciliationApplyPlan(workspaceRoot, {
        limit: parseLimit(requestUrl.searchParams.get("limit")),
      }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Return reconciliation apply plan failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
