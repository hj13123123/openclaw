/**
 * P1-BATCH10 Phase C: Apply Smoke Runner
 * Runs tickApplySmoke() from the source TypeScript runtime-loop module.
 * Invoke with a TypeScript loader, for example: node --import tsx scripts/apply-smoke-runner.mjs
 *
 * P2-E adds a bounded continuous apply smoke mode:
 *   node --import tsx scripts/apply-smoke-runner.mjs --boundedLoop
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tickApplySmoke } from "../src/runtime/runtime-loop.ts";

const DEFAULT_WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE || "C:\\Users\\36371\\.openclaw\\workspace-main";
const APPLY_SMOKE_MARKER_REL = "runtime/main/tmp/runtime-loop-apply-smoke-marker.json";
const SMOKE_TASK_ID = "P1-BATCH10-SMOKE-TASK-001";
const ACTIVE_STATUSES = new Set(["queued", "dispatched", "running", "return_received", "processing_return", "deferred"]);
const FORBIDDEN_TASK_PREFIXES = ["A1", "EP-8", "EP-9"];
const BOUNDED_LOOP_MAX_TICKS = 2;
const BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK = 1;
const BOUNDED_LOOP_MAX_SESSIONS_SPAWN_CALLS = BOUNDED_LOOP_MAX_TICKS * BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK;
const CONTINUOUS_APPLY_MAX_TICKS = 3;
const CONTINUOUS_APPLY_MAX_DURATION_MS = 600_000;
const COOLDOWN_TICK_MS = 2_000;
const GATEWAY_HEALTH_URL = process.env.OPENCLAW_GATEWAY_HEALTH_URL || "http://127.0.0.1:18789/health";
const GATEWAY_PRECHECK_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_GATEWAY_PRECHECK_TIMEOUT_MS ?? "3000", 10);
const GATEWAY_PRECHECK_MAX_ATTEMPTS = 2;
const GATEWAY_PRECHECK_RETRY_DELAY_MS = 5_000;
const configuredReturnWaitMs = Number.parseInt(process.env.OPENCLAW_APPLY_SMOKE_RETURN_WAIT_MS ?? "180000", 10);
const DEFAULT_RETURN_WAIT_MS = Number.isFinite(configuredReturnWaitMs) && configuredReturnWaitMs > 0
  ? configuredReturnWaitMs
  : 180_000;

// ─── P2-N-B: Execution Lease Policy Constants ───
const LEASE_NO_PROGRESS_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_LEASE_NO_PROGRESS_MS ?? "300000", 10);   // 5 min default
const LEASE_HARD_STOP_MS = Number.parseInt(process.env.OPENCLAW_LEASE_HARD_STOP_MS ?? "1800000", 10);               // 30 min default
const LEASE_PROGRESS_CHECK_INTERVAL_MS = Number.parseInt(process.env.OPENCLAW_LEASE_CHECK_INTERVAL_MS ?? "30000", 10); // 30 s default
const LEASE_API_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_LEASE_API_TIMEOUT_MS ?? "30000", 10);               // 30 s default
const LEASE_RETURN_PARTIAL_POLL_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function countJsonFiles(dirPath) {
  if (!existsSync(dirPath)) return 0;
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .length;
}

function taskMatches(record, { taskId, phase, runId, idempotencyKey }) {
  if (record?.taskId !== taskId) return false;
  const metadata = record?.metadata ?? {};
  if (idempotencyKey) return metadata.idempotencyKey === idempotencyKey;
  if (runId) return metadata.runId === runId;
  if (phase) return metadata.phase === phase;
  return true;
}

function latestTaskRecord(workspaceRoot, match) {
  const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
  return readJsonl(tasksPath).filter((record) => taskMatches(record, match)).at(-1) ?? null;
}

function smokeChain(workspaceRoot, match) {
  const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
  return readJsonl(tasksPath)
    .filter((record) => taskMatches(record, { taskId: SMOKE_TASK_ID, ...match }))
    .map((record) => ({
      status: record.status,
      updatedAt: record.updatedAt,
      phase: record.metadata?.phase ?? null,
      runId: record.metadata?.runId ?? null,
      idempotencyKey: record.metadata?.idempotencyKey ?? null,
      requestId: record.metadata?.requestId ?? null,
    }));
}

/**
 * P2-K-B: Clean smoke task returns from inbox to enable continuousApply between ticks.
 * watch-returns.ps1 -Apply uses copy-only (does not delete from inbox), so the inbox
 * accumulates after each tick and triggers checkSafetyGates inboxCount===0 guard.
 */
