import fs from "node:fs";
import path from "node:path";

import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { appendInjectedAssistantMessageToTranscript } from "./server-methods/chat-transcript-inject.js";

type NoticeSeverity = "info" | "warn" | "error";

export type NoticeDeliveryMode = "transcript" | "hud" | "silent";

export type Notice = {
  noticeId?: string;
  dedupKey?: string;
  severity?: NoticeSeverity;
  type?: string;
  deliveryMode?: NoticeDeliveryMode;
  taskId?: string;
  runId?: string;
  source?: string;
  summary?: string;
  actionRequired?: boolean;
  relatedPaths?: string[];
};

type DeliveryStateEntry = {
  noticeId: string;
  dedupKey?: string;
  type?: string;
  deliveredAt: string;
  status: "delivered" | "seen_at_startup";
};

type DeliveryState = {
  entries: DeliveryStateEntry[];
  updatedAt: string;
  totalDelivered: number;
};

type NotificationPolicyLevel = {
  transcript?: boolean;
  deliveryState?: boolean;
  immediate?: boolean;
};

type NotificationPolicyTypeMapping = {
  level?: string;
  severityOverrides?: Partial<Record<NoticeSeverity, string>>;
};

type NotificationPolicy = {
  levels?: Record<string, NotificationPolicyLevel>;
  typeMapping?: Record<string, NotificationPolicyTypeMapping>;
};

type NoticeDeliveryDecision = {
  transcript: boolean;
  deliveryState: boolean;
  immediate: boolean;
  level: string;
};

const NOTICE_FLUSH_MS = 500;
const NOTICE_READ_DELAY_MS = 300;

