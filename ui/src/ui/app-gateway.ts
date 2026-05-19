import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import {
  CHAT_SESSIONS_ACTIVE_MINUTES,
  clearPendingQueueItemsForRun,
  flushChatQueueForEvent,
} from "./app-chat.ts";
import type { EventLogEntry } from "./app-events.ts";
import {
  applySettings,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings.ts";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream.ts";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";
import { parseChatSideResult, type ChatSideResult } from "./chat/side-result.ts";
import { formatConnectError } from "./connect-error.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
import {
  loadAssistantIdentity,
  type AssistantIdentityState,
} from "./controllers/assistant-identity.ts";
import {
  loadChatHistory,
  handleChatEvent,
  type ChatEventPayload,
  type ChatState,
} from "./controllers/chat.ts";
import { loadDevices, type DevicesState } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
  removeExecApproval,
} from "./controllers/exec-approval.ts";
import { loadHealthState, type HealthState } from "./controllers/health.ts";
import { loadNodes, type NodesState } from "./controllers/nodes.ts";
import { loadSessions, subscribeSessions, type SessionsState } from "./controllers/sessions.ts";
import {
  resolveGatewayErrorDetailCode,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "./gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type {
  AgentsListResult,
  PresenceEntry,
  HealthSummary,
  StatusSummary,
  UpdateAvailable,
} from "./types.ts";

function isGenericBrowserFetchFailure(message: string): boolean {
  return /^(?:typeerror:\s*)?(?:fetch failed|failed to fetch)$/i.test(message.trim());
}

type GatewayHost = {
  settings: UiSettings;
  password: string;
  clientInstanceId: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  healthLoading: boolean;
  healthResult: HealthSummary | null;
  healthError: string | null;
  debugHealth: HealthSummary | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  sessionKey: string;
  chatLoading: boolean;
  chatRunId: string | null;
  refreshSessionsAfterChat: Set<string>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  updateAvailable: UpdateAvailable | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

type GatewayHostWithShutdownMessage = GatewayHost & {
  pendingShutdownMessage?: string | null;
  resumeChatQueueAfterReconnect?: boolean;
};

type GatewayHostWithSideResults = GatewayHost & {
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
};

function isTerminalChatState(
  state: ChatEventPayload["state"] | ReturnType<typeof handleChatEvent> | null | undefined,
): state is "final" | "aborted" | "error" {
  return state === "final" || state === "aborted" || state === "error";
}

type ConnectGatewayOptions = {
  reason?: "initial" | "seq-gap";
};

export function resolveControlUiClientVersion(params: {
  gatewayUrl: string;
  serverVersion: string | null;
  pageUrl?: string;
}): string | undefined {
  const serverVersion = params.serverVersion?.trim();
  if (!serverVersion) {
    return undefined;
  }
  const pageUrl =
    params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!pageUrl) {
    return undefined;
  }
  try {
    const page = new URL(pageUrl);
    const gateway = new URL(params.gatewayUrl, page);
    const allowedProtocols = new Set(["ws:", "wss:", "http:", "https:"]);
    if (!allowedProtocols.has(gateway.protocol) || gateway.host !== page.host) {
      return undefined;
    }
    return serverVersion;
  } catch {
    return undefined;
  }
}

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }

  // Detect if user has already selected a specific session (not an alias like "main").
  // If normalization doesn't change the value, it's a user-selected session.
  const normalizedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const isUserSelectedSession = normalizedSessionKey === host.sessionKey;

  if (isUserSelectedSession) {
    // User has selected a specific session; preserve their choice
    // Only normalize lastActiveSessionKey, don't override current sessionKey
    const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
      host.settings.lastActiveSessionKey,
      defaults,
    );
    if (resolvedLastActiveSessionKey !== host.settings.lastActiveSessionKey) {
      applySettings(host as unknown as Parameters<typeof applySettings>[0], {
        ...host.settings,
        lastActiveSessionKey: resolvedLastActiveSessionKey,
      });
    }
    return; // Keep user's session selection
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

