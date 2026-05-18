import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { updateCheckpointInterruptState, readCurrentInterruptState, isCandidateExpired, clearBlockedInterruptState } from "../../gateway/session-lifecycle-state.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL, type GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";
import { AGENT_LANE_NESTED } from "../lanes.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

function resolvePositionsConfigPath(workspaceDir?: string): string {
  const explicitWorkspaceDir = workspaceDir?.trim();
  if (explicitWorkspaceDir) {
    return path.join(resolveWorkspaceRoot(explicitWorkspaceDir), ".claw", "positions.json");
  }

  try {
    const cfg = loadConfig() as {
      agents?: { defaults?: { workspace?: string } };
    };
    const configuredWorkspaceDir = cfg.agents?.defaults?.workspace;
    if (configuredWorkspaceDir?.trim()) {
      return path.join(resolveWorkspaceRoot(configuredWorkspaceDir), ".claw", "positions.json");
    }
  } catch {
    // Ignore config fallback failures here. The caller will fail closed with a clearer error.
  }

  throw new Error("无法确定岗位配置文件路径(.claw/positions.json)");
}

async function readPositionDispatchTarget(
  agentId: string,
  workspaceDir?: string,
): Promise<string | null> {
  const positionsConfigPath = resolvePositionsConfigPath(workspaceDir);

  let rawConfig: string;
  try {
    rawConfig = await readFile(positionsConfigPath, "utf8");
  } catch (err) {
    throw new Error(
      `无法读取岗位配置 ${positionsConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsedConfig: {
    positionOverrides?: Record<string, { dispatch_target?: unknown }>;
  };
  try {
    parsedConfig = JSON.parse(rawConfig) as {
      positionOverrides?: Record<string, { dispatch_target?: unknown }>;
    };
  } catch (err) {
    throw new Error(
      `岗位配置文件解析失败 ${positionsConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const dispatchTarget = parsedConfig.positionOverrides?.[agentId]?.dispatch_target;
  if (dispatchTarget == null) {
    return null;
  }
  if (typeof dispatchTarget !== "string") {
    throw new Error(`岗位 ${agentId} 的 dispatch_target 不是字符串`);
  }
  return dispatchTarget.trim();
}

function buildHumanGateCandidatesDir(workspaceDir: string): string {
  return path.join(workspaceDir, "runtime", "human-gate", "candidates");
}

function createConfirmToken(): string {
  return crypto.randomBytes(6).toString("hex");
}

async function writeHumanGatePayload(params: {
  workspaceDir: string;
  candidateId: string;
  createdAt: string;
  expiresAt: string;
  confirmToken: string;
  taskHash: string;
  taskLength: number;
  taskText: string;
  targetSessionKey: string;
  targetAgentId: string;
  sourceSessionKey: string;
}): Promise<string> {
  const candidatesDir = buildHumanGateCandidatesDir(params.workspaceDir);
  await mkdir(candidatesDir, { recursive: true });
  const payloadPath = path.join(candidatesDir, `${params.candidateId}.json`);
  const payload = {
    candidateId: params.candidateId,
    createdAt: params.createdAt,
    expiresAt: params.expiresAt,
    status: "pending",
    confirmToken: params.confirmToken,
    task: {
      hash: params.taskHash,
      length: params.taskLength,
      text: params.taskText,
    },
    target: {
      sessionKey: params.targetSessionKey,
      agentId: params.targetAgentId,
    },
    source: {
      sessionKey: params.sourceSessionKey,
    },
    humanGate: {
      required: true,
      gateStatus: "pending",
    },
    lifecycle: {
      createdAt: params.createdAt,
      approvedAt: null,
      dispatchedAt: null,
      completedAt: null,
    },
  };
  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payloadPath;
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  fallbacks: Type.Optional(Type.Array(Type.String())),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
      default: false,
    }),
  ),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object({
      // Where the spawned agent should look for attachments.
      // Kept as a hint; implementation materializes into the child workspace.
      mountPath: Type.Optional(Type.String()),
    }),
  ),
  dispatchTarget: Type.Optional(Type.String({
    description: 'Explicit dispatch target, e.g. "/main" for direct main session delivery',
  })),

  // P1-02c-2: observe-only dispatch interrupt candidate
  interruptBeforeDispatch: Type.Optional(
    Type.Boolean({
      description:
        "When true, record an observe-only dispatch interrupt candidate before dispatching. Does not block the dispatch.",
      default: false,
    }),
  ),
  autoDispatch: Type.Optional(
    Type.Boolean({
      description:
        "When true, marks the dispatch as originating from an automatic chain. Triggers observe-only interrupt candidate recording.",
      default: false,
    }),
  ),
  requiresHumanGate: Type.Optional(
    Type.Boolean({
      description:
        "When true, marks the task package as requiring human gate approval. Observe-only for now; blocking behavior in future.",
      default: false,
    }),
  ),
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool(),
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const fallbacks = Array.isArray(params.fallbacks)
        ? params.fallbacks
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const dispatchTarget = readStringParam(params, "dispatchTarget");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;

      // P1-02c-2: observe-only dispatch interrupt candidate params
      const interruptBeforeDispatch = params.interruptBeforeDispatch === true;
      const autoDispatch = params.autoDispatch === true;
      const requiresHumanGate = params.requiresHumanGate === true;

      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      // 配置驱动的主会话直投检查（仅当所有条件满足时才重定向）
      const isFromMainSession = opts?.agentSessionKey === "agent:main:main";
      let shouldRedirectToMainSession = false;
      let targetSessionKey = "";

      if (
        isFromMainSession &&
        runtime === "subagent" &&
        requestedAgentId &&
        requestedAgentId !== "main"
      ) {
        try {
          const dispatchTargetRaw = await readPositionDispatchTarget(requestedAgentId, opts?.workspaceDir);

          if (dispatchTargetRaw) {
            const expectedPattern = `${requestedAgentId} / main`;
            const normalizedExpected = expectedPattern.replace(/\s+/g, " ");
            const normalizedActual = dispatchTargetRaw.replace(/\s+/g, " ");

            if (normalizedActual === normalizedExpected) {
              shouldRedirectToMainSession = true;
              targetSessionKey = `agent:${requestedAgentId}:main`;
            }
          }
          // 岗位存在但 dispatch_target 不匹配，或没有 dispatch_target - 保持原 sessions_spawn
        } catch (err) {
          // 岗位配置读取或结构解析失败 - fail closed
          return jsonResult({
            status: "error",
            error: `无法从 .claw/positions.json 检查岗位 ${requestedAgentId} 的 dispatch_target: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // 检查 dispatchTarget="/main" 但缺少 agentId 的情况（fail closed）
      if (dispatchTarget === "/main" && !requestedAgentId) {
        return jsonResult({
          status: "error",
          error: "dispatchTarget='/main' requires explicit agentId to determine target role",
        });
      }

      // 显式 dispatchTarget="/main" 参数覆盖配置检查
      if (dispatchTarget === "/main" && requestedAgentId) {
        shouldRedirectToMainSession = true;
        targetSessionKey = `agent:${requestedAgentId}:main`;
      }

      if (shouldRedirectToMainSession) {
        // 重定向到 sessions_send 到 agent:<role>:main
        // 构建 sessions_send 参数
        const sessionKey = targetSessionKey;

        // === P1-03c: blocking gate for requiresHumanGate ===
        // Check conditions for soft-block: main → engineering-executive, requiresHumanGate=true, autoDispatch=true
        const workspaceDir = opts?.workspaceDir;
        let shouldBlock = false;
        if (
          workspaceDir &&
          isFromMainSession &&
          requestedAgentId === "engineering-executive" &&
          requiresHumanGate === true &&
          autoDispatch === true
        ) {
          // Control UI manual dispatch is explicitly bypassed
          const isControlUI = label === "openclaw-control-ui" || label.includes("control-ui");
          if (!isControlUI) {
            shouldBlock = true;
          }
        }

        // Check existing blocked candidate (reject-second policy)
        if (shouldBlock && workspaceDir) {
          const current = await readCurrentInterruptState(workspaceDir);
          if (current?.interruptState?.status === "blocked" && !isCandidateExpired(current.interruptState)) {
            // Reject second candidate - do not overwrite existing blocked candidate
            return jsonResult({
              status: "error",
              error: "Rejected: already has an active blocked dispatch candidate waiting for human approval. Try again after approval/rejection.",
              existingCandidateId: current.interruptState?.candidateId,
              existingExpiresAt: current.interruptState?.expiresAt,
            });
          }
          // Clear expired candidate before proceeding
          if (current?.interruptState?.status === "blocked" && isCandidateExpired(current.interruptState)) {
            await clearBlockedInterruptState(workspaceDir);
            console.log("[continuity:blocking-gate] cleared expired blocked candidate");
          }
        }

        // === Write payload store and checkpoint before blocking ===
        let checkpointWriteOk = false;
        if (shouldBlock && workspaceDir) {
          const taskStr = String(task);
          const now = new Date();
          const createdAt = now.toISOString();
          const candidateId = `cand_${createdAt.replace(/[-:.]/g, "").replace(/\.[0-9]+Z$/, "Z")}_${crypto.randomBytes(2).toString("hex")}`;
          const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString(); // +30min
          const taskHash = crypto.createHash("sha256").update(taskStr).digest("hex").slice(0, 16);
          const confirmToken = createConfirmToken();
          const confirmTokenHash = crypto.createHash("sha256").update(confirmToken).digest("hex");
          const confirmTokenHint = confirmToken.slice(-4);

          const dispatchAction = {
            kind: "dispatch_task" as const,
            observeOnly: false,
            targetSessionKey: sessionKey,
            requestedAgentId: requestedAgentId ?? "",
            taskHash,
            taskLength: taskStr.length,
            createdAt,
            sourceSessionKey: opts?.agentSessionKey ?? "",
            candidateId,
            expiresAt,
            blockedBy: "human-gate",
          };

          try {
            await writeHumanGatePayload({
              workspaceDir,
              candidateId,
              createdAt,
              expiresAt,
              confirmToken,
              taskHash,
              taskLength: taskStr.length,
              taskText: taskStr,
              targetSessionKey: sessionKey,
              targetAgentId: requestedAgentId ?? "",
              sourceSessionKey: opts?.agentSessionKey ?? "",
            });
          } catch (err) {
            return jsonResult({
              status: "error",
              error: `Failed to write human gate payload store; dispatch was not blocked or sent: ${err instanceof Error ? err.message : String(err)}`,
              candidateId,
            });
          }

          try {
            await updateCheckpointInterruptState({
              workspaceDir,
              interruptState: {
                status: "blocked",
                interruptReason: "dispatch_task_candidate",
                dispatchAction,
                candidateId,
                expiresAt,
                blockedAt: createdAt,
              },
              humanGate: {
                required: true,
                gateType: "automatic-dispatch-candidate",
                gateStatus: "pending",
                gateCreatedAt: createdAt,
                candidateId,
                gateExpiresAt: expiresAt,
                confirmTokenHash,
                confirmTokenHint,
              },
            });
            // Re-read to verify
            const verified = await readCurrentInterruptState(workspaceDir);
            if (
              verified?.interruptState?.status === "blocked" &&
              verified.interruptState?.candidateId === candidateId &&
              verified.humanGate?.confirmTokenHash === confirmTokenHash
            ) {
              checkpointWriteOk = true;
              console.log(`[continuity:blocking-gate] candidate ${candidateId} written to checkpoint, blocking dispatch`);
            } else {
              console.warn("[continuity:blocking-gate] checkpoint verification failed, fallback to observe-only");
              checkpointWriteOk = false;
            }
          } catch (err) {
            console.warn(
              "[continuity:blocking-gate] checkpoint write failed, fallback to observe-only:",
              err instanceof Error ? err.message : String(err),
            );
            checkpointWriteOk = false;
          }

          if (checkpointWriteOk) {
            // Checkpoint written successfully - block dispatch and return
            return jsonResult({
              status: "blocked",
              candidateId,
              expiresAt,
              targetSessionKey: sessionKey,
              requestedAgentId,
              taskHash: dispatchAction.taskHash,
              confirmTokenHint,
              message: "Dispatch blocked by human gate: requires explicit human approval before execution.",
            });
          }
        }

        // === P1-02c-2: observe-only dispatch interrupt candidate (fallback) ===
        // If blocking failed verification or conditions not met, fall back to observe-only
        if (workspaceDir && (interruptBeforeDispatch || autoDispatch || requiresHumanGate)) {
          const taskStr = String(task);
          const dispatchAction = {
            kind: "dispatch_task" as const,
            observeOnly: true,
            targetSessionKey: sessionKey,
            requestedAgentId: requestedAgentId ?? "",
            taskHash: crypto.createHash("sha256").update(taskStr).digest("hex").slice(0, 16),
            taskLength: taskStr.length,
            createdAt: new Date().toISOString(),
            sourceSessionKey: opts?.agentSessionKey ?? "",
          };

          try {
            await updateCheckpointInterruptState({
              workspaceDir,
              interruptState: {
                status: "not-interrupted",
                interruptReason: "dispatch_task_candidate",
                dispatchAction,
                observedAt: new Date().toISOString(),
              },
              humanGate: {
                required: requiresHumanGate,
                gateType: "dispatch-task-candidate",
                gateStatus: "pending",
                gateCreatedAt: new Date().toISOString(),
              },
            });
          } catch (err) {
            console.warn(
              "[continuity:interrupt-candidate] checkpoint write failed, dispatch continues:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        // 调用 gateway 的 agent 方法，模拟 sessions_send 的核心逻辑
        try {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message: task,
              sessionKey,
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_NESTED,
              extraSystemPrompt: `[主会话直投] 这是来自 ${opts?.agentSessionKey || "unknown"} 的岗位任务派发。`,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: opts?.agentSessionKey,
                sourceChannel: opts?.agentChannel,
                sourceTool: "sessions_spawn_redirected",
              },
              idempotencyKey: crypto.randomUUID(),
            },
            timeoutMs: 10_000,
          });

          const runId = response?.runId || crypto.randomUUID();

          return jsonResult({
            status: "accepted",
            sessionKey,
            runId,
            note: `任务已直投到主会话 ${sessionKey}，使用 sessions_send 语义。`,
          });
        } catch (err) {
          // /main 无法解析时 fail closed
          const errorMessage = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            error: `无法解析主会话 ${sessionKey}: ${errorMessage}`,
            sessionKey,
          });
        }
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = loadConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey: childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin: requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
            });
          }
        }
        return jsonResult(result);
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          fallbacks,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );

      return jsonResult(result);
    },
  };
}
