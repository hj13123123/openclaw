import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  extractReturnPackageIdentity,
  planReturnConsumption,
  type RoleReturnPackageV1,
} from "../runtime/returns/return-consumer-plan.js";

export type ReturnConsumerServiceHandle = { stop: () => void };

type ReturnConsumerLog = { info: (msg: string) => void; warn: (msg: string) => void };

type ProcessResult = {
  status: "processed" | "skipped";
  reason?: string;
  returnId?: string;
  taskId?: string;
  sourceFile: string;
  actionRequired?: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 120_000;
const LOCK_MAX_AGE_MS = 5 * 60_000;

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

  fs.mkdirSync(path.join(params.workspaceRoot, "system", "returns", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(params.workspaceRoot, "system", "returns", "processed"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(params.workspaceRoot, "runtime", "main", "tmp"), { recursive: true });
  fs.mkdirSync(path.join(params.workspaceRoot, "runtime", "notifications", "inbox"), {
    recursive: true,
  });

  const tick = () => {
    if (stopped || running) return;
    running = true;
    try {
      processReturnInbox(params.workspaceRoot, params.log);
    } catch (err) {
      writeErrorReport(params.workspaceRoot, err);
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
    cfg.agents?.list?.find((agent) => agent.id === "evolution-curator")?.workspace ??
    path.join(os.homedir(), ".openclaw", "workspace-main")
  );
}

export function processReturnInbox(workspaceRoot: string, log: ReturnConsumerLog): ProcessResult[] {
  ensureReturnConsumerDirs(workspaceRoot);
  const lock = tryAcquireLock(workspaceRoot);
  if (!lock.acquired) {
    writeWarning(workspaceRoot, {
      timestamp: new Date().toISOString(),
      source: "gateway-return-consumer-v1",
      reason: "lock-held",
      lockPath: lock.lockPath,
    });
    return [];
  }

  const results: ProcessResult[] = [];
  try {
    const inboxDir = path.join(workspaceRoot, "system", "returns", "inbox");
    const files = fs
      .readdirSync(inboxDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^return-.*\.json$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      try {
        results.push(processReturnFile(workspaceRoot, fileName));
      } catch (err) {
        writeErrorReport(workspaceRoot, err, fileName);
        results.push({
          status: "skipped",
          sourceFile: fileName,
          reason: `exception:${errorMessage(err)}`,
        });
      }
    }

    if (results.length > 0) {
      writeBatchNotice(workspaceRoot, results);
      const processed = results.filter((result) => result.status === "processed").length;
      const skipped = results.length - processed;
      log.info(`[return-consumer] processed=${processed} skipped=${skipped}`);
    }
    return results;
  } finally {
    releaseLock(lock.lockPath);
  }
}

function ensureReturnConsumerDirs(workspaceRoot: string): void {
  fs.mkdirSync(path.join(workspaceRoot, "system", "returns", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "system", "returns", "processed"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "runtime", "main", "tmp"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "runtime", "notifications", "inbox"), { recursive: true });
}

function processReturnFile(workspaceRoot: string, fileName: string): ProcessResult {
  const inboxPath = path.join(workspaceRoot, "system", "returns", "inbox", fileName);
  const processedDir = path.join(workspaceRoot, "system", "returns", "processed");
  const processedPath = path.join(processedDir, fileName);
  const sourceFile = fileName;

  let parsed: RoleReturnPackageV1;
  try {
    parsed = JSON.parse(readUtf8JsonText(inboxPath)) as RoleReturnPackageV1;
  } catch (err) {
    writeWarning(workspaceRoot, {
      sourceFile,
      reason: "json-parse-failed",
      error: errorMessage(err),
    });
    return { status: "skipped", sourceFile, reason: "json-parse-failed" };
  }

  const identity = extractReturnPackageIdentity(parsed);
  const plan = planReturnConsumption({
    sourceFile,
    pkg: parsed,
    receiptExists: hasExistingReceipt(processedDir, identity.returnId, identity.taskId, sourceFile),
    processedFileExists: fs.existsSync(processedPath),
  });
  if (plan.status === "skip") {
    writeWarning(workspaceRoot, {
      sourceFile,
      returnId: plan.returnId,
      taskId: plan.taskId,
      reason: plan.reason,
      ...(plan.validationErrors ? { errors: plan.validationErrors } : {}),
    });
    return {
      status: "skipped",
      sourceFile,
      returnId: plan.returnId,
      taskId: plan.taskId,
      reason: plan.reason,
    };
  }

  fs.renameSync(inboxPath, processedPath);
  const stamp = compactStamp();
  const receiptId = `receipt-rrpkg-${safeFilePart(plan.taskId || "unknown-task")}-${stamp}`;
  const receiptPath = path.join(processedDir, `${receiptId}.json`);
  writeJson(receiptPath, {
    receiptId,
    consumedAt: new Date().toISOString(),
    sourcePackage: sourceFile,
    sourceReturnId: plan.returnId,
    taskId: plan.taskId,
    consumer: "gateway-return-consumer-v1",
    status: "consumed",
    verificationChecklist: parsed.verificationChecklist,
    processedBy: "system",
  });

  // P0-4.5b: Write bridge queue marker (non-blocking, fire-and-forget)
  writeBridgeQueueMarker(workspaceRoot, plan.returnId, plan.taskId, sourceFile, receiptId);

  return {
    status: "processed",
    sourceFile,
    returnId: plan.returnId,
    taskId: plan.taskId,
    actionRequired: plan.actionRequired,
  };
}

function hasExistingReceipt(
  processedDir: string,
  returnId: string | undefined,
  taskId: string | undefined,
  sourceFile: string,
): boolean {
  if (!fs.existsSync(processedDir)) return false;
  for (const entry of fs.readdirSync(processedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^receipt-rrpkg-.*\.json$/u.test(entry.name)) continue;
    try {
      const receipt = JSON.parse(readUtf8JsonText(path.join(processedDir, entry.name))) as Record<
        string,
        unknown
      >;
      if (receipt.sourcePackage === sourceFile) return true;
      if (
        returnId &&
        (receipt.sourceReturnId === returnId || receipt.roleReturnPackageId === returnId)
      )
        return true;
      if (taskId && receipt.taskId === taskId && receipt.status === "consumed") return true;
    } catch {
      // Ignore unreadable legacy receipts; they should not block valid new returns.
    }
  }
  return false;
}

function tryAcquireLock(workspaceRoot: string): { acquired: boolean; lockPath: string } {
  const lockPath = path.join(workspaceRoot, "system", "returns", "return-consumer.lock");
  try {
    if (fs.existsSync(lockPath)) {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs > LOCK_MAX_AGE_MS) {
        fs.rmSync(lockPath, { force: true });
      }
    }
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2),
    );
    fs.closeSync(fd);
    return { acquired: true, lockPath };
  } catch {
    return { acquired: false, lockPath };
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // fail-soft: stale lock cleanup is handled on next tick by max age.
  }
}

