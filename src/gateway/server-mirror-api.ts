import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  MIRROR_REPORT_DIR_RELATIVE_PATH,
  MIRROR_REPORT_PREFIX,
  runMirrorObserve,
  summarizeMirrorObserve,
  type MirrorObserveReport,
} from "../runtime/mirror/mirror-observe.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const MIRROR_STATE_ROUTE = "/api/mirror/state";
const MIRROR_OBSERVE_ROUTE = "/api/mirror/observe";
const REPORT_FILE_SUFFIX = ".json";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function listReportFiles(workspaceRoot: string): string[] {
  const reportDir = path.join(workspaceRoot, MIRROR_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(MIRROR_REPORT_PREFIX) && entry.name.endsWith(REPORT_FILE_SUFFIX))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
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

    const latestReport = listReportFiles(workspaceRoot)[0];
    if (!latestReport) {
      sendJson(res, 200, {
        available: false,
        reportDir: MIRROR_REPORT_DIR_RELATIVE_PATH,
      });
      return true;
    }

    try {
      const report = JSON.parse(await readFile(latestReport, "utf8")) as MirrorObserveReport;
      sendJson(res, 200, {
        available: true,
        reportPath: relativePath(workspaceRoot, latestReport),
        ...summarizeMirrorObserve(report),
      });
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        reportPath: relativePath(workspaceRoot, latestReport),
        error: `Mirror observe state read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
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
