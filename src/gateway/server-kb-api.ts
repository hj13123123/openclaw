import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig, type OpenClawConfig, type MemorySearchConfig } from "../config/config.js";
import {
  buildKnowledgeIndexFromWorkspace,
  KB_INDEX_FILE_RELATIVE_PATH,
  writeKnowledgeIndexSnapshot,
} from "../runtime/kb-index-refresh.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const KB_STATE_ROUTE = "/api/kb/state";
const KB_REFRESH_ROUTE = "/api/kb/refresh";
const KB_SEMANTIC_REBUILD_PLAN_ROUTE = "/api/kb/semantic-rebuild-plan";

type KnowledgeIndexSummary = {
  generatedAt: string | null;
  totalItems: number;
  sourceCaseCount: number;
  sourceSkillCount: number;
  keywordCount: number;
};

type KnowledgeSemanticState = {
  status: "default" | "configured" | "disabled" | "config_error";
  mode: "observe-only";
  source: "agents.memorySearch";
  rebuild: "disabled";
  reason: "semantic_vector_refresh_deferred";
  provider: string | null;
  model: string | null;
  vectorEnabled: boolean | null;
  hybridEnabled: boolean | null;
  configuredScopes: string[];
  error?: string;
};

type KbHttpOptions = {
  config?: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
};

type KnowledgeSemanticRebuildPlan = {
  status: "ready" | "blocked";
  mode: "dry-run";
  dryRun: true;
  action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE";
  generatedAt: string;
  semantic: KnowledgeSemanticState;
  source: {
    totalItems: number;
    sourceCaseCount: number;
    sourceSkillCount: number;
    keywordCount: number;
    warnings: string[];
  };
  plannedBatches: number;
  plannedOutputs: string[];
  plannedSteps: string[];
  blockedReasons: string[];
  constraintsVerified: {
    embeddingCalls: "no";
    fileWrites: "no";
    keywordIndexWritten: "no";
    vectorIndexWritten: "no";
    applied: "no";
  };
};

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function summarizeIndex(value: unknown): KnowledgeIndexSummary {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const keywords = record.keywords && typeof record.keywords === "object" && !Array.isArray(record.keywords)
    ? record.keywords as Record<string, unknown>
    : {};
  return {
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : null,
    totalItems: typeof record.totalItems === "number" ? record.totalItems : 0,
    sourceCaseCount: typeof record.sourceCaseCount === "number" ? record.sourceCaseCount : 0,
    sourceSkillCount: typeof record.sourceSkillCount === "number" ? record.sourceSkillCount : 0,
    keywordCount: Object.keys(keywords).length,
  };
}

function hasMemorySearchConfig(value: MemorySearchConfig | undefined): value is MemorySearchConfig {
  return Boolean(value);
}

