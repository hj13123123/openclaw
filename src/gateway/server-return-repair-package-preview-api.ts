import type { IncomingMessage, ServerResponse } from "node:http";
import { buildReturnRepairPackagePreview } from "../runtime/returns/return-repair-dry-run.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const RETURN_REPAIR_PACKAGE_PREVIEW_ROUTE = "/api/returns/repair-package-preview";

function resolveRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function isReturnRepairPackagePreviewApiPath(pathname: string): boolean {
  return pathname === RETURN_REPAIR_PACKAGE_PREVIEW_ROUTE;
}

export async function handleReturnRepairPackagePreviewHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestUrl = resolveRequestUrl(req);
  if (!isReturnRepairPackagePreviewApiPath(requestUrl.pathname)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const sourceFile = requestUrl.searchParams.get("sourceFile");
  if (!sourceFile) {
    sendJson(res, 400, {
      ok: false,
      error: "sourceFile query parameter is required",
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
    return true;
  }

  try {
    sendJson(res, 200, {
      ok: true,
      data: buildReturnRepairPackagePreview(workspaceRoot, sourceFile),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Return repair package preview failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
