import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readMirrorObserveState,
  runMirrorObserve,
  summarizeMirrorObserve,
} from "../runtime/mirror/mirror-observe.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const MIRROR_STATE_ROUTE = "/api/mirror/state";
const MIRROR_OBSERVE_ROUTE = "/api/mirror/observe";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function isMirrorApiPath(pathname: string): boolean {
  return pathname === MIRROR_STATE_ROUTE || pathname === MIRROR_OBSERVE_ROUTE;
}

export async function handleMirrorHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isMirrorApiPath(requestPath)) {
    return false;
  }

  if (requestPath === MIRROR_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const state = readMirrorObserveState(workspaceRoot);
    sendJson(res, state.available ? 200 : state.error ? 500 : 200, state);
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const report = runMirrorObserve(workspaceRoot);
    sendJson(res, 200, {
      ...summarizeMirrorObserve(report),
      observeOnly: true,
      promoted: "none",
      applied: false,
    });
  } catch (error) {
    sendJson(res, 500, {
      status: "FAIL",
      mode: "observe-only",
      observeOnly: true,
      promoted: "none",
      applied: false,
      error: `Mirror observe failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