export function startNoticeBridge(params: {
  workspaceRoot: string;
  cfg: OpenClawConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  mainSessionTranscriptPath?: string;
  resolveTranscriptPath?: () => string | undefined;
  pollingIntervalMs?: number;
}): { stop: () => Promise<void> } {
  const inboxDir = path.join(params.workspaceRoot, "runtime", "notifications", "inbox");
  const statePath = path.join(params.workspaceRoot, "runtime", "main", "tmp", "notice-delivery-state.json");
  const mainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: "main" });
  const notificationPolicy = loadNotificationPolicy(params.workspaceRoot, params.log);
  const delivered = new Set<string>();
  const pendingByType = new Map<string, Notice[]>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: fs.FSWatcher | null = null;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const safeWarn = (message: string) => params.log.warn(`[notice-bridge] ${message}`);

  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const state = readDeliveryState(statePath);
    for (const entry of state.entries) {
      delivered.add(entry.noticeId);
    }

    watcher = fs.watch(inboxDir, (eventType, fileName) => {
      if (stopped || eventType !== "rename" || typeof fileName !== "string" || !fileName.endsWith(".json")) {
        return;
      }
      setTimeout(() => {
        void processNoticeFile(path.join(inboxDir, fileName)).catch((err) => {
          safeWarn(`process notice failed: ${String(err)}`);
        });
      }, NOTICE_READ_DELAY_MS);
    });
    void scanInboxForUndelivered().catch((err) => safeWarn(`initial scan failed: ${String(err)}`));
    const pollingIntervalMs = Math.max(1_000, params.pollingIntervalMs ?? 60_000);
    pollingTimer = setInterval(() => {
      void scanInboxForUndelivered().catch((err) => safeWarn(`polling scan failed: ${String(err)}`));
    }, pollingIntervalMs);
    pollingTimer.unref?.();
    params.log.info(`[notice-bridge] watching ${inboxDir}; polling fallback interval=${pollingIntervalMs}ms`);
  } catch (err) {
    safeWarn(`startup failed: ${String(err)}`);
  }

  async function scanInboxForUndelivered(): Promise<void> {
    if (stopped || !fs.existsSync(inboxDir)) return;
    for (const fileName of fs.readdirSync(inboxDir)) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = path.join(inboxDir, fileName);
      const notice = readNoticeFile(filePath);
      if (!notice?.noticeId) {
        // Stale/unreadable file: archive to prevent pile-up
        archiveNoticeFile(filePath);
        continue;
      }
      if (delivered.has(notice.noticeId)) {
        // Already delivered in-memory: clean up leftover file
        archiveNoticeFile(filePath);
        continue;
      }
      await processNoticeFile(filePath);
      // Archive after processing (even if silent/skipped) to prevent inbox accumulation
      archiveNoticeFile(filePath);
    }
  }

  async function processNoticeFile(filePath: string): Promise<void> {
    if (stopped || !fs.existsSync(filePath)) return;
    const notice = readNoticeFile(filePath);
    if (!isDeliverableNotice(notice)) return;
    if (delivered.has(notice.noticeId)) return;

    delivered.add(notice.noticeId);
    const decision = getNoticeDeliveryDecision(notice, notificationPolicy);
    if (!decision.deliveryState && !decision.transcript) return;

    const type = notice.type ?? "unknown";
    if (decision.transcript && decision.immediate) {
      await flushNotices(type, [notice]);
      return;
    }

    const existing = pendingByType.get(type) ?? [];
    existing.push(notice);
    pendingByType.set(type, existing);
    if (!flushTimers.has(type)) {
      const timer = setTimeout(() => {
        flushTimers.delete(type);
        const batch = pendingByType.get(type) ?? [];
        pendingByType.delete(type);
        void flushNotices(type, batch).catch((err) => safeWarn(`flush failed: ${String(err)}`));
      }, NOTICE_FLUSH_MS);
      flushTimers.set(type, timer);
    }
  }

  async function flushNotices(type: string, notices: Notice[]): Promise<void> {
    const batch = notices.filter((notice) => notice.noticeId);
    if (batch.length === 0) return;
    const transcriptBatch = batch.filter((notice) => getNoticeDeliveryDecision(notice, notificationPolicy).transcript);
    if (transcriptBatch.length > 0) {
      const text = formatNoticeMessage(transcriptBatch);
      // enqueueSystemEvent disabled: Active Push uses transcript append + WebSocket broadcast instead.
      // Fallback kept for emergency: uncomment line below if transcript path is unavailable.
      // enqueueSystemEvent(text, { sessionKey: mainSessionKey });
      injectNoticesToActiveTranscript(transcriptBatch, text);
    }
    const state = readDeliveryState(statePath);
    const nowIso = new Date().toISOString();
    const existing = new Set(state.entries.map((entry) => entry.noticeId));
    for (const notice of batch) {
      if (!notice.noticeId || existing.has(notice.noticeId)) continue;
      if (!getNoticeDeliveryDecision(notice, notificationPolicy).deliveryState) continue;
      state.entries.push({
        noticeId: notice.noticeId,
        dedupKey: notice.dedupKey,
        type,
        deliveredAt: nowIso,
        status: "delivered",
      });
      existing.add(notice.noticeId);
    }
    writeDeliveryState(statePath, state);
  }

  function injectNoticesToActiveTranscript(batch: Notice[], batchText: string): void {
    // Dynamic path resolution: re-resolve at injection time for session changes
    let transcriptPath: string | undefined = undefined;
    if (params.resolveTranscriptPath) {
      transcriptPath = params.resolveTranscriptPath();
    }
    if (!transcriptPath) {
      transcriptPath = params.mainSessionTranscriptPath;
    }
    if (!transcriptPath) {
      params.log.warn("[notice-bridge] transcriptPath not resolved — notice will not be injected");
      return;
    }
    if (!fs.existsSync(transcriptPath)) {
      params.log.warn(`[notice-bridge] transcriptPath not found: ${transcriptPath} — notice will not be injected`);
      return;
    }
    for (const notice of batch) {
      if (!notice.noticeId) continue;
      appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: batch.length === 1 ? batchText : formatNoticeMessage([notice]),
        label: "自动推进通知",
        idempotencyKey: notice.noticeId,
      });
    }
  }

  return {
    stop: async () => {
      stopped = true;
      for (const timer of flushTimers.values()) clearTimeout(timer);
      flushTimers.clear();
      pendingByType.clear();
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

function readNoticeFile(filePath: string): Notice | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Notice;
  } catch {
    return null;
  }
}

function isDeliverableNotice(notice: Notice | null): notice is Notice & { noticeId: string; type: string; severity: NoticeSeverity } {
  return Boolean(notice?.noticeId && notice.type && notice.severity);
}

