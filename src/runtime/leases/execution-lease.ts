import { readFileSync } from "node:fs";

export type ExecutionLeaseVerdict = "LEASE_ACTIVE" | "EXECUTION_STALLED" | "HARD_STOP";

export interface ExecutionLeaseTaskMetadata {
  taskId?: string;
  phase?: string;
  runId?: string;
}

export interface ExecutionLeaseConfig {
  noProgressTimeoutSec?: number;
  hardStopSec?: number;
}

export interface ExecutionLeaseSignal {
  type: "assistant" | "toolResult" | "ROLE_RETURN_PACKAGE";
  at: string;
  lineIndex: number;
}

export interface ExecutionLeaseEvaluationInput {
  transcriptLines: string[];
  taskMetadata: ExecutionLeaseTaskMetadata;
  config?: ExecutionLeaseConfig;
  now?: string | Date;
}

export interface ExecutionLeaseEvaluation {
  reportType: "execution-lease-verdict";
  evaluatedAt: string;
  leaseVerdict: ExecutionLeaseVerdict;
  task: {
    taskId: string;
    phase: string;
    runId: string;
  };
  source: {
    totalLines: number;
    messageLines: number;
  };
  evidence: {
    lastProgressAt: string | null;
    timeSinceLastProgressSec: number;
    noProgressTimeoutSec: number;
    noProgressExpired: boolean;
    hardStopSec: number;
    hardStopAt: string | null;
    hardStopReached: boolean;
    firstAssignedTaskAt: string | null;
    timeSinceDispatchSec: number;
    progressSignals: string[];
    assistantMessageCount: number;
    toolResultCount: number;
    roleReturnPackageDetected: boolean;
    signalLog: ExecutionLeaseSignal[];
    stallReason: string;
  };
  constraintsVerified: {
    readOnly: "yes";
    humanGateCandidateWritten: "no";
    sessionKilled: "no";
    sessionRestarted: "no";
    autoRecoveryTriggered: "no";
    applied: "no";
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTranscriptLine(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function messageRecord(entry: JsonRecord): JsonRecord | null {
  return isRecord(entry.message) ? entry.message : null;
}

function messageText(message: JsonRecord): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function resolveNow(value: string | Date | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = parseDate(value);
    if (parsed) return parsed;
  }
  return new Date();
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function secondsBetween(now: Date, then: Date | null): number {
  return then ? Math.max(0, (now.getTime() - then.getTime()) / 1000) : -1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function evaluateExecutionLease(
  input: ExecutionLeaseEvaluationInput,
): ExecutionLeaseEvaluation {
  const now = resolveNow(input.now);
  const noProgressTimeoutSec = numberOrDefault(input.config?.noProgressTimeoutSec, 300);
  const hardStopSec = numberOrDefault(input.config?.hardStopSec, 1800);
  const entries = input.transcriptLines
    .map(parseTranscriptLine)
    .filter((entry): entry is JsonRecord => Boolean(entry));
  const taskId = input.taskMetadata.taskId?.trim() || "unknown";

  let taskDispatchAt: Date | null = null;
  let dispatchLineIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    const message = messageRecord(entry);
    if (!message || message.role !== "user") continue;
    const timestamp = parseDate(entry.timestamp);
    if (!timestamp) continue;
    const content = messageText(message);
    if (taskId !== "unknown" && content.includes(taskId)) {
      taskDispatchAt = timestamp;
      dispatchLineIndex = index;
      break;
    }
  }

  if (!taskDispatchAt) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.type !== "message") continue;
      const message = messageRecord(entry);
      if (!message || message.role !== "user") continue;
      const timestamp = parseDate(entry.timestamp);
      if (!timestamp) continue;
      taskDispatchAt = timestamp;
      dispatchLineIndex = index;
      break;
    }
  }

  const signals: ExecutionLeaseSignal[] = [];
  let lastProgressAt: Date | null = null;
  let roleReturnPackageDetected = false;
  let assistantMessageCount = 0;
  let toolResultCount = 0;
  let messageLines = 0;

