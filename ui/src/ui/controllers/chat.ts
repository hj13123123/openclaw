import { resetToolStream } from "../app-tool-stream.ts";
import { extractRawText, extractText } from "../chat/message-extract.ts";
import { formatConnectError } from "../connect-error.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 10_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 2_000;
const chatHistoryRequestVersions = new WeakMap<object, number>();

function beginChatHistoryRequest(state: ChatState): number {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function isLatestChatHistoryRequest(state: ChatState, version: number): boolean {
  return chatHistoryRequestVersions.get(state as object) === version;
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  version: number,
  sessionKey: string,
): boolean {
  return isLatestChatHistoryRequest(state, version) && state.sessionKey === sessionKey;
}

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}
/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isSyntheticTranscriptRepairToolResult(message);
}

function isRetryableStartupUnavailable(err: unknown, method: string): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

function getMessageIdentity(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const m = message as Record<string, unknown>;
  // Prefer stable server-side identifiers
  for (const key of ["id", "messageId", "toolCallId", "toolResultId", "runId"]) {
    const value = m[key];
    if (typeof value === "string" && value) {
      return `${key}:${value}`;
    }
  }
  const role = String(m.role ?? "");
  // Use raw text (ignoring phase-aware extraction differences) for content hash.
  // extractText uses phase-aware extraction that diverges between live messages
  // (no textSignature) and history messages (with textSignature), causing the
  // same underlying text to produce different hashes.
  const text = extractRawText(message) ?? "";
  return `${role}:${text.slice(0, 400)}`;
}

