import fs from "node:fs";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
} from "./runtime-internal.js";
import {
  configureTaskAuditTaskProvider,
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import type { TaskAuditSummary } from "./task-registry.audit.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;

/**
 * Number of tasks to process before yielding to the event loop.
 * Keeps the main thread responsive during large sweeps without splitting
 * normal-sized startup maintenance into many delayed Windows setImmediate turns.
 */
const SWEEP_YIELD_BATCH_SIZE = 500;

let sweeper: NodeJS.Timeout | null = null;
let deferredSweep: NodeJS.Timeout | null = null;
let sweepInProgress = false;

type TaskRegistryMaintenanceRuntime = {
  readAcpSessionEntry: typeof readAcpSessionEntry;
  loadSessionStore: typeof loadSessionStore;
  resolveStorePath: typeof resolveStorePath;
  isCronJobActive: typeof isCronJobActive;
  getAgentRunContext: typeof getAgentRunContext;
  parseAgentSessionKey: typeof parseAgentSessionKey;
  deleteTaskRecordById: typeof deleteTaskRecordById;
  ensureTaskRegistryReady: typeof ensureTaskRegistryReady;
  getTaskById: typeof getTaskById;
  listTaskRecords: typeof listTaskRecords;
  markTaskLostById: typeof markTaskLostById;
  maybeDeliverTaskTerminalUpdate: typeof maybeDeliverTaskTerminalUpdate;
  resolveTaskForLookupToken: typeof resolveTaskForLookupToken;
  setTaskCleanupAfterById: typeof setTaskCleanupAfterById;
};

const defaultTaskRegistryMaintenanceRuntime: TaskRegistryMaintenanceRuntime = {
  readAcpSessionEntry,
  loadSessionStore,
  resolveStorePath,
  isCronJobActive,
  getAgentRunContext,
  parseAgentSessionKey,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
};

let taskRegistryMaintenanceRuntime: TaskRegistryMaintenanceRuntime =
  defaultTaskRegistryMaintenanceRuntime;

export type TaskRegistryMaintenanceSummary = {
  reconciled: number;
  cleanupStamped: number;
  pruned: number;
};

type SessionStoreCache = Map<string, Record<string, unknown>>;
type SessionStoreKeySnapshot = {
  exact: Set<string>;
  normalized: Set<string>;
};
type SessionStoreKeyCache = Map<string, SessionStoreKeySnapshot>;
type SessionLookupCaches = {
  stores: SessionStoreCache;
  keys: SessionStoreKeyCache;
};

function findSessionEntryByKey(store: Record<string, unknown>, sessionKey: string): unknown {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  for (const [key, entry] of Object.entries(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === normalized) {
      return entry;
    }
  }
  return undefined;
}

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTerminalTask(task: TaskRecord): boolean {
  return !isActiveTask(task);
}

function hasLostGraceExpired(task: TaskRecord, now: number): boolean {
  const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  return now - referenceAt >= TASK_RECONCILE_GRACE_MS;
}

function hasActiveCliRun(task: TaskRecord): boolean {
  const candidateRunIds = [task.sourceId, task.runId];
  for (const candidate of candidateRunIds) {
    const runId = candidate?.trim();
    if (runId && taskRegistryMaintenanceRuntime.getAgentRunContext(runId)) {
      return true;
    }
  }
  return false;
}

function loadCachedSessionStore(
  storePath: string,
  sessionStoreCache: SessionStoreCache,
): Record<string, unknown> {
  const cached = sessionStoreCache.get(storePath);
  if (cached) {
    return cached;
  }
  const store = taskRegistryMaintenanceRuntime.loadSessionStore(storePath);
  sessionStoreCache.set(storePath, store);
  return store;
}

function readDefaultSessionStoreKeySnapshot(storePath: string): SessionStoreKeySnapshot {
  const exact = new Set<string>();
  const normalized = new Set<string>();
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { exact, normalized };
      }
      for (const key of Object.keys(parsed)) {
        exact.add(key);
        const normalizedKey = normalizeLowercaseStringOrEmpty(key);
        if (normalizedKey) {
          normalized.add(normalizedKey);
        }
      }
      return { exact, normalized };
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }
  return { exact, normalized };
}

