import type { IncomingMessage, ServerResponse } from "node:http";
import { buildSchedulerTickPlan } from "../runtime/scheduler-tick-plan.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const SCHEDULER_TICK_PLAN_ROUTE = "/api/task-scheduler/tick-plan";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isSchedulerTickPlanApiPath(pathname: string): boolean {
  return pathname === SCHEDULER_TICK_PLAN_ROUTE;
}

export async function handleSchedulerTickPlanHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isSchedulerTickPlanApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: buildSchedulerTickPlan(workspaceRoot),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Scheduler tick plan failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        markerWritten: "no",
        stateWritten: "no",
        eventEmitted: "no",
        scriptInvoked: "no",
        childProcessSpawned: "no",
        autoDispatchTriggered: "no",
        applied: "no",
      },
    });
  }
  return true;
}