  entries.forEach((entry, index) => {
    if (entry.type !== "message") return;
    messageLines += 1;
    const message = messageRecord(entry);
    if (!message) return;
    const timestamp = parseDate(entry.timestamp);
    if (!timestamp) return;
    if (taskDispatchAt && timestamp < taskDispatchAt) return;
    const role = typeof message.role === "string" ? message.role : "";
    const content = messageText(message);
    if (role === "assistant") {
      assistantMessageCount += 1;
      lastProgressAt = timestamp;
      signals.push({ type: "assistant", at: timestamp.toISOString(), lineIndex: index });
      if (/ROLE_RETURN_PACKAGE_START|ROLE_RETURN_PACKAGE_V1/u.test(content)) {
        roleReturnPackageDetected = true;
        signals.push({
          type: "ROLE_RETURN_PACKAGE",
          at: timestamp.toISOString(),
          lineIndex: index,
        });
      }
    } else if (role === "toolResult") {
      toolResultCount += 1;
      lastProgressAt = timestamp;
      signals.push({ type: "toolResult", at: timestamp.toISOString(), lineIndex: index });
    }
  });

  const timeoutBasis = lastProgressAt ?? taskDispatchAt;
  const timeSinceLastProgressSec = secondsBetween(now, timeoutBasis);
  const timeSinceDispatchSec = secondsBetween(now, taskDispatchAt);
  const noProgressExpired =
    timeSinceLastProgressSec >= 0 && timeSinceLastProgressSec >= noProgressTimeoutSec;
  const hardStopReached = timeSinceLastProgressSec >= 0 && timeSinceLastProgressSec >= hardStopSec;
  const leaseVerdict: ExecutionLeaseVerdict = roleReturnPackageDetected
    ? "LEASE_ACTIVE"
    : hardStopReached
      ? "HARD_STOP"
      : noProgressExpired
        ? "EXECUTION_STALLED"
        : "LEASE_ACTIVE";

  const progressSignals = unique(signals.map((signal) => signal.type));
  const stallReason =
    leaseVerdict === "LEASE_ACTIVE"
      ? lastProgressAt
        ? `Session active: last progress ${Math.round(timeSinceLastProgressSec)}s ago.`
        : "Session active: no progress timeout reached yet."
      : leaseVerdict === "HARD_STOP"
        ? `Hard stop exceeded: ${Math.round(timeSinceLastProgressSec)}s >= ${hardStopSec}s.`
        : `No progress for ${Math.round(timeSinceLastProgressSec)}s >= ${noProgressTimeoutSec}s.`;

  return {
    reportType: "execution-lease-verdict",
    evaluatedAt: now.toISOString(),
    leaseVerdict,
    task: {
      taskId,
      phase: input.taskMetadata.phase?.trim() || "unknown",
      runId: input.taskMetadata.runId?.trim() || "unknown",
    },
    source: {
      totalLines: entries.length,
      messageLines,
    },
    evidence: {
      lastProgressAt: (lastProgressAt as Date | null)?.toISOString() ?? null,
      timeSinceLastProgressSec: Math.round(timeSinceLastProgressSec * 1000) / 1000,
      noProgressTimeoutSec,
      noProgressExpired,
      hardStopSec,
      hardStopAt:
        taskDispatchAt && dispatchLineIndex >= 0
          ? new Date(taskDispatchAt.getTime() + hardStopSec * 1000).toISOString()
          : null,
      hardStopReached,
      firstAssignedTaskAt: taskDispatchAt?.toISOString() ?? null,
      timeSinceDispatchSec: Math.round(timeSinceDispatchSec * 1000) / 1000,
      progressSignals,
      assistantMessageCount,
      toolResultCount,
      roleReturnPackageDetected,
      signalLog: signals.slice(-8),
      stallReason,
    },
    constraintsVerified: {
      readOnly: "yes",
      humanGateCandidateWritten: "no",
      sessionKilled: "no",
      sessionRestarted: "no",
      autoRecoveryTriggered: "no",
      applied: "no",
    },
  };
}

export function evaluateExecutionLeaseFromFiles(params: {
  transcriptPath: string;
  taskMetadataPath: string;
  configPath?: string;
  now?: string | Date;
}): ExecutionLeaseEvaluation {
  const transcriptLines = readFileSync(params.transcriptPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const taskMetadata = JSON.parse(
    readFileSync(params.taskMetadataPath, "utf8").replace(/^\uFEFF/u, ""),
  ) as ExecutionLeaseTaskMetadata;
  const config = params.configPath
    ? (JSON.parse(
        readFileSync(params.configPath, "utf8").replace(/^\uFEFF/u, ""),
      ) as ExecutionLeaseConfig)
    : undefined;
  return evaluateExecutionLease({
    transcriptLines,
    taskMetadata,
    config,
    now: params.now,
  });
}
