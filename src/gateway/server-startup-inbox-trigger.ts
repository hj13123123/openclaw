// Gateway startup hook: ensure Inbox Trigger Service V1 is running
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

interface AutostartReport {
  autostartId: string;
  at: string;
  markerEnabled: boolean;
  serviceProcessAlive: boolean;
  serviceEnabled: boolean;
  actionTaken: "skipped_already_running" | "skipped_disabled" | "ensured" | "error";
  error?: string;
}

export async function ensureInboxTriggerService(params: {
  workspaceRoot: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  startInboxTriggerServiceDeferred(params);
}

export function startInboxTriggerServiceDeferred(params: {
  workspaceRoot: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  delayMs?: number;
}) {
  const delayMs = Math.max(0, params.delayMs ?? 1_000);
  const timer = setTimeout(() => {
    void ensureInboxTriggerServiceNow(params).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      params.log.warn(`[inbox-trigger] deferred autostart failed: ${message}`);
    });
  }, delayMs);
  timer.unref?.();
}

async function ensureInboxTriggerServiceNow(params: {
  workspaceRoot: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const { workspaceRoot, log } = params;
  const tmpDir = path.join(workspaceRoot, "runtime", "main", "tmp");
  const marker = readAutostartMarker(tmpDir);

  if (!marker.enabled) {
    log.info("[inbox-trigger] autostart marker disabled, respecting stop");
    writeReport(tmpDir, {
      markerEnabled: false,
      serviceProcessAlive: false,
      serviceEnabled: false,
      actionTaken: "skipped_disabled",
    });
    return;
  }

  const controllerPath = path.join(workspaceRoot, "evolution", "inbox-trigger-controller.ps1");
  const psBaseArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", controllerPath];

  try {
    const statusResult = await execFileP("powershell", [...psBaseArgs, "-Action", "status"], { timeout: 10_000 });
    const status = JSON.parse(statusResult.stdout) as { processAlive?: boolean; enabled?: boolean; pid?: number };

    if (status.processAlive) {
      log.info(`[inbox-trigger] service already running (pid=${status.pid ?? "unknown"})`);
      writeReport(tmpDir, {
        markerEnabled: true,
        serviceProcessAlive: true,
        serviceEnabled: status.enabled !== false,
        actionTaken: "skipped_already_running",
      });
      return;
    }

    if (status.enabled === false) {
      log.info("[inbox-trigger] service disabled, respecting stop (enabled=false)");
      writeReport(tmpDir, {
        markerEnabled: true,
        serviceProcessAlive: false,
        serviceEnabled: false,
        actionTaken: "skipped_disabled",
      });
      return;
    }

    log.info("[inbox-trigger] starting service via ensure...");
    await execFileP("powershell", [...psBaseArgs, "-Action", "ensure"], { timeout: 15_000 });
    log.info("[inbox-trigger] service ensured");
    writeReport(tmpDir, {
      markerEnabled: true,
      serviceProcessAlive: false,
      serviceEnabled: true,
      actionTaken: "ensured",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[inbox-trigger] autostart failed: ${message}`);
    writeReport(tmpDir, {
      markerEnabled: true,
      serviceProcessAlive: false,
      serviceEnabled: true,
      actionTaken: "error",
      error: message,
    });
  }
}

function readAutostartMarker(tmpDir: string): { enabled: boolean } {
  try {
    const markerPath = path.join(tmpDir, "inbox-trigger-autostart-enabled.json");
    if (!fs.existsSync(markerPath)) {
      return { enabled: true };
    }
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as { enabled?: unknown };
    return { enabled: parsed.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

function writeReport(tmpDir: string, partial: Omit<AutostartReport, "autostartId" | "at">) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const report: AutostartReport = {
      autostartId: `inbox-trigger-autostart-${stamp}`,
      at: new Date().toISOString(),
      ...partial,
    };
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, `inbox-trigger-autostart-${stamp}.json`),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  } catch {
    // fail-soft: reporting must never block gateway startup
  }
}