function archiveNoticeFile(filePath: string): void {
  try {
    const archiveDir = path.join(path.dirname(filePath), "..", "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const destPath = path.join(archiveDir, path.basename(filePath));
    fs.renameSync(filePath, destPath);
  } catch {
    // fail-soft: file may already be archived or removed
  }
}

function loadNotificationPolicy(workspaceRoot: string, log: { info?: (msg: string) => void; warn: (msg: string) => void }): NotificationPolicy {
  try {
    const policyPath = path.join(workspaceRoot, "system", "protocols", "notification-policy.json");
    if (!fs.existsSync(policyPath)) throw new Error("policy file not found");
    log.info?.(`[notice-bridge] policy source: file (notification-policy.json)`);
    return JSON.parse(fs.readFileSync(policyPath, "utf-8")) as NotificationPolicy;
  } catch (err) {
    log.warn(`[notice-bridge] policy source: hardcoded fallback (${String(err)})`);
    return getFallbackPolicy();
  }
}

export function getFallbackPolicy(): NotificationPolicy {
  return {
    levels: {
      critical: { transcript: true, deliveryState: true, immediate: true },
      action_required: { transcript: true, deliveryState: true, immediate: true },
      hud_only: { transcript: false, deliveryState: true, immediate: false },
      silent: { transcript: false, deliveryState: false, immediate: false },
    },
    typeMapping: {
      human_gate_required: { level: "action_required" },
      service_error: { level: "critical" },
      service_stopped: { level: "action_required" },
      task_completed: { level: "action_required" },
      next_candidate_generated: { level: "hud_only" },
      auto_progress_blocked: { level: "hud_only" },
      return_auto_processed: { level: "hud_only" },
      auto_close_eligible: { level: "hud_only" },
      _default: { level: "hud_only" },
    },
  };
}

export function getNoticeDeliveryDecision(notice: Notice, policy: NotificationPolicy = getFallbackPolicy()): NoticeDeliveryDecision {
  if (notice.deliveryMode === "transcript") {
    return { transcript: true, deliveryState: true, immediate: true, level: "deliveryMode:transcript" };
  }
  if (notice.deliveryMode === "hud") {
    return { transcript: false, deliveryState: true, immediate: false, level: "deliveryMode:hud" };
  }
  if (notice.deliveryMode === "silent") {
    return { transcript: false, deliveryState: false, immediate: false, level: "deliveryMode:silent" };
  }

  const type = notice.type ?? "_default";
  const mapping = policy.typeMapping?.[type] ?? policy.typeMapping?._default ?? { level: "hud_only" };
  const levelName = mapping.severityOverrides?.[notice.severity ?? "info"] ?? mapping.level ?? "hud_only";
  const level = policy.levels?.[levelName] ?? policy.levels?.hud_only ?? { transcript: false, deliveryState: true };
  const transcript = levelName === "digest" ? false : level.transcript === true;
  return {
    transcript,
    deliveryState: level.deliveryState !== false,
    immediate: level.immediate === true,
    level: levelName,
  };
}

export function shouldInjectToTranscript(notice: Notice, policy: NotificationPolicy = getFallbackPolicy()): boolean {
  return getNoticeDeliveryDecision(notice, policy).transcript;
}

function formatNoticeMessage(notices: Notice[]): string {
  if (notices.length > 1) {
    const first = notices[0];
    const lines = notices.map((notice) => `  - ${notice.taskId ?? "unknown"}: ${notice.summary ?? ""}`.trimEnd());
    return [
      "【自动推进通知】",
      `- 任务：${first?.taskId ?? "批量通知"} 等 ${notices.length} 项`,
      `- 状态：${statusLabel(first)}`,
      `- 执行岗：${first?.source ?? "unknown"}`,
      `- 是否需要老大处理：${notices.some((notice) => notice.actionRequired) ? "是" : "否"}`,
      "- 摘要：",
      ...lines,
      `- 相关路径：${joinRelatedPaths(notices)}`,
    ].join("\n");
  }
  const notice = notices[0];
  return [
    "【自动推进通知】",
    `- 任务：${notice.taskId ?? "unknown"}`,
    `- 状态：${statusLabel(notice)}`,
    `- 执行岗：${notice.source ?? "unknown"}`,
    `- 是否需要老大处理：${notice.actionRequired ? "是" : "否"}`,
    `- 摘要：${notice.summary ?? ""}`,
    `- 相关路径：${joinRelatedPaths(notices)}`,
  ].join("\n");
}

function statusLabel(notice: Notice | undefined): string {
  switch (notice?.type) {
    case "task_completed":
    case "next_candidate_generated":
      return "已完成";
    case "human_gate_required":
      return "需要审批";
    case "service_error":
      return "服务异常";
    case "auto_progress_blocked":
    case "service_stopped":
      return "被阻塞";
    default:
      return notice?.severity === "error" ? "服务异常" : "已完成";
  }
}

function joinRelatedPaths(notices: Notice[]): string {
  const paths = notices.flatMap((notice) => notice.relatedPaths ?? []).filter(Boolean);
  return paths.length > 0 ? paths.join(", ") : "无";
}

function readDeliveryState(statePath: string): DeliveryState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Partial<DeliveryState>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      totalDelivered: typeof parsed.totalDelivered === "number" ? parsed.totalDelivered : 0,
    };
  } catch {
    return { entries: [], updatedAt: new Date().toISOString(), totalDelivered: 0 };
  }
}

function writeDeliveryState(statePath: string, state: DeliveryState): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const deliveredCount = state.entries.filter((entry) => entry.status === "delivered").length;
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString(), totalDelivered: deliveredCount }, null, 2),
      "utf-8",
    );
  } catch {
    // fail-soft
  }
}
