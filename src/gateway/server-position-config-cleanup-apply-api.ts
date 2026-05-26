import type { IncomingMessage, ServerResponse } from "node:http";
import { applyPositionConfigCleanup } from "../runtime/position-config-cleanup-apply.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";

const POSITION_CONFIG_CLEANUP_APPLY_ROUTE = "/api/positions/cleanup-apply";
const MAX_POSITION_CLEANUP_APPLY_BODY_BYTES = 4096;

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isPositionConfigCleanupApplyApiPath(pathname: string): boolean {
  return pathname === POSITION_CONFIG_CLEANUP_APPLY_ROUTE;
}

export async function handlePositionConfigCleanupApplyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isPositionConfigCleanupApplyApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_POSITION_CLEANUP_APPLY_BODY_BYTES);
  if (body === undefined) return true;
  const payload = isRecord(body) ? body : {};

  try {
    const result = applyPositionConfigCleanup(workspaceRoot, {
      confirm: stringValue(payload.confirm),
      dryRun: payload.dryRun === true,
    });
    const status =
      result.status === "invalid_request" ? 400 : result.status === "blocked" ? 409 : 200;
    sendJson(res, status, {
      ok: status < 400,
      data: result,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Position config cleanup apply failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      constraintsVerified: {
        readOnly: "no",
        positionConfigWritten: "unknown",
        agentsListMutated: "no",
        sessionsSent: "no",
        applied: "unknown",
      },
    });
  }
  return true;
}