function hasCachedSessionStoreKey(
  storePath: string,
  sessionKey: string,
  sessionStoreKeyCache: SessionStoreKeyCache,
): boolean {
  let snapshot = sessionStoreKeyCache.get(storePath);
  if (!snapshot) {
    snapshot = readDefaultSessionStoreKeySnapshot(storePath);
    sessionStoreKeyCache.set(storePath, snapshot);
  }
  if (snapshot.exact.has(sessionKey)) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  return normalized ? snapshot.normalized.has(normalized) : false;
}

function hasBackingSession(task: TaskRecord, sessionLookupCaches?: SessionLookupCaches): boolean {
  if (task.runtime === "cron") {
    const jobId = task.sourceId?.trim();
    return jobId ? taskRegistryMaintenanceRuntime.isCronJobActive(jobId) : false;
  }

  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return true;
  }
  if (task.runtime === "acp") {
    const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({
      sessionKey: childSessionKey,
    });
    if (!acpEntry || acpEntry.storeReadFailed) {
      return true;
    }
    return Boolean(acpEntry.entry);
  }
  if (task.runtime === "subagent" || task.runtime === "cli") {
    if (task.runtime === "cli") {
      const chatType = deriveSessionChatTypeFromKey(childSessionKey);
      if (chatType === "channel" || chatType === "group" || chatType === "direct") {
        return hasActiveCliRun(task);
      }
    }
    const agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
    const storePath = taskRegistryMaintenanceRuntime.resolveStorePath(undefined, { agentId });
    if (taskRegistryMaintenanceRuntime === defaultTaskRegistryMaintenanceRuntime) {
      const hasSessionKey = hasCachedSessionStoreKey(
        storePath,
        childSessionKey,
        sessionLookupCaches?.keys ?? new Map(),
      );
      return hasSessionKey || (task.runtime === "cli" && hasActiveCliRun(task));
    }
    const store = loadCachedSessionStore(storePath, sessionLookupCaches?.stores ?? new Map());
    const hasSessionEntry = Boolean(findSessionEntryByKey(store, childSessionKey));
    return hasSessionEntry || (task.runtime === "cli" && hasActiveCliRun(task));
  }

  return true;
}

function shouldMarkLost(
  task: TaskRecord,
  now: number,
  sessionLookupCaches?: SessionLookupCaches,
): boolean {
  if (!isActiveTask(task)) {
    return false;
  }
  if (!hasLostGraceExpired(task, now)) {
    return false;
  }
  return !hasBackingSession(task, sessionLookupCaches);
}

function shouldPruneTerminalTask(task: TaskRecord, now: number): boolean {
  if (!isTerminalTask(task)) {
    return false;
  }
  if (typeof task.cleanupAfter === "number") {
    return now >= task.cleanupAfter;
  }
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return now - terminalAt >= TASK_RETENTION_MS;
}

function shouldStampCleanupAfter(task: TaskRecord): boolean {
  return isTerminalTask(task) && typeof task.cleanupAfter !== "number";
}

function resolveCleanupAfter(task: TaskRecord): number {
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return terminalAt + TASK_RETENTION_MS;
}

function markTaskLost(task: TaskRecord, now: number): TaskRecord {
  const cleanupAfter = task.cleanupAfter ?? projectTaskLost(task, now).cleanupAfter;
  const updated =
    taskRegistryMaintenanceRuntime.markTaskLostById({
      taskId: task.taskId,
      endedAt: task.endedAt ?? now,
      lastEventAt: now,
      error: task.error ?? "backing session missing",
      cleanupAfter,
    }) ?? task;
  void taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

function projectTaskLost(task: TaskRecord, now: number): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: "lost",
    endedAt: task.endedAt ?? now,
    lastEventAt: now,
    error: task.error ?? "backing session missing",
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveCleanupAfter(projected) }),
  };
}

export function reconcileTaskRecordForOperatorInspection(task: TaskRecord): TaskRecord {
  const now = Date.now();
  if (!shouldMarkLost(task, now)) {
    return task;
  }
  return projectTaskLost(task, now);
}