export function connectGateway(host: GatewayHost, options?: ConnectGatewayOptions) {
  const shutdownHost = host as GatewayHostWithShutdownMessage;
  const reconnectReason = options?.reason ?? "initial";
  shutdownHost.pendingShutdownMessage = null;
  shutdownHost.resumeChatQueueAfterReconnect = false;
  host.lastError = null;
  host.lastErrorCode = null;
  host.hello = null;
  host.connected = false;
  if (reconnectReason === "seq-gap") {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
    clearPendingQueueItemsForRun(
      host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
      host.chatRunId ?? undefined,
    );
    shutdownHost.resumeChatQueueAfterReconnect = true;
  } else {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
  }
  host.execApprovalError = null;

  const previousClient = host.client;
  const clientVersion = resolveControlUiClientVersion({
    gatewayUrl: host.settings.gatewayUrl,
    serverVersion: host.serverVersion,
  });
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    clientVersion,
    mode: "webchat",
    instanceId: host.clientInstanceId,
    onHello: (hello) => {
      if (host.client !== client) {
        return;
      }
      shutdownHost.pendingShutdownMessage = null;
      host.connected = true;
      host.lastError = null;
      host.lastErrorCode = null;
      host.hello = hello;
      applySnapshot(host, hello);
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      (host as GatewayHostWithSideResults).chatSideResultTerminalRuns?.clear();
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      host.chatLoading = false;
      if (shutdownHost.resumeChatQueueAfterReconnect) {
        // The interrupted run will never emit its terminal event now that the
        // old client is gone, so resume any deferred commands after hello.
        shutdownHost.resumeChatQueueAfterReconnect = false;
        void flushChatQueueForEvent(
          host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
        );
      }
      void subscribeSessions(host as unknown as SessionsState);
      void loadAssistantIdentity(host as unknown as AssistantIdentityState);
      void loadAgents(host as unknown as AgentsState);
      void loadHealthState(host as unknown as HealthState);
      void loadNodes(host as unknown as NodesState, { quiet: true });
      void loadDevices(host as unknown as DevicesState, { quiet: true });
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
    },
    onClose: ({ code, reason, error }) => {
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      host.lastErrorCode =
        resolveGatewayErrorDetailCode(error) ??
        (typeof error?.code === "string" ? error.code : null);
      if (code !== 1012) {
        if (error?.message) {
          host.lastError =
            host.lastErrorCode && isGenericBrowserFetchFailure(error.message)
              ? formatConnectError({
                  message: error.message,
                  details: error.details,
                  code: error.code,
                } as Parameters<typeof formatConnectError>[0])
              : error.message;
          return;
        }
        host.lastError =
          shutdownHost.pendingShutdownMessage ?? `disconnected (${code}): ${reason || "no reason"}`;
      } else {
        host.lastError = shutdownHost.pendingShutdownMessage ?? null;
        host.lastErrorCode = null;
      }
    },
    onEvent: (evt) => {
      if (host.client !== client) {
        return;
      }
      handleGatewayEvent(host, evt);
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); reconnecting`;
      host.lastErrorCode = null;
      connectGateway(host, { reason: "seq-gap" });
    },
  });
  host.client = client;
  previousClient?.stop();
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleTerminalChatEvent(
  host: GatewayHost,
  payload: ChatEventPayload | undefined,
  state: ReturnType<typeof handleChatEvent>,
): boolean {
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  // Check if tool events were seen before resetting (resetToolStream clears toolStreamOrder).
  const toolHost = host as unknown as Parameters<typeof resetToolStream>[0];
  const hadToolEvents = toolHost.toolStreamOrder.length > 0;
  const flushQueue = () =>
    void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    payload?.runId,
  );
  const runId = payload?.runId;
  if (runId && host.refreshSessionsAfterChat.has(runId)) {
    host.refreshSessionsAfterChat.delete(runId);
    if (state === "final") {
      void loadSessions(host as unknown as SessionsState, {
        activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
      });
    }
  }
  // Reload history when tools were used so the persisted tool results
  // replace the now-cleared streaming state.
  if (hadToolEvents && state === "final") {
    const chatState = host as unknown as ChatState;
    // Remove the live-appended final message before history merge.
    // handleChatEvent already appended it, but history merge will bring
    // the complete version including tool results. This prevents duplicate
    // render from dual paths (live append + history merge).
    chatState.chatMessages = chatState.chatMessages.filter((msg: unknown) => {
      if (!msg || typeof msg !== "object") return true;
      const m = msg as Record<string, unknown>;
      // Keep all messages except the just-appended final message for this run
      return !(
        m.role === "assistant" &&
        runId &&
        m.runId === runId
      );
    });
    // Clear tool stream BEFORE loading history to prevent duplicate render.
    // If we wait until finally, the first render will show both:
    // 1) chatToolMessages (live stream) + 2) chatMessages (persisted history)
    // Finally block retains resetToolStream as a safety net only.
    resetToolStream(toolHost);
    const completedRunId = runId ?? null;
    void loadChatHistory(chatState, { mode: "merge" }).finally(() => {
      if (completedRunId && host.chatRunId && host.chatRunId !== completedRunId) {
        return;
      }
      // Safety net: re-clear in case any tool events arrived during the
      // history load network round-trip. This should be a no-op under normal
      // conditions since we already cleared above.
      resetToolStream(toolHost);
      flushQueue();
    });
    return true;
  }
  resetToolStream(toolHost);
  flushQueue();
  return false;
}

function handleChatGatewayEvent(host: GatewayHost, payload: ChatEventPayload | undefined) {
  if (payload?.sessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      payload.sessionKey,
    );
  }
  const sideResultHost = host as GatewayHostWithSideResults;
  const isTrackedSideResultTerminalEvent =
    isTerminalChatState(payload?.state) &&
    typeof payload?.runId === "string" &&
    sideResultHost.chatSideResultTerminalRuns?.has(payload.runId) === true;
  if (isTrackedSideResultTerminalEvent && payload?.runId) {
    sideResultHost.chatSideResultTerminalRuns?.delete(payload.runId);
    return;
  }
  const state = handleChatEvent(host as unknown as ChatState, payload);
  const historyReloaded = handleTerminalChatEvent(host, payload, state);
  // Skip redundant loadChatHistory when handleChatEvent already appended the
  // final message to chatMessages (state === "final") and there were no tool
  // events requiring server-persisted replacements (historyReloaded === false).
  //
  // Previously, shouldReloadHistoryForFinalEvent() returned true unconditionally
  // for every final event, causing a redundant network request that cleared
  // chatMessages and reloaded from the server — producing a visible flicker /
  // intermittent content loss.  handleChatEvent already appends the correct
  // message (from payload.message or chatStream), and tool-event reloads are
  // handled by handleTerminalChatEvent.  The isCrossRunFinal path below still
  // covers sub-agent announce cases.
  //
  // Retain loadChatHistory only when the final event has no message payload
  // (edge cases: silent NO_REPLY, or final events without a message body).
  if (state === "final" && !historyReloaded && !payload?.message) {
    if (shouldReloadHistoryForFinalEvent(payload)) {
      void loadChatHistory(host as unknown as ChatState, { mode: "merge" });
    }
  }
  // Cross-run final events (e.g. sub-agent announce) are not live-appended by
  // message in handleChatEvent but return null — no terminal reload is
  // the single source of truth without clearing the active run.
  const isCrossRunFinal =
    payload?.state === "final" &&
    payload?.runId &&
    host.chatRunId &&
    payload.runId !== host.chatRunId;
  if (isCrossRunFinal && !historyReloaded) {
    void loadChatHistory(host as unknown as ChatState, { mode: "merge" });
  }
}

function handleSessionMessageGatewayEvent(
  host: GatewayHost,
  payload: { sessionKey?: string } | undefined,
) {
  const sessionKey = payload?.sessionKey?.trim();
  if (!sessionKey || sessionKey !== host.sessionKey) {
    return;
  }
  void loadChatHistory(host as unknown as ChatState, { mode: "merge" });
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug" || host.tab === "overview") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    handleChatGatewayEvent(host, evt.payload as ChatEventPayload | undefined);
    return;
  }

  if (evt.event === "chat.side_result") {
    const sideResult = parseChatSideResult(evt.payload);
    if (!sideResult || sideResult.sessionKey !== host.sessionKey) {
      return;
    }
    const sideResultHost = host as GatewayHostWithSideResults;
    sideResultHost.chatSideResult = sideResult;
    sideResultHost.chatSideResultTerminalRuns?.add(sideResult.runId);
    return;
  }

  if (evt.event === "session.message") {
    handleSessionMessageGatewayEvent(host, evt.payload as { sessionKey?: string } | undefined);
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "shutdown") {
    const payload = evt.payload as { reason?: unknown; restartExpectedMs?: unknown } | undefined;
    const reason =
      payload && typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "gateway stopping";
    const shutdownMessage =
      typeof payload?.restartExpectedMs === "number"
        ? `Restarting: ${reason}`
        : `Disconnected: ${reason}`;
    (host as GatewayHostWithShutdownMessage).pendingShutdownMessage = shutdownMessage;
    host.lastError = shutdownMessage;
    host.lastErrorCode = null;
    return;
  }

  if (evt.event === "sessions.changed") {
    void loadSessions(host as unknown as SessionsState);
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as DevicesState, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
    return;
  }

  if (evt.event === "plugin.approval.requested") {
    const entry = parsePluginApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "plugin.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
    return;
  }

  if (evt.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
    const payload = evt.payload as GatewayUpdateAvailableEventPayload | undefined;
    host.updateAvailable = payload?.updateAvailable ?? null;
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSummary;
        sessionDefaults?: SessionDefaultsSnapshot;
        updateAvailable?: UpdateAvailable;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
    host.healthResult = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
  host.updateAvailable = snapshot?.updateAvailable ?? null;
}
