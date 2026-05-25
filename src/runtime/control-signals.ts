import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONTROL_SIGNALS_PENDING_RELATIVE_PATH = "system/control-signals/pending";
const G2_MARKER_RELATIVE_PATH = "runtime/main/tmp";

export const CONTROL_SIGNAL_ACTIONS = ["pause", "cancel", "interrupt", "revoke_lease"] as const;
export type ControlSignalAction = (typeof CONTROL_SIGNAL_ACTIONS)[number];

export const CONTROL_SIGNAL_STATUSES = [
  "pending",
  "acknowledged",
  "expired",
  "executed",
  "rejected",
] as const;
export type ControlSignalStatus = (typeof CONTROL_SIGNAL_STATUSES)[number];

export const CONTROL_SIGNAL_TARGET_ROLES = [
  "engineering-executive",
  "front-end-executive",
] as const;
export type ControlSignalTargetRole = (typeof CONTROL_SIGNAL_TARGET_ROLES)[number];

export interface ControlSignalIssue {
  file: string;
  field: string;
  code: string;
  message: string;
}

export interface ControlSignalItem {
  signalId: string | null;
  taskId: string | null;
  targetRole: string | null;
  action: string | null;
  status: string | null;
  reason: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  file: string;
  relativePath: string;
  valid: boolean;
  issues: ControlSignalIssue[];
}

export interface ControlSignalScanResult {
  mode: "observe-only";
  status: "ok" | "frozen" | "error";
  scannedAt: string;
  pendingPath: string;
  frozen: boolean;
  g2Approved: boolean;
  pendingCount: number;
  expiredCount: number;
  errorCount: number;
  validCount: number;
  invalidCount: number;
  byRole: { role: string; count: number }[];
  byAction: { action: string; count: number }[];
  signals: ControlSignalItem[];
  errors: ControlSignalIssue[];
  message: string;
  constraintsVerified: {
    readOnly: "yes";
    signalWritten: "no";
    taskGraphMutated: "no";
    sessionsSent: "no";
    autoDispatchTriggered: "no";
    applied: "no";
  };
}

