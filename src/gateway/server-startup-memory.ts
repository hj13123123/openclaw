import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";

function isMemorySearchEnabled(cfg: OpenClawConfig, agentId: string): boolean {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  return overrides?.enabled ?? defaults?.enabled ?? true;
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  if (params.cfg.memory?.backend !== "qmd") {
    return;
  }
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    if (!isMemorySearchEnabled(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveActiveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    params.log.info?.(`qmd memory startup status available for agent "${agentId}"`);
  }
}