export function areMessagesDuplicate(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const ma = a as Record<string, unknown>;
  const mb = b as Record<string, unknown>;
  if (String(ma.role ?? "") !== String(mb.role ?? "")) {
    return false;
  }
  // Cross-match stable identifiers: if any id field value appears in both
  // messages (across different key names), they are duplicates. Handles cases
  // where live message has runId but history message has id/messageId.
  const idKeys = ["id", "messageId", "toolCallId", "toolResultId", "runId"];
  const aIds = idKeys
    .map((key) => ma[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const bIds = idKeys
    .map((key) => mb[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (aIds.some((id) => bIds.includes(id))) {
    return true;
  }
  // Normalize whitespace: collapse consecutive whitespace to single space,
  // trim leading/trailing. Handles differences between live messages (string
  // content) and history messages (array content with split text blocks),
  // as well as newline/space variations from different rendering paths.
  const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

  // Normalize content text regardless of shape: string, text block array, or text field.
  const getNormalizedContentText = (msg: Record<string, unknown>): string => {
    const content = msg.content;
    // Handle string content directly
    if (typeof content === "string") {
      return normalizeWhitespace(content);
    }
    // Handle array content
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type?: string; text?: string } =>
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string",
        )
        .map((block) => normalizeWhitespace(block.text ?? ""))
        .join("");
    }
    // Handle text field (fallback)
    if (typeof msg.text === "string") {
      return normalizeWhitespace(msg.text);
    }
    return "";
  };

  // Fallback 1: compare normalized text content (ignoring timestamp differences)
  const ta = normalizeWhitespace(extractText(a) ?? "");
  const tb = normalizeWhitespace(extractText(b) ?? "");
  if (ta === tb && ta.length > 0) {
    return true;
  }
  // Fallback 2: compare raw text (ignoring phase-aware extraction differences).
  // Live messages lack textSignature while history messages include it,
  // causing extractText to diverge for the same underlying text.
  const rawA = normalizeWhitespace(extractRawText(a) ?? "");
  const rawB = normalizeWhitespace(extractRawText(b) ?? "");
  if (rawA === rawB && rawA.length > 0) {
    return true;
  }
  // Fallback 3: compare normalized content text regardless of content shape.
  // Handles cases where content array shape differs (e.g. live string content
  // vs history array content, or blocks in different order with same combined text).
  const normA = getNormalizedContentText(ma);
  const normB = getNormalizedContentText(mb);
  if (normA.length > 0 && normA === normB) {
    return true;
  }
  return false;
}

function dedupeMergedMessages(merged: unknown[]): unknown[] {
  if (merged.length < 2) {
    return merged;
  }
  const result: unknown[] = [];
  for (const item of merged) {
    const isDup = result.some((prev) => areMessagesDuplicate(prev, item));
    if (!isDup) {
      result.push(item);
    }
  }
  return result;
}

function mergeChatMessages(existing: unknown[], incoming: unknown[]): unknown[] {
  if (existing.length === 0) {
    return incoming;
  }
  const seen = new Set(existing.map(getMessageIdentity));
  const additions = incoming.filter((m) => !seen.has(getMessageIdentity(m)));
  if (additions.length === 0) {
    return existing;
  }
  const merged = [...existing, ...additions];
  const deduped = dedupeMergedMessages(merged);
  if (deduped.length > 500) {
    return deduped.slice(deduped.length - 500);
  }
  return deduped;
}

export async function loadChatHistory(
  state: ChatState,
  opts?: { mode?: "replace" | "merge" },
) {
  const mode = opts?.mode ?? "replace";
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  const requestVersion = beginChatHistoryRequest(state);
  const startedAt = Date.now();
  state.chatLoading = true;
  state.lastError = null;
  try {
    let res: { messages?: Array<unknown>; thinkingLevel?: string };
    for (;;) {
      try {
        res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
          "chat.history",
          {
            sessionKey,
            limit: 500,
          },
        );
        break;
      } catch (err) {
        if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
          return;
        }
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, "chat.history")) {
          await sleep(resolveStartupRetryDelayMs(err));
          if (!state.client || !state.connected) {
            return;
          }
          continue;
        }
        throw err;
      }
    }
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const filteredMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    if (mode === "merge") {
      state.chatMessages = mergeChatMessages(state.chatMessages, filteredMessages);
    } else {
      state.chatMessages = filteredMessages;
    }
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
    } else {
      state.lastError = String(err);
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

function buildApiAttachments(attachments?: ChatAttachment[]) {
  const hasAttachments = attachments && attachments.length > 0;
  return hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;
}

async function requestChatSend(
  state: ChatState,
  params: { message: string; attachments?: ChatAttachment[]; runId: string },
) {
  await state.client!.request("chat.send", {
    sessionKey: state.sessionKey,
    message: params.message,
    deliver: false,
    idempotencyKey: params.runId,
    attachments: buildApiAttachments(params.attachments),
  });
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : normalizeLowercaseStringOrEmpty(roleValue);
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  try {
    await requestChatSend(state, { message: msg, attachments, runId });
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function sendDetachedChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  state.lastError = null;
  const runId = generateUUID();
  try {
    await requestChatSend(state, { message: msg, attachments, runId });
    return runId;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return null;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): DO NOT live append.
  // This will always trigger a subsequent history merge in app-gateway,
  // which becomes the single source of truth for the complete message (including
  // tool results, attachments, etc.). Prevents duplicate render from dual paths.
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      state.chatStream = next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      // Attach runId from payload to the appended message for dedup matching.
      // Live messages from payload.message may not have runId in the message
      // object itself, but chat.history messages may have runId or matching
      // identifiers. This ensures dedup can match live vs history versions.
      const messageWithRunId = payload.runId
        ? { ...finalMessage, runId: payload.runId }
        : finalMessage;
      // Dedupe before append: session.message event may have already merged
      // the persisted version of this message before chat.final event arrives.
      const isDuplicate = state.chatMessages.some((m: unknown) =>
        areMessagesDuplicate(m, messageWithRunId),
      );
      if (!isDuplicate) {
        state.chatMessages = [...state.chatMessages, messageWithRunId];
      }
    } else if (state.chatStream?.trim() && !isSilentReplyStream(state.chatStream)) {
      const streamMessage = {
        role: "assistant",
        content: [{ type: "text", text: state.chatStream }],
        timestamp: Date.now(),
        ...(payload.runId ? { runId: payload.runId } : {}),
      };
      // Dedupe before append: session.message event may have already merged
      // the persisted version of this message before chat.final event arrives.
      const isDuplicate = state.chatMessages.some((m: unknown) =>
        areMessagesDuplicate(m, streamMessage),
      );
      if (!isDuplicate) {
        state.chatMessages = [...state.chatMessages, streamMessage];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      // Attach runId for dedup matching with history merge.
      const messageWithRunId = payload.runId
        ? { ...normalizedMessage, runId: payload.runId }
        : normalizedMessage;
      // Dedupe before append: session.message event may have already merged
      // the persisted version of this message before chat.aborted event arrives.
      const isDuplicate = state.chatMessages.some((m: unknown) =>
        areMessagesDuplicate(m, messageWithRunId),
      );
      if (!isDuplicate) {
        state.chatMessages = [...state.chatMessages, messageWithRunId];
      }
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
        const streamMessage = {
          role: "assistant",
          content: [{ type: "text", text: streamedText }],
          timestamp: Date.now(),
          ...(payload.runId ? { runId: payload.runId } : {}),
        };
        // Dedupe before append: session.message event may have already merged
        // the persisted version of this message before chat.aborted event arrives.
        const isDuplicate = state.chatMessages.some((m: unknown) =>
          areMessagesDuplicate(m, streamMessage),
        );
        if (!isDuplicate) {
          state.chatMessages = [...state.chatMessages, streamMessage];
        }
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