export interface ControlSignalScanOptions {
  targetRole?: ControlSignalTargetRole | "";
  scannedAt?: string;
  now?: Date;
  respectFrozenGate?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasTextMarker(filePath: string, marker: RegExp): boolean {
  try {
    if (!existsSync(filePath)) return false;
    return marker.test(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

function detectFrozenFlag(workspaceRoot: string): boolean {
  const heartbeatPath = path.join(workspaceRoot, "HEARTBEAT.md");
  const summaryPath = path.join(workspaceRoot, "SESSION_SUMMARY.md");
  return (
    hasTextMarker(heartbeatPath, /frozen/iu) || hasTextMarker(summaryPath, /frozen flag.*active/iu)
  );
}

function detectG2Approval(workspaceRoot: string): boolean {
  const markerDir = path.join(workspaceRoot, G2_MARKER_RELATIVE_PATH);
  if (!existsSync(markerDir)) return false;

  try {
    return readdirSync(markerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^G2-APPROVED-.*\.json$/u.test(entry.name))
      .some((entry) => readJsonFile(path.join(markerDir, entry.name))?.approval === "G2");
  } catch {
    return false;
  }
}

function issue(file: string, field: string, code: string, message: string): ControlSignalIssue {
  return { file, field, code, message };
}

function validateRequiredString(
  value: string | null,
  file: string,
  field: string,
  issues: ControlSignalIssue[],
): void {
  if (!value) issues.push(issue(file, field, "missing_field", `${field} is required.`));
}

function validateEnum(
  value: string | null,
  allowed: readonly string[],
  file: string,
  field: string,
  issues: ControlSignalIssue[],
): void {
  if (value && !allowed.includes(value)) {
    issues.push(issue(file, field, "invalid_enum", `${field} is outside the allowed enum.`));
  }
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiresDate = new Date(expiresAt);
  return Number.isFinite(expiresDate.getTime()) && expiresDate < now;
}

function countBy(
  items: readonly ControlSignalItem[],
  field: "targetRole" | "action",
): {
  role?: string;
  action?: string;
  count: number;
}[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item[field];
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) =>
      field === "targetRole" ? { role: key, count } : { action: key, count },
    );
}

function baseResult(params: {
  status: ControlSignalScanResult["status"];
  scannedAt: string;
  pendingPath: string;
  frozen: boolean;
  g2Approved: boolean;
  message: string;
  signals?: ControlSignalItem[];
  errors?: ControlSignalIssue[];
}): ControlSignalScanResult {
  const signals = params.signals ?? [];
  const errors = params.errors ?? [];
  return {
    mode: "observe-only",
    status: params.status,
    scannedAt: params.scannedAt,
    pendingPath: params.pendingPath,
    frozen: params.frozen,
    g2Approved: params.g2Approved,
    pendingCount: signals.length,
    expiredCount: signals.filter((signal) => signal.expired).length,
    errorCount: errors.length,
    validCount: signals.filter((signal) => signal.valid).length,
    invalidCount: signals.filter((signal) => !signal.valid).length,
    byRole: countBy(signals, "targetRole") as { role: string; count: number }[],
    byAction: countBy(signals, "action") as { action: string; count: number }[],
    signals,
    errors,
    message: params.message,
    constraintsVerified: {
      readOnly: "yes",
      signalWritten: "no",
      taskGraphMutated: "no",
      sessionsSent: "no",
      autoDispatchTriggered: "no",
      applied: "no",
    },
  };
}

function readControlSignalItem(
  workspaceRoot: string,
  filePath: string,
  now: Date,
): ControlSignalItem {
  const file = path.basename(filePath);
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
  const record = readJsonFile(filePath);
  const issues: ControlSignalIssue[] = [];

  if (!record) {
    issues.push(issue(file, "$", "parse_failed", "Control signal JSON could not be parsed."));
  }

  const signalId = stringValue(record?.signalId);
  const taskId = stringValue(record?.taskId);
  const targetRole = stringValue(record?.targetRole);
  const action = stringValue(record?.action);
  const status = stringValue(record?.status);
  const reason = stringValue(record?.reason);
  const createdAt = stringValue(record?.createdAt);
  const expiresAt = stringValue(record?.expiresAt);

  validateRequiredString(signalId, file, "signalId", issues);
  validateRequiredString(taskId, file, "taskId", issues);
  validateRequiredString(targetRole, file, "targetRole", issues);
  validateRequiredString(action, file, "action", issues);
  validateRequiredString(status, file, "status", issues);
  validateEnum(action, CONTROL_SIGNAL_ACTIONS, file, "action", issues);
  validateEnum(status, CONTROL_SIGNAL_STATUSES, file, "status", issues);
  validateEnum(targetRole, CONTROL_SIGNAL_TARGET_ROLES, file, "targetRole", issues);

  return {
    signalId,
    taskId,
    targetRole,
    action,
    status,
    reason,
    createdAt,
    expiresAt,
    expired: isExpired(expiresAt, now),
    file,
    relativePath,
    valid: issues.length === 0,
    issues,
  };
}

export function scanControlSignals(
  workspaceRoot: string,
  options: ControlSignalScanOptions = {},
): ControlSignalScanResult {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const now = options.now ?? new Date();
  const pendingPath = CONTROL_SIGNALS_PENDING_RELATIVE_PATH;
  const frozen = detectFrozenFlag(workspaceRoot);
  const g2Approved = detectG2Approval(workspaceRoot);
  const respectFrozenGate = options.respectFrozenGate ?? true;

  if (frozen && !g2Approved && respectFrozenGate) {
    return baseResult({
      status: "frozen",
      scannedAt,
      pendingPath,
      frozen,
      g2Approved,
      message: "Scan skipped: frozen flag is active. No control signal action was taken.",
    });
  }

  const pendingDir = path.join(workspaceRoot, CONTROL_SIGNALS_PENDING_RELATIVE_PATH);
  if (!existsSync(pendingDir)) {
    return baseResult({
      status: "ok",
      scannedAt,
      pendingPath,
      frozen,
      g2Approved,
      message: "No pending control signal directory exists.",
    });
  }

  let files: string[];
  try {
    files = readdirSync(pendingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(pendingDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return baseResult({
      status: "error",
      scannedAt,
      pendingPath,
      frozen,
      g2Approved,
      message: "Cannot read pending control signal directory.",
    });
  }

  const signals = files
    .map((filePath) => readControlSignalItem(workspaceRoot, filePath, now))
    .filter((signal) => !options.targetRole || signal.targetRole === options.targetRole);
  const errors = signals.flatMap((signal) => signal.issues);
  const targetRole = options.targetRole || "";
  const message =
    signals.length === 0
      ? "No pending control signals."
      : targetRole
        ? `${signals.length} pending signal(s) for ${targetRole}.`
        : `${signals.length} pending signal(s) total (${signals.filter((signal) => signal.expired).length} expired).`;

  return baseResult({
    status: "ok",
    scannedAt,
    pendingPath,
    frozen,
    g2Approved,
    message,
    signals,
    errors,
  });
}
