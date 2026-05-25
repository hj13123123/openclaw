import type { IncomingMessage, ServerResponse } from "node:http";
import {
  evaluateExecutionLease,
  type ExecutionLeaseConfig,
  type ExecutionLeaseTaskMetadata,
} from "../runtime/leases/execution-lease.js";
import {
  planLeaseHumanGate,
  type LeaseHumanGateTaskMetadata,
} from "../runtime/leases/lease-human-gate-plan.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";

const EXECUTION_LEASE_EVALUATE_ROUTE = "/api/execution-lease/evaluate";
const MAX_EXECUTION_LEASE_BODY_BYTES = 1_000_000;

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function taskMetadata(
  value: unknown,
): (ExecutionLeaseTaskMetadata & LeaseHumanGateTaskMetadata) | null {
  return isRecord(value)
    ? (value as ExecutionLeaseTaskMetadata & LeaseHumanGateTaskMetadata)
    : null;
}

function config(value: unknown): ExecutionLeaseConfig | undefined {
  return isRecord(value) ? (value as ExecutionLeaseConfig) : undefined;
}

export function isExecutionLeaseApiPath(pathname: string): boolean {
  return pathname === EXECUTION_LEASE_EVALUATE_ROUTE;
}

export async function handleExecutionLeaseHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (!isExecutionLeaseApiPath(requestPath)) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_EXECUTION_LEASE_BODY_BYTES);
  if (body === undefined) return true;
  if (!isRecord(body)) {
    sendJson(res, 400, { ok: false, error: "request body must be a JSON object" });
    return true;
  }

  const transcriptLines = stringArray(body.transcriptLines);
  const metadata = taskMetadata(body.taskMetadata);
  if (!transcriptLines || !metadata) {
    sendJson(res, 400, {
      ok: false,
      error: "transcriptLines string[] and taskMetadata object are required",
    });
    return true;
  }

  const lease = evaluateExecutionLease({
    transcriptLines,
    taskMetadata: metadata,
    config: config(body.config),
    now: typeof body.now === "string" ? body.now : undefined,
  });
  const includePlan = body.includePlan !== false;
  sendJson(res, 200, {
    ok: true,
    mode: "dry-run",
    data: {
      lease,
      humanGatePlan: includePlan
        ? planLeaseHumanGate({
            lease,
            taskMetadata: metadata,
          })
        : null,
    },
    constraintsVerified: {
      readOnly: "yes",
      localFileRead: "no",
      humanGateCandidateWritten: "no",
      sessionKilled: "no",
      sessionRestarted: "no",
      autoRecoveryTriggered: "no",
      applied: "no",
    },
  });
  return true;
}