function writeBridgeQueueMarker(
  workspaceRoot: string,
  packageId: string | undefined,
  taskId: string | undefined,
  returnFile: string,
  receiptId: string,
): void {
  if (!packageId || !taskId) return; // fail-closed: incomplete marker
  try {
    const queueDir = path.join(workspaceRoot, "runtime", "main", "tmp", "bridge-queue");
    fs.mkdirSync(queueDir, { recursive: true });
    const marker = {
      packageId,
      taskId,
      returnFile,
      receiptFile: `${receiptId}.json`,
      writtenAt: new Date().toISOString(),
    };
    writeJson(path.join(queueDir, `${safeFilePart(packageId)}.json`), marker);
  } catch {
    // fail-soft: queue marker failure must not block consumer
  }
}

function writeBatchNotice(workspaceRoot: string, results: ProcessResult[]): void {
  const processed = results.filter((result) => result.status === "processed");
  const skipped = results.filter((result) => result.status === "skipped");
  const actionRequired = processed.some((result) => result.actionRequired === true);
  const stamp = compactStamp();
  writeJson(
    path.join(
      workspaceRoot,
      "runtime",
      "notifications",
      "inbox",
      `notice-return-consumer-${stamp}.json`,
    ),
    {
      noticeId: `notice-return-consumer-${stamp}`,
      type: "return_consumed",
      severity: processed.length > 0 ? "warn" : "silent",
      source: "return-consumer",
      summary: `processed ${processed.length} returns, skipped ${skipped.length} (legacy/invalid/duplicate/locked)`,
      actionRequired,
      returnIds: processed.map((result) => result.returnId ?? result.sourceFile),
      processedAt: new Date().toISOString(),
    },
  );
}

function writeWarning(workspaceRoot: string, warning: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    consumer: "gateway-return-consumer-v1",
    ...warning,
  });
  fs.appendFileSync(
    path.join(workspaceRoot, "runtime", "main", "tmp", "return-consumer-warn.jsonl"),
    `${line}\n`,
    "utf8",
  );
}

function writeErrorReport(workspaceRoot: string, err: unknown, sourceFile?: string): void {
  const stamp = compactStamp();
  writeJson(
    path.join(workspaceRoot, "runtime", "main", "tmp", `return-consumer-error-${stamp}.json`),
    {
      timestamp: new Date().toISOString(),
      consumer: "gateway-return-consumer-v1",
      sourceFile,
      error: errorMessage(err),
    },
  );
}

function readUtf8JsonText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeFilePart(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
      .replace(/\s+/gu, "_")
      .slice(0, 120) || "unknown"
  );
}

function compactStamp(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 15);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
