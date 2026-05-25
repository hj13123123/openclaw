import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureReturnConsumerDirs,
  processReturnInbox,
  type ReturnConsumerLog,
  writeReturnConsumerErrorReport,
} from "../runtime/returns/return-consumer.js";

export { processReturnInbox };
export type { ReturnConsumerLog };

export type ReturnConsumerServiceHandle = { stop: () => void };

const DEFAULT_POLL_INTERVAL_MS = 120_000;

export function startReturnConsumerService(params: {
  workspaceRoot: string;
  cfg: OpenClawConfig;
  log: ReturnConsumerLog;
  pollIntervalMs?: number;
  enabled?: boolean;
}): ReturnConsumerServiceHandle {
  const enabled = params.enabled !== false;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (!enabled) {
    params.log.info("[return-consumer] disabled");
    return { stop: () => {} };
  }

  ensureReturnConsumerDirs(params.workspaceRoot);

  const tick = () => {
    if (stopped || running) return;
    running = true;
    try {
      processReturnInbox(params.workspaceRoot, params.log);
    } catch (err) {
      writeReturnConsumerErrorReport(params.workspaceRoot, err);
      params.log.warn(`[return-consumer] tick failed: ${errorMessage(err)}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();
  setTimeout(tick, 1).unref?.();
  params.log.info(
    `[return-consumer] started interval=${pollIntervalMs}ms workspace=${params.workspaceRoot}`,
  );

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function resolveReturnConsumerWorkspaceRoot(cfg: OpenClawConfig): string {
  return (
    cfg.agents?.list?.find((agent) => agent.id === "main")?.workspace ??
    cfg.agents?.list?.find((agent) => agent.id === "patrol")?.workspace ??
    path.join(os.homedir(), ".openclaw", "workspace-main")
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
