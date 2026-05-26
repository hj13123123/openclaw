import type { IncomingMessage, ServerResponse } from "node:http";
import { buildPositionConfigCleanupPlan } from "../runtime/position-config-cleanup-plan.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const POSITION_CONFIG_CLEANUP_PLAN_ROUTE = "/api/positions/cleanup-plan";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isPositionConfigCleanupPlanApiPath(pathname: string): boolean {
  return pathname === POSITION_CONFIG_CLEANUP_PLAN_ROUTE;
}

export async function handlePositionConfigCleanupPlanHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isPositionConfigCleanupPlanApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: buildPositionConfigCleanupPlan(workspaceRoot, {
        limit: parseLimit(requestUrl.searchParams.get("limit")),
      }),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Position config cleanup plan failed: ${
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