function firstString(values: Array<string | undefined>): string | null {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function firstBoolean(values: Array<boolean | undefined>, fallback: boolean | null): boolean | null {
  return values.find((value) => typeof value === "boolean") ?? fallback;
}

export function summarizeSemanticBoundary(config: OpenClawConfig): KnowledgeSemanticState {
  const defaults = config.agents?.defaults?.memorySearch;
  const scoped = [
    ...(hasMemorySearchConfig(defaults)
      ? [{
          scope: "agents.defaults",
          config: defaults,
          effectiveEnabled: defaults.enabled ?? true,
          provider: defaults.provider,
          model: defaults.model,
          vectorEnabled: defaults.store?.vector?.enabled,
          hybridEnabled: defaults.query?.hybrid?.enabled,
        }]
      : []),
    ...(config.agents?.list ?? [])
      .filter((agent) => hasMemorySearchConfig(agent.memorySearch))
      .map((agent) => ({
        scope: `agents.list.${agent.id}`,
        config: agent.memorySearch as MemorySearchConfig,
        effectiveEnabled: agent.memorySearch?.enabled ?? defaults?.enabled ?? true,
        provider: agent.memorySearch?.provider ?? defaults?.provider,
        model: agent.memorySearch?.model ?? defaults?.model,
        vectorEnabled: agent.memorySearch?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled,
        hybridEnabled: agent.memorySearch?.query?.hybrid?.enabled ?? defaults?.query?.hybrid?.enabled,
      })),
  ];
  const hasConfiguredScope = scoped.length > 0;
  const hasEnabledScope = !hasConfiguredScope || scoped.some((entry) => entry.effectiveEnabled);
  const status = hasConfiguredScope ? (hasEnabledScope ? "configured" : "disabled") : "default";
  return {
    status,
    mode: "observe-only",
    source: "agents.memorySearch",
    rebuild: "disabled",
    reason: "semantic_vector_refresh_deferred",
    provider: status === "disabled" ? null : firstString(scoped.map((entry) => entry.provider)) ?? "auto",
    model: status === "disabled" ? null : firstString(scoped.map((entry) => entry.model)),
    vectorEnabled: status === "disabled"
      ? false
      : firstBoolean(scoped.map((entry) => entry.vectorEnabled), true),
    hybridEnabled: status === "disabled"
      ? false
      : firstBoolean(scoped.map((entry) => entry.hybridEnabled), true),
    configuredScopes: scoped.map((entry) => entry.scope),
  };
}

function resolveSemanticBoundary(options?: KbHttpOptions): KnowledgeSemanticState {
  try {
    return summarizeSemanticBoundary(options?.config ?? (options?.loadConfig ?? loadConfig)());
  } catch (error) {
    return {
      status: "config_error",
      mode: "observe-only",
      source: "agents.memorySearch",
      rebuild: "disabled",
      reason: "semantic_vector_refresh_deferred",
      provider: null,
      model: null,
      vectorEnabled: null,
      hybridEnabled: null,
      configuredScopes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildSemanticRebuildPlan(
  workspaceRoot: string,
  semantic: KnowledgeSemanticState,
  generatedAt = new Date().toISOString(),
): KnowledgeSemanticRebuildPlan {
  const { index, sources } = buildKnowledgeIndexFromWorkspace(workspaceRoot, generatedAt);
  const blockedReasons = [
    ...(semantic.status === "disabled" ? ["semantic memorySearch is disabled"] : []),
    ...(semantic.status === "config_error" ? ["semantic memorySearch config could not be resolved"] : []),
    ...(semantic.vectorEnabled === false ? ["vector store is disabled"] : []),
    ...(index.totalItems === 0 ? ["no KB items available for semantic rebuild"] : []),
  ];
  return {
    status: blockedReasons.length > 0 ? "blocked" : "ready",
    mode: "dry-run",
    dryRun: true,
    action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE",
    generatedAt,
    semantic,
    source: {
      totalItems: index.totalItems,
      sourceCaseCount: index.sourceCaseCount,
      sourceSkillCount: index.sourceSkillCount,
      keywordCount: Object.keys(index.keywords).length,
      warnings: sources.warnings,
    },
    plannedBatches: index.totalItems === 0 ? 0 : Math.ceil(index.totalItems / 100),
    plannedOutputs: [
      "system/kb-index/semantic-index.json",
      "system/kb-index/vector-index.sqlite",
      "system/kb-index/semantic-rebuild-report.json",
    ],
    plannedSteps: [
      "read case-library and skill-library sources",
      "normalize KB items using keyword index schema",
      "plan embedding batches",
      "plan semantic index and vector index output paths",
      "stop before embedding calls or file writes",
    ],
    blockedReasons,
    constraintsVerified: {
      embeddingCalls: "no",
      fileWrites: "no",
      keywordIndexWritten: "no",
      vectorIndexWritten: "no",
      applied: "no",
    },
  };
}

export function isKbApiPath(pathname: string): boolean {
  return pathname === KB_STATE_ROUTE
    || pathname === KB_REFRESH_ROUTE
    || pathname === KB_SEMANTIC_REBUILD_PLAN_ROUTE;
}

export async function handleKbHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options?: KbHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isKbApiPath(requestPath)) {
    return false;
  }

  if (requestPath === KB_STATE_ROUTE) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    try {
      const index = JSON.parse(await readFile(path.join(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH), "utf8")) as unknown;
      sendJson(res, 200, {
        available: true,
        indexPath: KB_INDEX_FILE_RELATIVE_PATH,
        semantic: resolveSemanticBoundary(options),
        ...summarizeIndex(index),
      });
    } catch {
      sendJson(res, 200, {
        available: false,
        indexPath: KB_INDEX_FILE_RELATIVE_PATH,
        semantic: resolveSemanticBoundary(options),
      });
    }
    return true;
  }

  if (requestPath === KB_SEMANTIC_REBUILD_PLAN_ROUTE) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }

    try {
      const semantic = resolveSemanticBoundary(options);
      sendJson(res, 200, buildSemanticRebuildPlan(workspaceRoot, semantic));
    } catch (error) {
      sendJson(res, 500, {
        status: "blocked",
        mode: "dry-run",
        dryRun: true,
        action: "PLAN_ONLY_NO_EMBEDDING_NO_WRITE",
        error: `知识库语义重建计划生成失败：${error instanceof Error ? error.message : String(error)}`,
        constraintsVerified: {
          embeddingCalls: "no",
          fileWrites: "no",
          keywordIndexWritten: "no",
          vectorIndexWritten: "no",
          applied: "no",
        },
      });
    }
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    const result = writeKnowledgeIndexSnapshot(workspaceRoot);
    sendJson(res, 200, {
      ...result,
      refreshMode: "runtime",
    });
  } catch (error) {
    sendJson(res, 500, {
      refreshed: false,
      error: `知识库索引刷新失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}
