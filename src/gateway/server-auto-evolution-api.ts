import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readAutoEvolutionState,
  runAutoEvolutionObserve,
  summarizeAutoEvolutionObserve,
} from "../runtime/evolution/auto-evolution-observe.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const AUTO_EVOLUTION_STATE_ROUTE = "/api/auto-evolution/state";
const AUTO_EVOLUTION_OBSERVE_ROUTE = "/api/auto-evolution/observe";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function isAutoEvolutionApiPath(pathname: string): boolean {
  return pathname === AUTO_EVOLUTION_STATE_ROUTE || pathname === AUTO_EVOLUTION_OBSERVE_ROUTE;
}

export async function handleAutoEvolutionHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isAutoEvolutionApiPath(requestPath)) {
    return false;
  }

  if (requestPath === AUTO_EVOLUTION_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const state = readAutoEvolutionState(workspaceRoot);
    sendJson(res, state.available ? 200 : state.error ? 500 : 200, state);
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const report = runAutoEvolutionObserve(workspaceRoot);
    sendJson(res, 200, {
      ...summarizeAutoEvolutionObserve(report),
      observeOnly: true,
      promoted: "none",
      applied: false,
      autoEvolutionApplied: false,
      continuousAutoLoopTriggered: false,
    });
  } catch (error) {
    sendJson(res, 500, {
      status: "FAIL",
      mode: "observe-only",
      observeOnly: true,
      promoted: "none",
      applied: false,
      autoEvolutionApplied: false,
      continuousAutoLoopTriggered: false,
      error: `Auto-evolution observe failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
