import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH,
  runPromoteGateDryRun,
  summarizePromoteGateDryRun,
  type PromoteGateDryRunReport,
} from "../runtime/distillation/promote-gate-dry-run.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const PROMOTE_GATE_STATE_ROUTE = "/api/promote-gate/state";
const PROMOTE_GATE_DRY_RUN_ROUTE = "/api/promote-gate/dry-run";
const REPORT_FILE_PREFIX = "d9-promote-gate-dryrun-";
const REPORT_FILE_SUFFIX = ".json";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function listReportFiles(workspaceRoot: string): string[] {
  const reportDir = path.join(workspaceRoot, PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(REPORT_FILE_PREFIX) && entry.name.endsWith(REPORT_FILE_SUFFIX))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
}

export function isPromoteGateApiPath(pathname: string): boolean {
  return pathname === PROMOTE_GATE_STATE_ROUTE || pathname === PROMOTE_GATE_DRY_RUN_ROUTE;
}

export async function handlePromoteGateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isPromoteGateApiPath(requestPath)) {
    return false;
  }

  if (requestPath === PROMOTE_GATE_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const latestReport = listReportFiles(workspaceRoot)[0];
    if (!latestReport) {
      sendJson(res, 200, {
        available: false,
        reportDir: PROMOTE_GATE_REPORT_DIR_RELATIVE_PATH,
      });
      return true;
    }

    try {
      const report = JSON.parse(await readFile(latestReport, "utf8")) as PromoteGateDryRunReport;
      sendJson(res, 200, {
        available: true,
        reportPath: relativePath(workspaceRoot, latestReport),
        ...summarizePromoteGateDryRun(report),
      });
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        reportPath: relativePath(workspaceRoot, latestReport),
        error: `Promote gate state read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const report = runPromoteGateDryRun(workspaceRoot);
    sendJson(res, 200, {
      ...summarizePromoteGateDryRun(report),
      dryRun: true,
      promoted: "none",
    });
  } catch (error) {
    sendJson(res, 500, {
      status: "FAIL",
      mode: "dry-run",
      dryRun: true,
      promoted: "none",
      error: `Promote gate dry-run failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