function cleanSmokeReturns(workspaceRoot) {
  const inboxDir = path.join(workspaceRoot, "system", "returns", "inbox");
  if (!existsSync(inboxDir)) return;
  for (const name of readdirSync(inboxDir)) {
    if (name.startsWith(`${SMOKE_TASK_ID}-`)) {
      unlinkSync(path.join(inboxDir, name));
      console.log(`[apply-smoke-runner] cleanSmokeReturns: removed ${name}`);
    }
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function returnMatches(record, { taskId, phase, runId, idempotencyKey }) {
  if (!record || typeof record !== "object") return false;
  if (record.taskId !== taskId) return false;
  if (idempotencyKey && record.idempotencyKey === idempotencyKey) return true;
  if (runId && record.runId === runId) return true;
  return !idempotencyKey && !runId && (!phase || record.phase === phase);
}

function listReturnFiles(workspaceRoot) {
  const inboxDir = path.join(workspaceRoot, "system/returns/inbox");
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(inboxDir, entry.name))
    .sort();
}

function invokeWatchReturns(workspaceRoot, match) {
  if (!match?.taskId || !match?.runId || !match?.idempotencyKey || !match?.phase) {
    throw new Error("watch-returns invocation requires exact taskId, runId, idempotencyKey, and phase filters");
  }
  const watchScript = path.join(workspaceRoot, "evolution", "watch-returns.ps1");
  if (!existsSync(watchScript)) {
    throw new Error(`watch-returns.ps1 not found: ${watchScript}`);
  }
  const output = execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    watchScript,
    "-Apply",
    "-TaskId",
    match.taskId,
    "-RunId",
    match.runId,
    "-IdempotencyKey",
    match.idempotencyKey,
    "-Phase",
    match.phase,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const parsed = safeReadJsonFromString(output);
  console.log(`[apply-smoke-runner] watch-returns filtered taskId=${match.taskId} phase=${match.phase} runId=${match.runId} idempotencyKey=${match.idempotencyKey} extractedReturns=${parsed?.extractedReturns ?? "unknown"} action=${parsed?.actionTaken ?? "unknown"}`);
  return parsed;
}

function safeReadJsonFromString(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function appendTaskStatus(workspaceRoot, taskId, status, summary, metadata) {
  const tasksPath = path.join(workspaceRoot, "runtime/tasks/tasks.jsonl");
  mkdirSync(path.dirname(tasksPath), { recursive: true });
  const timestamp = new Date().toISOString();
  appendFileSync(tasksPath, `${JSON.stringify({
    taskId,
    status,
    sourceRole: "system",
    createdAt: timestamp,
    updatedAt: timestamp,
    summary,
    metadata: {
      validationOnly: true,
      source: "apply-smoke-runner",
      ...metadata,
    },
  })}\n`, "utf8");
}

function emitRunnerEvent(workspaceRoot, eventType, payload) {
  const eventsPath = path.join(workspaceRoot, "runtime/events/events.jsonl");
  mkdirSync(path.dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify({
    eventId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    eventType,
    timestamp: new Date().toISOString(),
    source: "gateway-runtime-loop",
    payload,
  })}\n`, "utf8");
}


function boundarySafetyGates(workspaceRoot, tickNum, match = {}) {
  const tasks = readJsonl(path.join(workspaceRoot, "runtime/tasks/tasks.jsonl"));
  const inboxCount = countJsonFiles(path.join(workspaceRoot, "system/returns/inbox"));
  const candidatesCount = countJsonFiles(path.join(workspaceRoot, "runtime/human-gate/candidates"));
  const activeForbidden = tasks.filter((record) => {
    const taskId = typeof record?.taskId === "string" ? record.taskId : "";
    return FORBIDDEN_TASK_PREFIXES.some((prefix) => taskId === prefix || taskId.startsWith(`${prefix}-`))
      && ACTIVE_STATUSES.has(record?.status);
  });
  return {
    pass: inboxCount === 0 && candidatesCount === 0 && activeForbidden.length === 0,
    details: [
      `tick=${tickNum}`,
      `phase=${match.phase ?? "missing"}`,
      `runId=${match.runId ?? "missing"}`,
      `idempotencyKey=${match.idempotencyKey ?? "missing"}`,
      `inbox=${inboxCount}`,
      `candidates=${candidatesCount}`,
      `activeForbidden=${activeForbidden.length}`,
    ],
    inboxCount,
    candidatesCount,
    activeForbidden: activeForbidden.map((record) => ({ taskId: record.taskId, status: record.status })),
  };
}

async function gatewayHealthPreflight({ timeoutMs = GATEWAY_PRECHECK_TIMEOUT_MS, url = GATEWAY_HEALTH_URL } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      reason: response.ok ? "ok" : `http_${response.status}`,
      code: response.ok ? "GATEWAY_PRECHECK_OK" : "GATEWAY_PRECHECK_FAILED",
      url,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      reason: timeout ? "precheck_timeout" : message,
      code: "GATEWAY_PRECHECK_FAILED",
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runGatewayPreflightWithRetry(workspaceRoot, tickNum, match, { tickStartedAt, loopStartedAt, maxTicks, maxDurationMs }) {
  const attempts = [];
  for (let attempt = 1; attempt <= GATEWAY_PRECHECK_MAX_ATTEMPTS; attempt += 1) {
    const beforeSafety = boundarySafetyGates(workspaceRoot, tickNum, match);
    const beforeStop = stopCheck({
      tickNum,
      safetyGates: beforeSafety,
      callSummary: { status: "PASS", sessionsSpawnCalls: 0, maxSessionsSpawnCalls: Number.POSITIVE_INFINITY },
      tickStartedAt,
      loopStartedAt,
      maxTicks,
      maxDurationMs,
    });
    if (beforeStop.stop && beforeStop.code !== "MAX_TICKS") {
      return { ok: false, attempts, stop: beforeStop, reason: "precheck_aborted_before_attempt", code: "DISPATCH_ABORTED_BEFORE_SPAWN" };
    }

    const result = await gatewayHealthPreflight();
    attempts.push({ attempt, ...result });
    emitRunnerEvent(workspaceRoot, result.ok ? "runtime_loop_gateway_precheck_ok" : "runtime_loop_gateway_precheck_failed", {
      taskId: SMOKE_TASK_ID,
      phase: match.phase,
      runId: match.runId,
      idempotencyKey: match.idempotencyKey,
      attempt,
      maxAttempts: GATEWAY_PRECHECK_MAX_ATTEMPTS,
      reason: result.reason,
      code: result.code,
      elapsedMs: result.elapsedMs,
      url: result.url,
    });

    const afterSafety = boundarySafetyGates(workspaceRoot, tickNum, match);
    const afterStop = stopCheck({
      tickNum,
      safetyGates: afterSafety,
      callSummary: result.ok
        ? { status: "PASS", sessionsSpawnCalls: 0, maxSessionsSpawnCalls: Number.POSITIVE_INFINITY }
        : { status: "BLOCKED", blockReason: `${result.code}: ${result.reason}`, sessionsSpawnCalls: 0, maxSessionsSpawnCalls: Number.POSITIVE_INFINITY },
      tickStartedAt,
      loopStartedAt,
      maxTicks,
      maxDurationMs,
    });
    if (result.ok) return { ok: true, attempts, stop: afterStop, reason: "ok", code: "GATEWAY_PRECHECK_OK" };
    if (attempt >= GATEWAY_PRECHECK_MAX_ATTEMPTS) {
      return { ok: false, attempts, stop: afterStop, reason: "max_retries_exceeded", code: "GATEWAY_PRECHECK_FAILED" };
    }
    if (afterStop.stop) return { ok: false, attempts, stop: afterStop, reason: result.reason, code: "GATEWAY_PRECHECK_FAILED" };
    await sleep(GATEWAY_PRECHECK_RETRY_DELAY_MS);
  }
  return { ok: false, attempts, stop: null, reason: "max_retries_exceeded", code: "GATEWAY_PRECHECK_FAILED" };
}

/**
 * P2-N-B: Check EE transcript for progress signals.
 * Reads the session transcript and returns structured progress signal state.
 * Used by lease-aware wait functions to determine LEASE_ACTIVE vs EXECUTION_STALLED.
 */
function checkTranscriptProgress(workspaceRoot, agentId = "engineering-executive", sessionKey = null) {
  const storePath = path.join(process.env.USERPROFILE || "C:\\Users\\36371", ".openclaw", "agents", agentId, "sessions", "sessions.json");
  let transcriptPath = null;
  let sessionId = null;

  // Try session store first, fall back to direct file path
  try {
    if (existsSync(storePath)) {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const targetKey = sessionKey || `agent:${agentId}:main`;
      const entry = store[targetKey];
      if (entry) {
        transcriptPath = entry.sessionFile;
        sessionId = entry.sessionId;
      }
    }
  } catch { /* degrade gracefully */ }

  // Fallback: guess transcript from session directory
  if (!transcriptPath) {
    const sessDir = path.join(process.env.USERPROFILE || "C:\\Users\\36371", ".openclaw", "agents", agentId, "sessions");
    if (existsSync(sessDir)) {
      const candidates = readdirSync(sessDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset.") && !f.includes(".delete") && !f.includes(".checkpoint."))
        .sort((a, b) => statSync(path.join(sessDir, b)).mtimeMs - statSync(path.join(sessDir, a)).mtimeMs);
      if (candidates.length > 0) transcriptPath = path.join(sessDir, candidates[0]);
    }
  }

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { readable: false, signals: {}, anySignal: false, sessionId: null };
  }

  const stat = statSync(transcriptPath);
  const content = readFileSync(transcriptPath, "utf8");
  const lines = content.split(/\r?\n/u).filter(Boolean);

  // Progress signals (P2-N-B: all 7 from Execution Lease Policy)
  const signals = {
    transcriptGrowth: lines.length > 0,
    toolCallStarted: /"type":\s*"toolCall"/u.test(content),
    toolOutputReturned: /"type":\s*"toolResult"/u.test(content),
    thinkingActivity: /"type":\s*"thinking"/u.test(content),
    sessionUpdated: stat.mtimeMs > 0,
    returnPartial: /ROLE_RETURN_PACKAGE/iu.test(content),
    bootstrapProgress: /bootstrap/iu.test(content),
  };
  const anySignal = Object.values(signals).some(Boolean);

  return {
    readable: true,
    transcriptPath,
    sessionId,
    lineCount: lines.length,
    fileSize: stat.size,
    lastModified: stat.mtime.toISOString(),
    signals,
    anySignal,
  };
}

/**
 * P2-O-D: Invoke lease-human-gate-bridge.ps1 in dry-run mode.
 * Called when lease detects EXECUTION_STALLED or HARD_STOP.
 * Always dry-run — never writes real candidates (Apply mode is P2-O-E+).
 */
async function invokeLeaseHumanGateBridge(workspaceRoot, { taskId, phase, runId, sessionKey, taskType, leaseVerdict, noProgressDurationMs, hardStopReached, progressSignals, lastProgressAt, startedAt }) {
  const bridgeScript = path.join(workspaceRoot, "evolution", "lease-human-gate-bridge.ps1");
  const configPath = path.join(workspaceRoot, "runtime", "main", "tmp", "p2-o-b-lease-bridge-config.json");
  const tmpDir = path.join(workspaceRoot, "runtime", "main", "tmp");
  const uuid = randomUUID().replace(/-/g, "").slice(0, 8);

  const noProgressTimeoutMs = LEASE_NO_PROGRESS_TIMEOUT_MS;
  const hardStopMs = LEASE_HARD_STOP_MS;
  const now = new Date();

  // Mock task metadata
  const taskMeta = { taskId, phase, runId, sessionKey, taskType };
  const taskMetaPath = path.join(tmpDir, `p2-o-d-hook-task-${uuid}.json`);
  writeFileSync(taskMetaPath, JSON.stringify(taskMeta, null, 2), "utf8");

  // Mock lease verdict
  const evidence = {
    lastProgressAt: lastProgressAt ? new Date(lastProgressAt).toISOString() : now.toISOString(),
    timeSinceLastProgressSec: noProgressDurationMs / 1000,
    noProgressTimeoutSec: noProgressTimeoutMs / 1000,
    hardStopAt: new Date((startedAt || Date.now()) + hardStopMs).toISOString(),
    hardStopSec: hardStopMs / 1000,
    hardStopReached: hardStopReached || false,
    progressSignals: progressSignals || ["assistant", "toolResult"],
    stallReason: `No progress for ${(noProgressDurationMs / 1000).toFixed(1)}s (>${(noProgressTimeoutMs / 1000).toFixed(0)}s timeout). Last signal at ${lastProgressAt ? new Date(lastProgressAt).toISOString() : "unknown"}.`
  };
  const verdict = { leaseVerdict, task: { taskId, phase, runId, sessionKey }, evidence };
  const verdictPath = path.join(tmpDir, `p2-o-d-hook-verdict-${uuid}.json`);
  writeFileSync(verdictPath, JSON.stringify(verdict, null, 2), "utf8");

  // Call bridge (dry-run only in P2-O-D)
  try {
    const result = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `& '${bridgeScript}' -LeaseVerdictPath '${verdictPath}' -TaskMetadataPath '${taskMetaPath}' -ConfigPath '${configPath}'`
    ], { encoding: "utf8", timeout: LEASE_API_TIMEOUT_MS });
    const bridgeResult = JSON.parse(result.trim());
    console.log(`[apply-smoke-runner] LEASE_BRIDGE_HOOK: verdict=${leaseVerdict} taskType=${taskType} action=${bridgeResult.action} candidateId=${bridgeResult.candidateId || "none"} dryRun=${bridgeResult.dryRun} wouldCreateCandidate=${bridgeResult.action === "create_dry_run_candidate"}`);

    // Write hook report artifact
    const hookReport = {
      hook: "P2-O-D-LEASE-BRIDGE",
      invokedAt: now.toISOString(),
      leaseVerdict,
      taskId, phase, runId, taskType,
      bridgeResult,
      wouldCreateCandidate: bridgeResult.action === "create_dry_run_candidate",
      dryRun: bridgeResult.dryRun !== false,
      candidateWrittenToCandidatesDir: false,
      verdictPath,
      taskMetaPath
    };
    const reportPath = path.join(tmpDir, `p2-o-d-hook-report-${uuid}.json`);
    writeFileSync(reportPath, JSON.stringify(hookReport, null, 2), "utf8");

    return { bridgeResult, hookReportPath: reportPath, error: null };
  } catch (err) {
    console.error(`[apply-smoke-runner] LEASE_BRIDGE_HOOK failed: ${err.message}`);
    return { bridgeResult: null, hookReportPath: null, error: err.message };
  }
}

async function waitForMatchingReturn(workspaceRoot, match, maxWaitMs = DEFAULT_RETURN_WAIT_MS, pollMs = 2_000, leaseOpts = {}) {
  const startedAt = Date.now();
  const noProgressTimeoutMs = leaseOpts.noProgressTimeoutMs ?? LEASE_NO_PROGRESS_TIMEOUT_MS;
  const hardStopMs = leaseOpts.hardStopMs ?? LEASE_HARD_STOP_MS;
  const checkIntervalMs = leaseOpts.progressCheckIntervalMs ?? LEASE_PROGRESS_CHECK_INTERVAL_MS;
  let lastProgressAt = startedAt;
  let lastLineCount = 0;
  let lastCheckAt = 0;
  let leaseStatus = "LEASE_ACTIVE";
  let _p2odStallHookCalled = false;

  console.log(`[apply-smoke-runner] waitForReturnMaxMs=${maxWaitMs} leaseEnabled=true noProgressTimeoutMs=${noProgressTimeoutMs} hardStopMs=${hardStopMs}`);
  while (Date.now() - startedAt <= maxWaitMs) {
    const now = Date.now();
    const elapsed = now - startedAt;

    // Hard stop check
    if (elapsed > hardStopMs) {
      leaseStatus = "HARD_STOP";
      console.log(`[apply-smoke-runner] HARD_STOP: elapsed ${elapsed}ms > ${hardStopMs}ms`);
      // P2-O-D: invoke lease bridge hook (dry-run)
      invokeLeaseHumanGateBridge(workspaceRoot, {
        taskId: match.taskId ?? "unknown",
        phase: match.phase ?? "unknown",
        runId: match.runId ?? "unknown",
        sessionKey: match.sessionKey ?? "agent:engineering-executive:main",
        taskType: match.taskType ?? "realTask",
        leaseVerdict: "HARD_STOP",
        noProgressDurationMs: elapsed,
        hardStopReached: true,
        progressSignals: ["assistant", "toolResult"],
        lastProgressAt,
        startedAt
      }).catch(() => {});
      return { filePath: null, record: null, elapsedMs: elapsed, returnLandedAt: null, leaseStatus };
    }

    // Progress signal check (every checkIntervalMs)
    if (now - lastCheckAt >= checkIntervalMs) {
      lastCheckAt = now;
      const progress = checkTranscriptProgress(workspaceRoot, "engineering-executive", "agent:engineering-executive:main");

      // Check for transcript growth
      if (progress.readable && progress.lineCount > lastLineCount) {
        lastLineCount = progress.lineCount;
        lastProgressAt = now;
        console.log(`[apply-smoke-runner] LEASE_RENEW: transcript growth ${lastLineCount} lines, toolCall=${progress.signals.toolCallStarted} returnPartial=${progress.signals.returnPartial}`);
      }
      // Check for other progress signals
      if (progress.readable && (progress.signals.toolCallStarted || progress.signals.toolOutputReturned || progress.signals.thinkingActivity || progress.signals.returnPartial || progress.signals.bootstrapProgress)) {
        lastProgressAt = now;
      }

      // No progress timeout check
      const idleMs = now - lastProgressAt;
      if (idleMs > noProgressTimeoutMs) {
        leaseStatus = "EXECUTION_STALLED";
        console.log(`[apply-smoke-runner] EXECUTION_STALLED: no progress for ${idleMs}ms > ${noProgressTimeoutMs}ms`);
        // Don't break immediately - keep polling for return in case it landed
        // P2-O-D: invoke lease bridge hook (dry-run, once)
        if (!_p2odStallHookCalled) {
          _p2odStallHookCalled = true;
          invokeLeaseHumanGateBridge(workspaceRoot, {
            taskId: match.taskId ?? "unknown",
            phase: match.phase ?? "unknown",
            runId: match.runId ?? "unknown",
            sessionKey: match.sessionKey ?? "agent:engineering-executive:main",
            taskType: match.taskType ?? "realTask",
            leaseVerdict: "EXECUTION_STALLED",
            noProgressDurationMs: idleMs,
            hardStopReached: false,
            progressSignals: ["assistant", "toolResult"],
            lastProgressAt,
            startedAt
          }).catch(() => {});
        }
      }
    }

    // Original return polling
    invokeWatchReturns(workspaceRoot, match);
    for (const filePath of listReturnFiles(workspaceRoot)) {
      const record = safeReadJson(filePath);
      if (returnMatches(record, match)) {
        const returnLandedAt = new Date().toISOString();
        if (record) lastProgressAt = Date.now(); // return landing = progress
        return { filePath, record, elapsedMs: Date.now() - startedAt, returnLandedAt, leaseStatus };
      }
    }
    await sleep(pollMs);
  }
  return { filePath: null, record: null, elapsedMs: Date.now() - startedAt, returnLandedAt: null, leaseStatus };
}

async function processMatchingReturn(workspaceRoot, match, { dispatchAcceptedAt = null, waitForReturnMaxMs = DEFAULT_RETURN_WAIT_MS } = {}) {
  const landed = await waitForMatchingReturn(workspaceRoot, match, waitForReturnMaxMs);
  if (!landed.filePath || !landed.record) {
    throw new Error(`Timed out waiting ${waitForReturnMaxMs}ms for matching return: taskId=${match.taskId} phase=${match.phase} runId=${match.runId} idempotencyKey=${match.idempotencyKey}`);
  }

  const actualReturnLatencyMs = dispatchAcceptedAt && landed.returnLandedAt
    ? Date.parse(landed.returnLandedAt) - Date.parse(dispatchAcceptedAt)
    : landed.elapsedMs;
  console.log(`[apply-smoke-runner] dispatchAcceptedAt=${dispatchAcceptedAt ?? "unknown"}`);
  console.log(`[apply-smoke-runner] returnLandedAt=${landed.returnLandedAt ?? "unknown"}`);
  console.log(`[apply-smoke-runner] actualReturnLatencyMs=${actualReturnLatencyMs}`);

  const summary = typeof landed.record.summary === "string" ? landed.record.summary : "Runtime smoke return processed";
  const metadata = {
    phase: match.phase,
    runId: match.runId,
    idempotencyKey: match.idempotencyKey,
    returnId: landed.record.returnId ?? null,
    returnPath: path.relative(workspaceRoot, landed.filePath),
  };

  appendTaskStatus(workspaceRoot, match.taskId, "return_received", summary, metadata);
  appendTaskStatus(workspaceRoot, match.taskId, "processing_return", summary, metadata);

  const processedDir = path.join(workspaceRoot, "system/returns/processed");
  const consumedDir = path.join(workspaceRoot, "system/returns/archive/consumed-returns", new Date().toISOString().slice(0, 10));
  mkdirSync(processedDir, { recursive: true });
  mkdirSync(consumedDir, { recursive: true });
  const fileName = path.basename(landed.filePath);
  const processedPath = path.join(processedDir, fileName);
  const consumedPath = path.join(consumedDir, fileName);
  copyFileSync(landed.filePath, processedPath);
  copyFileSync(landed.filePath, consumedPath);
  unlinkSync(landed.filePath);

  appendTaskStatus(workspaceRoot, match.taskId, "completed", summary, {
    ...metadata,
    processedPath: path.relative(workspaceRoot, processedPath),
    consumedPath: path.relative(workspaceRoot, consumedPath),
  });
  emitRunnerEvent(workspaceRoot, "runtime_loop_apply_smoke_return_processed", {
    taskId: match.taskId,
    phase: match.phase,
    runId: match.runId,
    idempotencyKey: match.idempotencyKey,
    returnPath: path.relative(workspaceRoot, landed.filePath),
    processedPath: path.relative(workspaceRoot, processedPath),
    consumedPath: path.relative(workspaceRoot, consumedPath),
  });
  return {
    processed: true,
    elapsedMs: landed.elapsedMs,
    dispatchAcceptedAt,
    returnLandedAt: landed.returnLandedAt,
    actualReturnLatencyMs,
    processedPath,
    consumedPath,
  };
}

/**
 * P2-N-B: Check lease status when an API timeout occurs (sessions_send, agent.wait, etc).
 * This prevents misjudging API timeouts as task failures.
 * Returns structured verdict following Execution Lease Policy (ENGINEERING_RULES.md Rule 9).
 */
export function checkLeaseOnApiTimeout(workspaceRoot, opts = {}) {
  const agentId = opts.agentId ?? "engineering-executive";
  const sessionKey = opts.sessionKey ?? `agent:${agentId}:main`;
  const apiTimeoutMs = opts.apiTimeoutMs ?? LEASE_API_TIMEOUT_MS;
  const progress = checkTranscriptProgress(workspaceRoot, agentId, sessionKey);

  const verdict = {
    checkedAt: new Date().toISOString(),
    apiTimeout: true,
    apiTimeoutMs,
    sessionKey,
    sessionId: progress.sessionId,
    transcriptReadable: progress.readable,
    lineCount: progress.lineCount,
    progressSignals: progress.signals,
    anyProgress: progress.anySignal,
    leaseVerdict: "LEASE_ACTIVE",
    isTaskFailure: false,
    recommendation: "",
  };

  // API timeout does NOT equal task failure per Rule 9
  if (progress.anySignal) {
    verdict.leaseVerdict = "LEASE_ACTIVE";
    verdict.isTaskFailure = false;
    verdict.recommendation = "API timeout ignored due to progress signals; continue monitoring via lease";
  } else if (progress.readable) {
    // No signals but transcript readable → may still be early in execution
    verdict.leaseVerdict = "LEASE_ACTIVE";
    verdict.isTaskFailure = false;
    verdict.recommendation = "No progress signals yet, but transcript readable; enter lease monitor loop";
  } else {
    verdict.leaseVerdict = "BLOCKED";
    verdict.isTaskFailure = false; // Still not task failure — need human gate
    verdict.recommendation = "Transcript not readable; session may be unresponsive → human gate";
  }

  return verdict;
}

function writeApplySmokeMarker(workspaceRoot, tickNum, loopPrefix = "SMOKE") {
  const markerPath = path.join(workspaceRoot, APPLY_SMOKE_MARKER_REL);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[-:.]/g, "").slice(0, 15);
  const idempotencyKey = `${loopPrefix}-Tick${tickNum}-${timestamp}-${randomUUID()}`;
  const runId = randomUUID();
  const phase = `${loopPrefix}-Tick${tickNum}-${timestamp}-${idempotencyKey.slice(-12)}`;
  const marker = {
    phase,
    idempotencyKey,
    runId,
    maxDispatches: 1,
    spawnEnabled: true,
    mockTask: true,
    createdAt,
    boundedLoop: loopPrefix === "P2-G",
    boundedLoopTick: tickNum,
    loopPrefix,
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return { markerPath, phase, runId, idempotencyKey };
}

export async function waitForTaskCompleted(workspaceRoot, taskId, maxWaitMs = 120_000, pollMs = 5_000, match = {}, options = {}) {
  const startedAt = Date.now();
  const exactMatch = { taskId, ...match };
  const registered = latestTaskRecord(workspaceRoot, exactMatch);
  if (!registered) return { completed: false, status: "missing", elapsedMs: Date.now() - startedAt };

  // P2-N-B: Lease policy parameters
  const noProgressTimeoutMs = options.noProgressTimeoutMs ?? LEASE_NO_PROGRESS_TIMEOUT_MS;
  const hardStopMs = options.hardStopMs ?? LEASE_HARD_STOP_MS;
  const progressCheckIntervalMs = options.progressCheckIntervalMs ?? LEASE_PROGRESS_CHECK_INTERVAL_MS;
  let lastProgressAt = startedAt;
  let lastLineCount = 0;
  let lastCheckAt = 0;
  let leaseStatus = "LEASE_ACTIVE";
  let _p2odStallHookCalled = false;
  const effectiveMaxMs = Math.min(maxWaitMs, hardStopMs);

  console.log(`[apply-smoke-runner] waitForTaskCompleted leaseEnabled=true maxWaitMs=${maxWaitMs} effectiveMaxMs=${effectiveMaxMs} noProgressTimeoutMs=${noProgressTimeoutMs} hardStopMs=${hardStopMs}`);

  let status = typeof registered.status === "string" ? registered.status : "missing";
  let returnProcessing = null;
  while (Date.now() - startedAt <= effectiveMaxMs) {
    const now = Date.now();
    const elapsed = now - startedAt;

    // Progress signal check (P2-N-B: every checkIntervalMs)
    if (now - lastCheckAt >= progressCheckIntervalMs) {
      lastCheckAt = now;
      const progress = checkTranscriptProgress(workspaceRoot, "engineering-executive", "agent:engineering-executive:main");

      // Check for transcript growth signal
      if (progress.readable && progress.lineCount > lastLineCount) {
        lastLineCount = progress.lineCount;
        lastProgressAt = now;
        console.log(`[apply-smoke-runner] LEASE_RENEW: transcript growth lines=${progress.lineCount} toolCall=${progress.signals.toolCallStarted} thinking=${progress.signals.thinkingActivity} returnPartial=${progress.signals.returnPartial}`);
      }
      // Additional progress signals
      if (progress.readable && (progress.signals.toolCallStarted || progress.signals.toolOutputReturned || progress.signals.thinkingActivity || progress.signals.returnPartial || progress.signals.bootstrapProgress)) {
        lastProgressAt = now;
      }

      // No progress timeout → EXECUTION_STALLED
      const idleMs = now - lastProgressAt;
      if (idleMs > noProgressTimeoutMs) {
        leaseStatus = "EXECUTION_STALLED";
        console.log(`[apply-smoke-runner] EXECUTION_STALLED: no progress for ${idleMs}ms > ${noProgressTimeoutMs}ms`);
        // STALLED → break and report, do not continue waiting
        // P2-O-D: invoke lease bridge hook (dry-run, once)
        if (!_p2odStallHookCalled) {
          _p2odStallHookCalled = true;
          invokeLeaseHumanGateBridge(workspaceRoot, {
            taskId,
            phase: match.phase ?? exactMatch.phase ?? "unknown",
            runId: match.runId ?? exactMatch.runId ?? "unknown",
            sessionKey: match.sessionKey ?? "agent:engineering-executive:main",
            taskType: match.taskType ?? "realTask",
            leaseVerdict: "EXECUTION_STALLED",
            noProgressDurationMs: idleMs,
            hardStopReached: false,
            progressSignals: ["assistant", "toolResult"],
            lastProgressAt,
            startedAt
          }).catch(() => {});
        }
        break;
      }

      // Hard stop
      if (elapsed > hardStopMs) {
        leaseStatus = "HARD_STOP";
        console.log(`[apply-smoke-runner] HARD_STOP: elapsed ${elapsed}ms > ${hardStopMs}ms`);
        // P2-O-D: invoke lease bridge hook (dry-run)
        invokeLeaseHumanGateBridge(workspaceRoot, {
          taskId,
          phase: match.phase ?? exactMatch.phase ?? "unknown",
          runId: match.runId ?? exactMatch.runId ?? "unknown",
          sessionKey: match.sessionKey ?? "agent:engineering-executive:main",
          taskType: match.taskType ?? "realTask",
          leaseVerdict: "HARD_STOP",
          noProgressDurationMs: elapsed,
          hardStopReached: true,
          progressSignals: ["assistant", "toolResult"],
          lastProgressAt,
          startedAt
        }).catch(() => {});
        break;
      }
    }

    // Original task status polling
    const latest = latestTaskRecord(workspaceRoot, exactMatch);
    status = typeof latest?.status === "string" ? latest.status : "missing";
    if (status === "completed") {
      return { completed: true, status, elapsedMs: Date.now() - startedAt, returnProcessing, leaseStatus };
    }
    if (!returnProcessing && (status === "dispatched" || status === "running" || status === "return_received")) {
      returnProcessing = await processMatchingReturn(workspaceRoot, exactMatch, options);
      if (returnProcessing?.processed) {
        lastProgressAt = Date.now(); // return processed = progress
        return { completed: true, status: "completed", elapsedMs: Date.now() - startedAt, returnProcessing, leaseStatus };
      }
    }
    await sleep(pollMs);
  }
  return { completed: false, status, elapsedMs: Date.now() - startedAt, returnProcessing, leaseStatus };
}

export async function checkSafetyGates(workspaceRoot, tickNum, match = {}) {
  const phase = match.phase ?? `P2-G-Tick${tickNum}`;
  const tasks = readJsonl(path.join(workspaceRoot, "runtime/tasks/tasks.jsonl"));
  const latestSmoke = [...tasks]
    .reverse()
    .find((record) => taskMatches(record, { taskId: SMOKE_TASK_ID, ...match }));
  const inboxCount = countJsonFiles(path.join(workspaceRoot, "system/returns/inbox"));
  const candidatesCount = countJsonFiles(path.join(workspaceRoot, "runtime/human-gate/candidates"));
  const activeForbidden = tasks.filter((record) => {
    const taskId = typeof record?.taskId === "string" ? record.taskId : "";
    return FORBIDDEN_TASK_PREFIXES.some((prefix) => taskId === prefix || taskId.startsWith(`${prefix}-`))
      && ACTIVE_STATUSES.has(record?.status);
  });

  const details = [
    `tick=${tickNum}`,
    `phase=${phase}`,
    `runId=${match.runId ?? "missing"}`,
    `idempotencyKey=${match.idempotencyKey ?? "missing"}`,
    `latestSmokeStatus=${latestSmoke?.status ?? "missing"}`,
    `inbox=${inboxCount}`,
    `candidates=${candidatesCount}`,
    `activeForbidden=${activeForbidden.length}`,
  ];

  return {
    pass: latestSmoke?.status === "completed"
      && inboxCount === 0
      && candidatesCount === 0
      && activeForbidden.length === 0,
    details,
    latestSmokeStatus: latestSmoke?.status ?? "missing",
    inboxCount,
    candidatesCount,
    activeForbidden: activeForbidden.map((record) => ({ taskId: record.taskId, status: record.status })),
  };
}

export async function boundedLoop({ workspaceRoot = DEFAULT_WORKSPACE_ROOT, maxTicks = BOUNDED_LOOP_MAX_TICKS } = {}) {
  if (maxTicks !== BOUNDED_LOOP_MAX_TICKS) {
    throw new Error(`boundedLoop is hard-limited to maxTicks=${BOUNDED_LOOP_MAX_TICKS}; received ${maxTicks}`);
  }

  const summary = {
    mode: "boundedLoop",
    workspaceRoot,
    maxTicks: BOUNDED_LOOP_MAX_TICKS,
    maxDispatchesPerTick: BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK,
    maxSessionsSpawnCalls: BOUNDED_LOOP_MAX_SESSIONS_SPAWN_CALLS,
    waitForReturnMaxMs: DEFAULT_RETURN_WAIT_MS,
    sessionsSpawnCalls: 0,
    ticks: [],
    pass: false,
  };

  console.log(`[apply-smoke-runner] boundedLoop workspaceRoot: ${workspaceRoot}`);
  console.log(`[apply-smoke-runner] boundedLoop config: maxTicks=${BOUNDED_LOOP_MAX_TICKS} maxDispatchesPerTick=${BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK} maxSessionsSpawnCalls=${BOUNDED_LOOP_MAX_SESSIONS_SPAWN_CALLS}`);
  console.log(`[apply-smoke-runner] waitForReturnMaxMs=${DEFAULT_RETURN_WAIT_MS}`);

  for (let tickNum = 1; tickNum <= BOUNDED_LOOP_MAX_TICKS; tickNum += 1) {
    const { phase, markerPath, runId, idempotencyKey } = writeApplySmokeMarker(workspaceRoot, tickNum, "P2-G");
    const match = { phase, runId, idempotencyKey };
    console.log(`[apply-smoke-runner] Tick ${tickNum}: marker written phase=${phase} idempotencyKey=${idempotencyKey} path=${markerPath}`);

    const result = await tickApplySmoke(workspaceRoot);
    if (!result) {
      throw new Error(`Tick ${tickNum} failed: tickApplySmoke returned null`);
    }
    const dispatchAcceptedAt = new Date().toISOString();
    console.log(`[apply-smoke-runner] Tick ${tickNum}: dispatchAcceptedAt=${dispatchAcceptedAt}`);
    if (result.spawnEnabled) summary.sessionsSpawnCalls += 1;
    if (summary.sessionsSpawnCalls > BOUNDED_LOOP_MAX_SESSIONS_SPAWN_CALLS) {
      throw new Error(`boundedLoop sessions_spawn hard cap exceeded: ${summary.sessionsSpawnCalls} > ${BOUNDED_LOOP_MAX_SESSIONS_SPAWN_CALLS}`);
    }
    if (result.spawnApiBoundaryBlocked || result.sessionsSpawnAccepted !== true) {
      throw new Error(`Tick ${tickNum} dispatch failed: ${result.blockReason ?? "sessionsSpawnAccepted=false"}`);
    }

    const wait = await waitForTaskCompleted(workspaceRoot, result.selectedTask ?? SMOKE_TASK_ID, DEFAULT_RETURN_WAIT_MS + 60_000, 5_000, match, { dispatchAcceptedAt, waitForReturnMaxMs: DEFAULT_RETURN_WAIT_MS });
    console.log(`[apply-smoke-runner] Tick ${tickNum}: wait completed=${wait.completed} status=${wait.status} elapsedMs=${wait.elapsedMs}`);
    if (!wait.completed) {
      summary.ticks.push({ tickNum, phase, runId, idempotencyKey, result, wait, safety: null, chain: smokeChain(workspaceRoot, match) });
      throw new Error(`Tick ${tickNum} timeout waiting for completed; latest status=${wait.status}`);
    }

    const safety = await checkSafetyGates(workspaceRoot, tickNum, match);
    console.log(`[apply-smoke-runner] Tick ${tickNum}: safety pass=${safety.pass} details=${safety.details.join("; ")}`);
    const chain = smokeChain(workspaceRoot, match);
    summary.ticks.push({
      tickNum,
      phase,
      runId,
      idempotencyKey,
      dispatchAcceptedAt,
      returnLandedAt: wait.returnProcessing?.returnLandedAt ?? null,
      actualReturnLatencyMs: wait.returnProcessing?.actualReturnLatencyMs ?? null,
      tickId: result.tickId,
      selectedTask: result.selectedTask,
      requestPath: result.dispatchRequestPath,
      sessionKey: result.sessionKey,
      runtimeRunId: result.runId,
      wait,
      safety,
      chain,
    });

    if (!safety.pass) {
      throw new Error(`Tick ${tickNum} safety gate failed: ${safety.details.join("; ")}`);
    }
  }

  summary.pass = true;
  console.log("[apply-smoke-runner] boundedLoop PASS");
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}


function stopCheck({ tickNum, safetyGates, callSummary, tickStartedAt, loopStartedAt, maxTicks, maxDurationMs }) {
  const elapsed = Date.now() - loopStartedAt;
  const tickElapsed = Date.now() - tickStartedAt;
  const warnings = Array.isArray(callSummary?.warnings) ? callSummary.warnings.filter(Boolean) : [];
  const activeForbidden = Array.isArray(safetyGates?.activeForbidden) ? safetyGates.activeForbidden : [];
  const blockReason = typeof callSummary?.blockReason === "string" ? callSummary.blockReason : "";

  if (callSummary?.gatewayPrecheckFailed === true) return { stop: true, exitCode: 1, reason: blockReason || "gateway precheck failed", code: "GATEWAY_PRECHECK_FAILED", elapsed, tickElapsed };
  if (callSummary?.dispatchAbortedBeforeSpawn === true) return { stop: true, exitCode: 1, reason: blockReason || "dispatch aborted before spawn", code: "DISPATCH_ABORTED_BEFORE_SPAWN", elapsed, tickElapsed };
  if (callSummary?.callGatewayTimeout === true || /gateway timeout|timeout after|AbortError/iu.test(blockReason)) return { stop: true, exitCode: 1, reason: blockReason || "callGateway timeout", code: "CALL_GATEWAY_TIMEOUT", elapsed, tickElapsed };

  // 1. SAFETY_GATE
  if (!safetyGates?.pass) return { stop: true, exitCode: 1, reason: "safety gate not passed", code: "SAFETY_GATE", elapsed, tickElapsed };
  // 2. WARN (non-benign)
  if (warnings.length) return { stop: true, exitCode: 1, reason: `warnings: ${warnings.join("; ")}`, code: "WARN", elapsed, tickElapsed };
  // 3. FAIL
  if (callSummary?.status === "FAIL") return { stop: true, exitCode: 1, reason: "tick failed", code: "FAIL", elapsed, tickElapsed };
  // 4. BLOCKED
  if (callSummary?.status === "BLOCKED") return { stop: true, exitCode: 1, reason: "tick blocked", code: "BLOCKED", elapsed, tickElapsed };
  // 5. MAX_TICKS (the only PASS stop)
  if (tickNum >= maxTicks) return { stop: true, exitCode: 0, reason: `maxTicks=${maxTicks} reached`, code: "MAX_TICKS", elapsed, tickElapsed };
  // 6. MAX_DURATION
  if (elapsed >= maxDurationMs) return { stop: true, exitCode: 1, reason: `maxDuration exceeded: ${elapsed}ms > ${maxDurationMs}ms`, code: "MAX_DURATION", elapsed, tickElapsed };
  // 7. SPAWN_CAP
  if (callSummary?.sessionsSpawnCalls > callSummary?.maxSessionsSpawnCalls) return { stop: true, exitCode: 1, reason: `sessions_spawn cap exceeded: ${callSummary.sessionsSpawnCalls} > ${callSummary.maxSessionsSpawnCalls}`, code: "SPAWN_CAP", elapsed, tickElapsed };
  // 8. GATEWAY_DOWN
  if (callSummary?.gatewayDown === true || /gateway.*(down|unavailable|refused|failed)/iu.test(blockReason)) return { stop: true, exitCode: 1, reason: blockReason || "gateway down", code: "GATEWAY_DOWN", elapsed, tickElapsed };
  // 9. FORBIDDEN_ACTIVE
  if (activeForbidden.length > 0) return { stop: true, exitCode: 1, reason: `forbidden active tasks: ${activeForbidden.map((record) => `${record.taskId}:${record.status}`).join("; ")}`, code: "FORBIDDEN_ACTIVE", elapsed, tickElapsed };
  // 10. INTERNAL_ERROR
  if (callSummary?.internalError || callSummary?.error) return { stop: true, exitCode: 1, reason: String(callSummary.internalError ?? callSummary.error), code: "INTERNAL_ERROR", elapsed, tickElapsed };
  // 11. SPAWN_REJECTED
  if (callSummary?.spawnApiBoundaryBlocked || callSummary?.sessionsSpawnAccepted === false) return { stop: true, exitCode: 1, reason: blockReason || "sessions_spawn rejected", code: "SPAWN_REJECTED", elapsed, tickElapsed };
  return { stop: false, exitCode: 0, reason: "ok", code: "OK", elapsed, tickElapsed };
}

export async function continuousApplyLoop({
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  maxTicks = CONTINUOUS_APPLY_MAX_TICKS,
  maxDurationMs = CONTINUOUS_APPLY_MAX_DURATION_MS,
  cooldownTickMs = COOLDOWN_TICK_MS,
} = {}) {
  const loopStartedAt = Date.now();
  const maxSessionsSpawnCalls = maxTicks * BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK;
  const summary = {
    mode: "continuousApply",
    workspaceRoot,
    maxTicks,
    maxDurationMs,
    cooldownTickMs,
    maxDispatchesPerTick: BOUNDED_LOOP_MAX_DISPATCHES_PER_TICK,
    maxSessionsSpawnCalls,
    waitForReturnMaxMs: DEFAULT_RETURN_WAIT_MS,
    sessionsSpawnCalls: 0,
    ticks: [],
    stop: null,
    pass: false,
  };

  console.log(`[apply-smoke-runner] continuousApply workspaceRoot: ${workspaceRoot}`);
  console.log(`[apply-smoke-runner] continuousApply config: maxTicks=${maxTicks} maxDurationMs=${maxDurationMs} cooldownTickMs=${cooldownTickMs} maxSessionsSpawnCalls=${maxSessionsSpawnCalls}`);

  for (let tickNum = 1; tickNum <= maxTicks; tickNum += 1) {
    const tickStartedAt = Date.now();
    const { phase, markerPath, runId, idempotencyKey } = writeApplySmokeMarker(workspaceRoot, tickNum, "P2-I");
    const match = { phase, runId, idempotencyKey };
    let result = null;
    let wait = null;
    let safety = null;
    let chain = [];
    let callSummary = null;

    try {
      console.log(`[apply-smoke-runner] Continuous tick ${tickNum}: marker written phase=${phase} idempotencyKey=${idempotencyKey} path=${markerPath}`);
      const preflight = await runGatewayPreflightWithRetry(workspaceRoot, tickNum, match, { tickStartedAt, loopStartedAt, maxTicks, maxDurationMs });
      if (!preflight.ok) {
        const reason = preflight.reason === "max_retries_exceeded" ? "max_retries_exceeded" : "precheck_failed";
        appendTaskStatus(workspaceRoot, SMOKE_TASK_ID, "failed", `Dispatch aborted before spawn: ${preflight.code} ${reason}`, {
          phase,
          runId,
          idempotencyKey,
          reason,
          blockCode: preflight.code,
          attempts: preflight.attempts,
          dispatchAbortedBeforeSpawn: true,
        });
        emitRunnerEvent(workspaceRoot, "runtime_loop_dispatch_aborted_before_spawn", {
          taskId: SMOKE_TASK_ID,
          phase,
          runId,
          idempotencyKey,
          reason,
          blockCode: preflight.code,
          attempts: preflight.attempts,
        });
        callSummary = {
          status: "BLOCKED",
          gatewayPrecheckFailed: preflight.code === "GATEWAY_PRECHECK_FAILED",
          dispatchAbortedBeforeSpawn: true,
          blockReason: `${preflight.code}: ${reason}`,
          sessionsSpawnCalls: summary.sessionsSpawnCalls,
          maxSessionsSpawnCalls,
        };
        safety = boundarySafetyGates(workspaceRoot, tickNum, match);
        summary.ticks.push({ tickNum, phase, runId, idempotencyKey, preflight, result, wait, safety, chain });
        const stop = stopCheck({ tickNum, safetyGates: safety, callSummary, tickStartedAt, loopStartedAt, maxTicks, maxDurationMs });
        summary.stop = stop;
        summary.pass = false;
        emitRunnerEvent(workspaceRoot, "runtime_loop_continuous_apply_stop", { taskId: SMOKE_TASK_ID, tickNum, phase, runId, idempotencyKey, stop });
        console.log(JSON.stringify(summary, null, 2));
        const stopError = new Error(`continuousApply stopped: ${stop.code} ${stop.reason}`);
        stopError.__continuousApplyRecorded = true;
        throw stopError;
      }
      result = await tickApplySmoke(workspaceRoot);
      if (!result) throw new Error(`Continuous tick ${tickNum} failed: tickApplySmoke returned null`);
      const dispatchAcceptedAt = new Date().toISOString();
      if (result.spawnEnabled) summary.sessionsSpawnCalls += 1;
      wait = await waitForTaskCompleted(workspaceRoot, result.selectedTask ?? SMOKE_TASK_ID, DEFAULT_RETURN_WAIT_MS + 60_000, 5_000, match, { dispatchAcceptedAt, waitForReturnMaxMs: DEFAULT_RETURN_WAIT_MS });
      if (wait.completed) cleanSmokeReturns(workspaceRoot);  // P2-K-B: inbox cleanup between ticks
      safety = await checkSafetyGates(workspaceRoot, tickNum, match);
      chain = smokeChain(workspaceRoot, match);
      callSummary = {
        status: wait.completed ? "PASS" : "FAIL",
        warnings: result.warnings,
        blockReason: result.blockReason,
        callGatewayTimeout: /CALL_GATEWAY_TIMEOUT|gateway timeout|timeout after/iu.test(String(result.blockReason ?? "")),
        gatewayPrecheckFailed: /GATEWAY_PRECHECK_FAILED/iu.test(String(result.blockReason ?? "")),
        dispatchAbortedBeforeSpawn: /DISPATCH_ABORTED_BEFORE_SPAWN/iu.test(String(result.blockReason ?? "")),
        spawnApiBoundaryBlocked: result.spawnApiBoundaryBlocked,
        sessionsSpawnAccepted: result.sessionsSpawnAccepted,
        sessionsSpawnCalls: summary.sessionsSpawnCalls,
        maxSessionsSpawnCalls,
      };
      summary.ticks.push({ tickNum, phase, runId, idempotencyKey, dispatchAcceptedAt, result, wait, safety, chain });
    } catch (error) {
      if (error && typeof error === "object" && error.__continuousApplyRecorded === true) throw error;
      safety = safety ?? { pass: false, details: [`internalError=${error instanceof Error ? error.message : String(error)}`], activeForbidden: [] };
      callSummary = {
        status: "FAIL",
        internalError: error instanceof Error ? error.message : String(error),
        sessionsSpawnCalls: summary.sessionsSpawnCalls,
        maxSessionsSpawnCalls,
      };
      summary.ticks.push({ tickNum, phase, runId, idempotencyKey, result, wait, safety, chain, error: callSummary.internalError });
    }

    const stop = stopCheck({ tickNum, safetyGates: safety, callSummary, tickStartedAt, loopStartedAt, maxTicks, maxDurationMs });
    console.log(`[apply-smoke-runner] Continuous tick ${tickNum}: stop=${stop.stop} code=${stop.code} reason=${stop.reason}`);
    if (stop.stop) {
      summary.stop = stop;
      summary.pass = stop.code === "MAX_TICKS" && stop.exitCode === 0;
      emitRunnerEvent(workspaceRoot, "runtime_loop_continuous_apply_stop", {
        taskId: SMOKE_TASK_ID,
        tickNum,
        phase,
        runId,
        idempotencyKey,
        stop,
      });
      console.log(JSON.stringify(summary, null, 2));
      if (stop.exitCode !== 0) throw new Error(`continuousApply stopped: ${stop.code} ${stop.reason}`);
      return summary;
    }

    await sleep(cooldownTickMs);
  }

  summary.stop = { stop: true, exitCode: 0, reason: `maxTicks=${maxTicks} reached`, code: "MAX_TICKS", elapsed: Date.now() - loopStartedAt };
  summary.pass = true;
  emitRunnerEvent(workspaceRoot, "runtime_loop_continuous_apply_stop", { taskId: SMOKE_TASK_ID, stop: summary.stop });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function runOnce(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  console.log(`[apply-smoke-runner] workspaceRoot: ${workspaceRoot}`);
  const result = await tickApplySmoke(workspaceRoot);
  if (!result) {
    console.log("[apply-smoke-runner] NO SMOKE MARKER FOUND - nothing to do");
    return 0;
  }
  console.log("[apply-smoke-runner] SMOKE COMPLETED");
  console.log(`  tickId:            ${result.tickId}`);
  console.log(`  phase:             ${result.phase}`);
  console.log(`  selectedTask:      ${result.selectedTask}`);
  console.log(`  wouldDispatch:     ${result.wouldDispatch}`);
  console.log(`  dispatchRequestPath: ${result.dispatchRequestPath}`);
  console.log(`  spawnEnabled:      ${result.spawnEnabled}`);
  console.log(`  spawnSuppressed:   ${result.spawnSuppressed}`);
  console.log(`  sessionsSpawnAccepted: ${result.sessionsSpawnAccepted}`);
  console.log(`  spawnApiBoundaryBlocked: ${result.spawnApiBoundaryBlocked}`);
  console.log(`  events:            ${result.events.length}`);
  console.log(`  warnings:          ${JSON.stringify(result.warnings)}`);
  return 0;
}

// ─── P2-L-C1: Session Recovery ───────────────────────────────────────────────

function readSessionStore(workspaceRoot, agentId) {
  const storePath = path.join(process.env.USERPROFILE || "C:\\Users\\36371", ".openclaw", "agents", agentId, "sessions", "sessions.json");
  if (!existsSync(storePath)) return null;
  try {
    return JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    return null;
  }
}

function getSessionEntry(workspaceRoot, sessionKey) {
  const parsed = sessionKey.startsWith("agent:") ? sessionKey.slice(6).split(":") : [sessionKey];
  const agentId = parsed[0] ?? "engineering-executive";
  const store = readSessionStore(workspaceRoot, agentId);
  if (!store) return null;
  return store[sessionKey] ?? null;
}

function countTranscriptLines(filePath) {
  if (!existsSync(filePath)) return -1;
  return readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).length;
}

/**
 * P2-L-C1: checkSessionThreshold
 * Reads the EE/FE/curator session entry and checks against size/line/idle thresholds.
 * Returns { sessionKey, sessionId, sessionFile, fileSize, lineCount, lastWriteTime, metrics, thresholdExceeded, reasons, recommendedAction }.
 */
function checkSessionThreshold(workspaceRoot, sessionKey, opts = {}) {
  const now = new Date();
  const entry = getSessionEntry(workspaceRoot, sessionKey);
  const role = sessionKey.includes("engineering-executive") ? "engineering-executive"
    : sessionKey.includes("front-end-executive") ? "front-end-executive"
    : sessionKey.includes("evolution-curator") ? "evolution-curator"
    : "unknown";

  if (!entry) {
    return {
      sessionKey,
      sessionId: null,
      sessionFile: null,
      fileSize: -1,
      lineCount: -1,
      lastWriteTime: null,
      thresholdExceeded: false,
      reasons: ["session_entry_not_found"],
      recommendedAction: "SESSION_RESET_FAILED",
      metrics: { role, checkedAt: now.toISOString() },
    };
  }

  const sessionFile = entry.sessionFile;
  const fileStat = existsSync(sessionFile) ? statSync(sessionFile) : null;
  const fileSize = fileStat ? fileStat.size : -1;
  const lineCount = countTranscriptLines(sessionFile);
  const lastWriteTime = fileStat ? new Date(fileStat.mtimeMs).toISOString() : null;

  // Role-specific thresholds
  const thresholds = {
    "engineering-executive": { softSizeMb: 5, hardSizeMb: 8, softLines: 1200, hardLines: 1600 },
    "front-end-executive": { softSizeMb: 4, hardSizeMb: 7, softLines: 1000, hardLines: 1400 },
    "evolution-curator": { softSizeMb: 3, hardSizeMb: 5, softLines: 800, hardLines: 1200 },
    "unknown": { softSizeMb: 3, hardSizeMb: 5, softLines: 800, hardLines: 1200 },
  };
  const t = thresholds[role] ?? thresholds["unknown"];
  const sizeMB = fileSize > 0 ? (fileSize / (1024 * 1024)).toFixed(2) : "N/A";
  const reasons = [];
  let exceeded = false;

  if (fileSize > t.softSizeMb * 1024 * 1024) {
    exceeded = true;
    reasons.push(`size_gt_${t.softSizeMb}mb`);
  }
  if (lineCount > t.softLines) {
    exceeded = true;
    reasons.push(`lines_gt_${t.softLines}`);
  }

  // Hard threshold check (separate tracking)
  const hardReasons = [];
  if (fileSize > t.hardSizeMb * 1024 * 1024) hardReasons.push(`size_gt_${t.hardSizeMb}mb_hard`);
  if (lineCount > t.hardLines) hardReasons.push(`lines_gt_${t.hardLines}_hard`);

  // Idle check (uses session entry updatedAt)
  const idleMs = entry.updatedAt ? (now.getTime() - entry.updatedAt) : -1;
  const idleMinutes = idleMs > 0 ? (idleMs / 60_000).toFixed(0) : "unknown";

  let recommendedAction = "NO_RESET_NEEDED";
  if (exceeded) {
    recommendedAction = "SOFT_RESET_REQUIRED";
  }
  if (hardReasons.length > 0 && opts?.simulateSessionResetFailed) {
    recommendedAction = "SESSION_RESET_FAILED";
  }

  return {
    sessionKey,
    sessionId: entry.sessionId ?? null,
    sessionFile,
    fileSize,
    fileSizeDisplay: `${sizeMB} MB`,
    lineCount,
    lastWriteTime,
    lastUpdateTime: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
    idleMinutes: typeof idleMinutes === "string" ? idleMinutes : parseInt(idleMinutes, 10),
    thresholdExceeded: exceeded,
    hardThresholdExceeded: hardReasons.length > 0,
    reasons,
    hardReasons,
    recommendedAction,
    metrics: {
      role,
      model: entry.model ?? null,
      modelProvider: entry.modelProvider ?? null,
      totalTokens: entry.totalTokens ?? -1,
      compactionCount: entry.compactionCount ?? 0,
      softThresholds: { sizeMb: t.softSizeMb, lines: t.softLines },
      hardThresholds: { sizeMb: t.hardSizeMb, lines: t.hardLines },
      checkedAt: now.toISOString(),
    },
  };
}

/**
 * P2-L-C1: buildResumePack
 * Constructs a Resume Pack V1 for the given task, marker, and dispatch request.
 * All 10 required fields as per P2-L-B schema V3.
 */
function buildResumePack(workspaceRoot, opts = {}) {
  const now = new Date().toISOString();
  const targetRole = opts.targetRole ?? "engineering-executive";
  const models = {
    "engineering-executive": { model: "gpt-5.5", provider: "openai-codex" },
    "front-end-executive": { model: "gpt-5.5", provider: "openai-codex" },
    "evolution-curator": { model: "gpt-5.5", provider: "openai-codex" },
  };
  const roleInfo = models[targetRole] ?? models["engineering-executive"];

  const taskId = opts.taskId ?? SMOKE_TASK_ID;
  const phase = opts.phase ?? `P2-L-C1-${now.replace(/[:-]/g, "").slice(0, 15)}`;
  const runId = opts.runId ?? randomUUID();
  const idempotencyKey = opts.idempotencyKey ?? randomUUID();

  return {
    resumePackVersion: "v1",
    generatedAt: now,
    generatedBy: "main",
    targetRole,
    recoveryReason: "session_threshold_exceeded",

    roleIdentity: {
      agentId: targetRole,
      model: roleInfo.model,
      modelProvider: roleInfo.provider,
      description: targetRole === "engineering-executive"
        ? "工程执行岗 — 只读/开发/构建后端和脚本代码"
        : targetRole === "front-end-executive"
          ? "前端执行岗 — 只读/修改/构建前端源码"
          : "自动进化 curator — 状态巡检/扫描/报告",
      forbiddenDomains: targetRole === "engineering-executive"
        ? ["ui/src/ui/", "frontend", "收口", "restart without approval"]
        : targetRole === "front-end-executive"
          ? ["src/gateway/", "src/agents/", "backend", "收口", "restart without approval"]
          : ["build", "restart", "dispatch", "A1"],
      workspaceRoot,
    },

    currentTask: {
      taskId,
      phase,
      runId,
      idempotencyKey,
      summary: opts.taskSummary ?? "validationOnly smoke — session recovery dry-run",
      riskLevel: "L0",
      policyAction: "auto_close",
    },

    lastKnownState: {
      completedSteps: opts.completedSteps ?? ["session_threshold_check", "resume_pack_built"],
      currentBlock: "waiting_for_soft_reset",
      previousRunId: opts.previousRunId ?? null,
      smokeMarkerPhase: phase,
    },

    constraints: {
      forbiddenActions: [
        "edit SRC without approval",
        "exec_build without approval",
        "exec_restart",
        "config_patch",
        "real dispatch",
        "A1",
        "EP-8",
        "EP-9",
      ],
      allowedActions: ["read", "exec_readonly"],
      maxDurationMinutes: 10,
      noSpawn: false,
      noRealDispatch: true,
    },

    workspace: {
      workspaceMain: workspaceRoot,
      tasksPath: "runtime/tasks/tasks.jsonl",
      eventsPath: "runtime/events/events.jsonl",
      returnSink: "system/returns/inbox/",
      dispatchRequestDir: "runtime/dispatch/",
    },

    acceptanceCriteria: {
      requiredOutput: "ROLE_RETURN_PACKAGE_V1",
      mustInclude: ["returnPackageVersion", "returnId", "taskId", "runId", "status", "summary", "filesChanged"],
      returnSink: "system/returns/inbox/",
      stopConditions: [
        "build required without approval",
        "restart required without approval",
        "A1/EP-8/EP-9 detected",
        "config modification detected",
      ],
    },

    returnProtocol: {
      format: "ROLE_RETURN_PACKAGE_V1",
      marker: "ROLE_RETURN_PACKAGE_START / ROLE_RETURN_PACKAGE_END",
      requiredFields: ["returnPackageVersion", "returnId", "taskId", "runId", "idempotencyKey", "phase", "role", "status", "summary", "filesChanged", "buildRequired", "restartRequired"],
    },

    relevantDecisions: [
      "P2-L-B V3: Soft Reset only, no auto fresh session fallback",
      "P2-L-B V3: /new 失败 → SESSION_RESET_FAILED → human gate",
      "Resume Pack 必须包含完整任务上下文，不允许失忆执行",
      "旧 session transcript 保留作为审计证据，不是唯一记忆源",
    ],

    allowedFiles: [
      "src/runtime/runtime-loop.ts",
      "scripts/apply-smoke-runner.mjs",
    ],

    forbiddenFiles: [
      "ui/src/ui/**",
      "openclaw.json",
      ".claw/positions.json",
    ],

    stopConditions: [
      "build 未经批准",
      "restart 未经批准",
      "A1/EP-8/EP-9 被触发",
      "config 被修改",
      "return 无法写入 inbox",
      "task status sync 失败",
    ],
  };
}

/**
 * P2-L-C1: buildSoftResetPlan
 * Generates a dry-run plan showing what WOULD happen during a soft reset.
 * Does NOT actually execute /new. Does NOT dispatch. Does NOT sessions_spawn.
 */
function buildSoftResetPlan(workspaceRoot, sessionKey, resumePack, thresholdResult) {
  const now = new Date().toISOString();
  const planId = `P2-L-C1-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  return {
    planId,
    planVersion: "v1",
    generatedAt: now,
    mode: "DRY_RUN",
    phase: "P2-L-C1",

    // Step 1: Threshold detection
    step1_thresholdCheck: {
      action: "checkSessionThreshold",
      sessionKey,
      sessionId: thresholdResult.sessionId,
      sessionFile: thresholdResult.sessionFile,
      fileSize: thresholdResult.fileSizeDisplay,
      lineCount: thresholdResult.lineCount,
      thresholdExceeded: thresholdResult.thresholdExceeded,
      reasons: thresholdResult.reasons,
      hardReasons: thresholdResult.hardReasons,
      recommendedAction: thresholdResult.recommendedAction,
      idleMinutes: thresholdResult.idleMinutes,
    },

    // Step 2: Resume Pack readiness
    step2_resumePack: {
      action: "buildResumePack",
      ready: Boolean(resumePack),
      schema: "resumePackVersion:v1",
      taskId: resumePack?.currentTask?.taskId ?? null,
      phase: resumePack?.currentTask?.phase ?? null,
      runId: resumePack?.currentTask?.runId ?? null,
      fieldCount: resumePack ? Object.keys(resumePack).length : 0,
      requiredFieldsPresent: resumePack ? [
        "resumePackVersion", "generatedAt", "targetRole", "roleIdentity",
        "currentTask", "lastKnownState", "constraints", "workspace",
        "acceptanceCriteria", "returnProtocol", "relevantDecisions",
        "allowedFiles", "forbiddenFiles", "stopConditions",
      ].every((f) => resumePack[f] !== undefined) : false,
    },

    // Step 3: Soft reset execution plan (dry-run only)
    step3_softResetPlan: {
      action: "executeSoftResetOriginalSession_DRY_RUN",
      sessionKey,
      wouldSendCommand: "/new",
      wouldSendVia: "sessions_send",
      wouldTargetSessionKey: sessionKey,
      wouldWaitForBootstrap: true,
      bootstrapTimeoutMs: 30_000,
      bootstrapSuccessCheck: "sessionEntry.totalTokens === 0",
      actualExecution: false,
      note: "DRY_RUN ONLY — /new NOT sent",
    },

    // Step 4: Resume Pack delivery plan (dry-run only)
    step4_resumeDeliveryPlan: {
      action: "sendResumePackToOriginalSession_DRY_RUN",
      sessionKey,
      wouldSendVia: "sessions_send",
      resumePackSizeBytes: resumePack ? JSON.stringify(resumePack).length : 0,
      actualExecution: false,
      note: "DRY_RUN ONLY — Resume Pack NOT sent",
    },

    // Step 5: Failure path (if /new fails)
    step5_failurePath: {
      action: "SESSION_RESET_FAILED",
      trigger: "/new timeout or error or bootstrap not confirmed",
      behavior: "stop dispatch, stop auto-progression, write events.jsonl + tasks.jsonl, notify main → human gate",
      noAutoFallback: true,
      noFreshSession: true,
      noRecoverySessionKey: true,
    },

    // Constraints verification
    constraints: {
      noFreshSessionCreated: true,
      noRecoverySessionKey: true,
      noOriginalSessionBypass: true,
      sessionKeySame: true,
      noDispatch: true,
      noSessionsSpawn: true,
      noRealNewCommand: true,
      noBuild: true,
      noRestart: true,
      noInboxProcessing: true,
      noContinuousApply: true,
      oldSessionPreserved: true,
    },

    // Summary
    summary: {
      dryRunCompleted: true,
      sessionKey,
      sessionId: thresholdResult.sessionId,
      thresholdExceeded: thresholdResult.thresholdExceeded,
      recommendedAction: thresholdResult.recommendedAction,
      resumePackReady: Boolean(resumePack),
      readyForSoftReset: thresholdResult.thresholdExceeded && Boolean(resumePack),
      readyForReview: true,
    },
  };
}

function isCliEntryPoint() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCliEntryPoint()) {
  try {
    if (process.argv.includes("--sessionRecoveryDryRun") || process.argv.includes("-sessionRecoveryDryRun")) {
      // P2-L-C1: Session Recovery Dry-Run
      const workspaceRoot = DEFAULT_WORKSPACE_ROOT;
      const sessionKey = "agent:engineering-executive:main";

      console.log("═══════════════════════════════════════════════════════════");
      console.log("  P2-L-C1: Session Recovery Dry-Run");
      console.log("═══════════════════════════════════════════════════════════");
      console.log();

      // Step 1: Threshold check
      console.log("[1/3] checkSessionThreshold...");
      const thresholdResult = checkSessionThreshold(workspaceRoot, sessionKey);
      console.log(JSON.stringify(thresholdResult, null, 2));
      console.log();

      // Step 2: Build Resume Pack
      console.log("[2/3] buildResumePack...");
      const resumePack = buildResumePack(workspaceRoot, {
        targetRole: "engineering-executive",
        taskId: SMOKE_TASK_ID,
        taskSummary: "P2-L-C1 dry-run — session recovery readiness check",
      });
      const resumePackPath = path.join(workspaceRoot, "runtime", "main", "tmp", "p2-l-c1-resume-pack-sample.json");
      mkdirSync(path.dirname(resumePackPath), { recursive: true });
      writeFileSync(resumePackPath, JSON.stringify(resumePack, null, 2), "utf8");
      console.log(`  Resume Pack written: ${resumePackPath}`);
      console.log(`  Fields: ${Object.keys(resumePack).length}/10 required`);
      console.log();

      // Step 3: Build soft reset plan
      console.log("[3/3] buildSoftResetPlan...");
      const plan = buildSoftResetPlan(workspaceRoot, sessionKey, resumePack, thresholdResult);
      const planPath = path.join(workspaceRoot, "runtime", "main", "tmp", "p2-l-c1-soft-reset-plan.json");
      writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
      console.log(`  Soft Reset Plan written: ${planPath}`);
      console.log();

      // Inbox/candidates/tasks quick check
      const inboxCount = countJsonFiles(path.join(workspaceRoot, "system/returns/inbox"));
      const candidatesDir = path.join(workspaceRoot, "system/returns/candidates");
      const candidatesCount = existsSync(candidatesDir) ? countJsonFiles(candidatesDir) : 0;
      const tasks = readJsonl(path.join(workspaceRoot, "runtime/tasks/tasks.jsonl"));
      const a1Count = tasks.filter((t) => t.taskId === "A1" && ACTIVE_STATUSES.has(t.status)).length;
      const ep8Count = tasks.filter((t) => t.taskId === "EP-8" && ACTIVE_STATUSES.has(t.status)).length;
      const ep9Count = tasks.filter((t) => t.taskId === "EP-9" && ACTIVE_STATUSES.has(t.status)).length;

      console.log("═══════════════════════════════════════════════════════════");
      console.log("  P2-L-C1 DRY-RUN COMPLETE");
      console.log("═══════════════════════════════════════════════════════════");
      console.log();
      console.log(`  Session Key:     ${sessionKey}`);
      console.log(`  Session ID:      ${thresholdResult.sessionId}`);
      console.log(`  File Size:       ${thresholdResult.fileSizeDisplay}`);
      console.log(`  Line Count:      ${thresholdResult.lineCount}`);
      console.log(`  Threshold Exceeded: ${thresholdResult.thresholdExceeded}`);
      console.log(`  Reasons:         ${thresholdResult.reasons.join(", ") || "none"}`);
      console.log(`  Hard Reasons:    ${thresholdResult.hardReasons.join(", ") || "none"}`);
      console.log(`  Recommended:     ${thresholdResult.recommendedAction}`);
      console.log(`  Resume Pack:     ${Object.keys(resumePack).length}/10 fields, ${(JSON.stringify(resumePack).length / 1024).toFixed(1)}KB`);
      console.log(`  /new sent:       false (DRY RUN)`);
      console.log(`  dispatch:        false`);
      console.log(`  sessions_spawn:  false`);
      console.log(`  inbox:           ${inboxCount}`);
      console.log(`  candidates:      ${candidatesCount}`);
      console.log(`  A1 active:       ${a1Count}`);
      console.log(`  EP-8 active:     ${ep8Count}`);
      console.log(`  EP-9 active:     ${ep9Count}`);
      console.log();
      console.log(`  Report:          ${planPath}`);
      console.log(`  Resume Pack:     ${resumePackPath}`);
    } else if (process.argv.includes("--continuousApply") || process.argv.includes("-continuousApply")) {
      await continuousApplyLoop({ workspaceRoot: DEFAULT_WORKSPACE_ROOT });
    } else if (process.argv.includes("--boundedLoop") || process.argv.includes("-boundedLoop")) {
      await boundedLoop({ workspaceRoot: DEFAULT_WORKSPACE_ROOT, maxTicks: 2 });
    } else {
      await runOnce(DEFAULT_WORKSPACE_ROOT);
    }
    process.exit(0);
  } catch (err) {
    console.error("[apply-smoke-runner] FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
