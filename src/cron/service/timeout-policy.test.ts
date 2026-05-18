import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import {
  AGENT_TURN_SAFETY_TIMEOUT_MS,
  CRON_LANE_BUSY_SKIP_THRESHOLD,
  DEFAULT_JOB_TIMEOUT_MS,
  resolveCronJobTimeoutMs,
  shouldSkipWhenLaneBusy,
} from "./timeout-policy.js";

function makeJob(payload: CronJob["payload"], id = "job-1"): CronJob {
  const sessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
  return {
    id,
    name: "job",
    createdAtMs: 0,
    updatedAtMs: 0,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

describe("timeout-policy", () => {
  it("uses default timeout for non-agent jobs", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "systemEvent", text: "hello" }));
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });

  it("uses expanded safety timeout for agentTurn jobs without explicit timeout", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "agentTurn", message: "hi" }));
    expect(timeout).toBe(AGENT_TURN_SAFETY_TIMEOUT_MS);
  });

  it("disables timeout when timeoutSeconds <= 0", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("applies explicit timeoutSeconds when positive", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 1.9 }),
    );
    expect(timeout).toBe(1_900);
  });

  it("skips low-priority jobs only when the cron lane is busy", () => {
    const lowPriorityJob = makeJob({ kind: "systemEvent", text: "scan" }, "inbox-scan");
    const normalJob = makeJob({ kind: "systemEvent", text: "digest" }, "daily-digest");

    expect(shouldSkipWhenLaneBusy(lowPriorityJob, CRON_LANE_BUSY_SKIP_THRESHOLD - 1)).toBe(false);
    expect(shouldSkipWhenLaneBusy(lowPriorityJob, CRON_LANE_BUSY_SKIP_THRESHOLD)).toBe(true);
    expect(shouldSkipWhenLaneBusy(normalJob, CRON_LANE_BUSY_SKIP_THRESHOLD)).toBe(false);
  });
});
