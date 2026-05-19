import fs from "node:fs/promises";
import path from "node:path";
import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

export type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

async function readCheckpoint(workspaceDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "continuity_checkpoint.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

async function writeCheckpoint(
  workspaceDir: string,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "continuity_checkpoint.json"),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf-8",
  );
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function updateCheckpointInterruptState(params: {
  workspaceDir: string;
  interruptState: Record<string, unknown>;
  pendingWrites?: unknown[];
  humanGate?: Record<string, unknown>;
  rollbackHint?: Record<string, unknown>;
}): Promise<void> {
  const existing = (await readCheckpoint(params.workspaceDir)) ?? {};
  const updated: Record<string, unknown> = {
    ...existing,
    interruptState: params.interruptState,
    lastAutoWriteAt: new Date().toISOString(),
  };
  if (params.pendingWrites && params.pendingWrites.length > 0) {
    updated.pendingWrites = params.pendingWrites;
  }
  if (params.humanGate) {
    updated.humanGate = params.humanGate;
  }
  if (params.rollbackHint) {
    updated.rollbackHint = params.rollbackHint;
  }
  await writeCheckpoint(params.workspaceDir, updated);
}

export async function readCurrentInterruptState(workspaceDir: string): Promise<{
  interruptState: Record<string, unknown> | null;
  humanGate: Record<string, unknown> | null;
} | null> {
  const checkpoint = await readCheckpoint(workspaceDir);
  if (!checkpoint) {
    return null;
  }
  const interruptState =
    checkpoint.interruptState &&
    typeof checkpoint.interruptState === "object" &&
    !Array.isArray(checkpoint.interruptState)
      ? (checkpoint.interruptState as Record<string, unknown>)
      : null;
  const humanGate =
    checkpoint.humanGate &&
    typeof checkpoint.humanGate === "object" &&
    !Array.isArray(checkpoint.humanGate)
      ? (checkpoint.humanGate as Record<string, unknown>)
      : null;
  return { interruptState, humanGate };
}

export function isCandidateExpired(interruptState: Record<string, unknown>): boolean {
  const expiresAt = typeof interruptState.expiresAt === "string" ? interruptState.expiresAt : null;
  if (!expiresAt) {
    return true;
  }
  const expiresDate = new Date(expiresAt);
  return Number.isNaN(expiresDate.getTime()) || Date.now() > expiresDate.getTime();
}

export async function clearBlockedInterruptState(workspaceDir: string): Promise<void> {
  const checkpoint = await readCheckpoint(workspaceDir);
  if (!checkpoint) {
    return;
  }
  const updated: Record<string, unknown> = {};
  for (const key of ["lastAutoWriteAt", "sessionKey", "filesChecked", "summaryProtected"]) {
    if (Object.prototype.hasOwnProperty.call(checkpoint, key)) {
      updated[key] = checkpoint[key];
    }
  }
  await writeCheckpoint(workspaceDir, updated);
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey);
  if (!sessionEntry.entry) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      }),
  });
}
