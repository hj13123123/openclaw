import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const RETURNS_INBOX_RELATIVE_PATH = "system/returns/inbox";

export type ReturnInboxItemStatus = "pending";

export interface ReturnInboxItem {
  returnId: string;
  relativePath: string;
  taskId: string | null;
  sourceRole: string | null;
  action: string | null;
  status: ReturnInboxItemStatus;
  createdAt: string;
  needsReview: true;
  summary: string | null;
  complete: boolean;
  malformed: boolean;
}

export interface ReturnInboxScanResult {
  mode: "observe-only";
  scannedAt: string;
  inboxPath: string;
  pendingCount: number;
  completeCount: number;
  incompleteCount: number;
  malformedCount: number;
  skippedMockCount: number;
  pendingItems: ReturnInboxItem[];
  warnings: string[];
  constraintsVerified: {
    consumed: "no";
    archived: "no";
    receiptWritten: "no";
    taskGraphMutated: "no";
    applied: "no";
  };
}

export interface ReturnInboxScanOptions {
  scannedAt?: string;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nestedString(record: Record<string, unknown> | null, dottedPath: string): string | null {
  if (!record) return null;
  let current: unknown = record;
  for (const segment of dottedPath.split(".")) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return stringValue(current);
}

function firstString(record: Record<string, unknown> | null, names: string[]): string | null {
  if (!record) return null;
  for (const name of names) {
    const value = stringValue(record[name]);
    if (value) return value;
  }
  return null;
}

function returnField(
  record: Record<string, unknown> | null,
  nestedPath: string,
  flatName: string,
): string | null {
  return nestedString(record, nestedPath) ?? firstString(record, [flatName]);
}

function truncateText(value: string | null, maxLength = 120): string | null {
  if (!value) return value;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function listReturnFiles(inboxDir: string): { files: string[]; skippedMockCount: number } {
  let skippedMockCount = 0;
  const files = readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      if (entry.name.toLowerCase().startsWith("return.mock.")) {
        skippedMockCount += 1;
        return false;
      }
      return true;
    })
    .map((entry) => path.join(inboxDir, entry.name));
  return { files, skippedMockCount };
}

function readReturnInboxItem(
  workspaceRoot: string,
  filePath: string,
  warnings: string[],
): ReturnInboxItem {
  const record = readJsonFile(filePath);
  const returnId = path.basename(filePath);
  if (!record) warnings.push(`Failed to parse return: ${returnId}`);
  const taskId = returnField(record, "routing.taskId", "taskId");
  const sourceRole = returnField(record, "routing.sourceRole", "sourceRole");
  const action = returnField(record, "routing.action", "action");
  const rawSummary = returnField(record, "outcome.summary", "summary");
  const complete = Boolean(taskId && sourceRole && action && rawSummary);
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
  return {
    returnId,
    relativePath,
    taskId,
    sourceRole,
    action,
    status: "pending",
    createdAt: statSync(filePath).mtime.toISOString(),
    needsReview: true,
    summary: complete ? truncateText(rawSummary) : "[incomplete return]",
    complete,
    malformed: record === null,
  };
}

export function scanReturnInbox(
  workspaceRoot: string,
  options: ReturnInboxScanOptions = {},
): ReturnInboxScanResult {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const inboxDir = path.join(workspaceRoot, RETURNS_INBOX_RELATIVE_PATH);
  const warnings: string[] = [];

  if (!existsSync(inboxDir)) {
    warnings.push("return inbox directory missing");
    return {
      mode: "observe-only",
      scannedAt,
      inboxPath: RETURNS_INBOX_RELATIVE_PATH,
      pendingCount: 0,
      completeCount: 0,
      incompleteCount: 0,
      malformedCount: 0,
      skippedMockCount: 0,
      pendingItems: [],
      warnings,
      constraintsVerified: {
        consumed: "no",
        archived: "no",
        receiptWritten: "no",
        taskGraphMutated: "no",
        applied: "no",
      },
    };
  }

  const { files, skippedMockCount } = listReturnFiles(inboxDir);
  const pendingItems = files
    .map((filePath) => readReturnInboxItem(workspaceRoot, filePath, warnings))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const visibleItems = pendingItems.slice(0, limit);
  return {
    mode: "observe-only",
    scannedAt,
    inboxPath: RETURNS_INBOX_RELATIVE_PATH,
    pendingCount: pendingItems.length,
    completeCount: pendingItems.filter((item) => item.complete).length,
    incompleteCount: pendingItems.filter((item) => !item.complete).length,
    malformedCount: pendingItems.filter((item) => item.malformed).length,
    skippedMockCount,
    pendingItems: visibleItems,
    warnings,
    constraintsVerified: {
      consumed: "no",
      archived: "no",
      receiptWritten: "no",
      taskGraphMutated: "no",
      applied: "no",
    },
  };
}
