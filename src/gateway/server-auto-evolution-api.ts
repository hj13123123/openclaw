import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH,
  AUTO_EVOLUTION_REPORT_PREFIX,
  runAutoEvolutionObserve,
  summarizeAutoEvolutionObserve,
  type AutoEvolutionObserveReport,
} from "../runtime/evolution/auto-evolution-observe.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const AUTO_EVOLUTION_STATE_ROUTE = "/api/auto-evolution/state";
const AUTO_EVOLUTION_OBSERVE_ROUTE = "/api/auto-evolution/observe";
const REPORT_FILE_SUFFIX = ".json";

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function listReportFiles(workspaceRoot: string): string[] {
  const reportDir = path.join(workspaceRoot, AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH);
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(AUTO_EVOLUTION_REPORT_PREFIX) && entry.name.endsWith(REPORT_FILE_SUFFIX))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
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

    const latestReport = listReportFiles(workspaceRoot)[0];
    if (!latestReport) {
      sendJson(res, 200, {
        available: false,
        reportDir: AUTO_EVOLUTION_REPORT_DIR_RELATIVE_PATH,
      });
      return true;
    }

    try {
      const report = JSON.parse(await readFile(latestReport, "utf8")) as AutoEvolutionObserveReport;
      sendJson(res, 200, {
        available: true,
        reportPath: relativePath(workspaceRoot, latestReport),
        ...summarizeAutoEvolutionObserve(report),
      });
    } catch (error) {
      sendJson(res, 500, {
        available: false,
        reportPath: relativePath(workspaceRoot, latestReport),
        error: `Auto-evolution observe state read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
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
