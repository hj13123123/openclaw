import type { IncomingMessage, ServerResponse } from "node:http";
import { scanPromotionCandidates } from "../runtime/distillation/promotion-candidates.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const PROMOTION_CANDIDATES_SCAN_ROUTE = "/api/promotion-candidates/scan";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function isPromotionCandidatesApiPath(pathname: string): boolean {
  return pathname === PROMOTION_CANDIDATES_SCAN_ROUTE;
}

export async function handlePromotionCandidatesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isPromotionCandidatesApiPath(requestPath)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: scanPromotionCandidates(workspaceRoot),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Promotion candidate scan failed: ${error instanceof Error ? error.message : String(error)}`,
      constraintsVerified: {
        readOnly: "yes",
        candidateStateWritten: "no",
        truthFilesWritten: "no",
        applied: "none",
        rolledBack: "none",
        autoPromote: "disabled",
      },
    });
  }
  return true;
}