export function reconcileInspectableTasks(): TaskRecord[] {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  const sessionLookupCaches: SessionLookupCaches = { stores: new Map(), keys: new Map() };
  return taskRegistryMaintenanceRuntime
    .listTaskRecords()
    .map((task) =>
      shouldMarkLost(task, now, sessionLookupCaches) ? projectTaskLost(task, now) : task,
    );
}

configureTaskAuditTaskProvider(reconcileInspectableTasks);

export function getInspectableTaskRegistrySummary(): TaskRegistrySummary {
  return summarizeTaskRecords(reconcileInspectableTasks());
}

export function getInspectableTaskAuditSummary(): TaskAuditSummary {
  const tasks = reconcileInspectableTasks();
  return summarizeTaskAuditFindings(listTaskAuditFindings({ tasks }));
}

export function reconcileTaskLookupToken(token: string): TaskRecord | undefined {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const task = taskRegistryMaintenanceRuntime.resolveTaskForLookupToken(token);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}

export function previewTaskRegistryMaintenance(): TaskRegistryMaintenanceSummary {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  const sessionLookupCaches: SessionLookupCaches = { stores: new Map(), keys: new Map() };
  let reconciled = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
    if (shouldMarkLost(task, now, sessionLookupCaches)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneTerminalTask(task, now)) {
      pruned += 1;
      continue;
    }
    if (shouldStampCleanupAfter(task)) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, cleanupStamped, pruned };
}

/**
 * Yield control back to the event loop so that pending I/O callbacks,
 * timers, and incoming requests can be processed between batches of
 * synchronous task-registry maintenance work.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function startScheduledSweep() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  const clearSweepInProgress = () => {
    sweepInProgress = false;
  };
  sweepTaskRegistry().then(clearSweepInProgress, clearSweepInProgress);
}

export async function runTaskRegistryMaintenance(): Promise<TaskRegistryMaintenanceSummary> {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  const sessionLookupCaches: SessionLookupCaches = { stores: new Map(), keys: new Map() };
  let reconciled = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
  let processed = 0;
  for (const task of tasks) {
    const current = taskRegistryMaintenanceRuntime.getTaskById(task.taskId);
    if (!current) {
      continue;
    }
    if (shouldMarkLost(current, now, sessionLookupCaches)) {
      const next = markTaskLost(current, now);
      if (next.status === "lost") {
        reconciled += 1;
      }
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (
      shouldPruneTerminalTask(current, now) &&
      taskRegistryMaintenanceRuntime.deleteTaskRecordById(current.taskId)
    ) {
      pruned += 1;
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (
      shouldStampCleanupAfter(current) &&
      taskRegistryMaintenanceRuntime.setTaskCleanupAfterById({
        taskId: current.taskId,
        cleanupAfter: resolveCleanupAfter(current),
      })
    ) {
      cleanupStamped += 1;
    }
    processed += 1;
    if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }
  return { reconciled, cleanupStamped, pruned };
}

export async function sweepTaskRegistry(): Promise<TaskRegistryMaintenanceSummary> {
  return runTaskRegistryMaintenance();
}

export function startTaskRegistryMaintenance() {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  deferredSweep = setTimeout(() => {
    deferredSweep = null;
    startScheduledSweep();
  }, 5_000);
  deferredSweep.unref?.();
  if (sweeper) {
    return;
  }
  sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopTaskRegistryMaintenance() {
  if (deferredSweep) {
    clearTimeout(deferredSweep);
    deferredSweep = null;
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  sweepInProgress = false;
}

export const stopTaskRegistryMaintenanceForTests = stopTaskRegistryMaintenance;

export function setTaskRegistryMaintenanceRuntimeForTests(
  runtime: TaskRegistryMaintenanceRuntime,
): void {
  taskRegistryMaintenanceRuntime = runtime;
}

export function resetTaskRegistryMaintenanceRuntimeForTests(): void {
  taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
}

export function getReconciledTaskById(taskId: string): TaskRecord | undefined {
  const task = getTaskById(taskId);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
