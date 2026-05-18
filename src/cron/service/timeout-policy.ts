import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 *
 * D-phase: reduced from 10min to 5min for non-agent jobs to prevent
 * embedded timeouts from stacking up and blocking the cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000; // 5 minutes (was 10min)

/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 *
 * D-phase: reduced from 60min to 30min as a tighter safety net.
 */
export const AGENT_TURN_SAFETY_TIMEOUT_MS = 30 * 60_000; // 30 minutes (was 60min)

/**
 * D-phase: threshold for non-critical cron jobs to skip execution when
 * the cron lane already has active tasks. Prevents low-priority jobs
 * from queuing up behind a long-running job and causing lane wait exceeded.
 */
export const CRON_LANE_BUSY_SKIP_THRESHOLD = 2;

/**
 * D-phase: job IDs that are considered low-priority and eligible for
 * skip-when-busy behavior. These jobs are non-urgent housekeeping tasks
 * that can safely be deferred to the next scheduled run.
 */
const SKIP_WHEN_BUSY_JOB_IDS = new Set([
  "inbox-trigger-watchdog",
  "inbox-scan",
  "return-consumer",
]);

/**
 * D-phase: determine whether a cron job should be skipped when the
 * cron lane is already busy with active tasks. Returns true when:
 * - The job is in the low-priority set, AND
 * - The active task count on the cron lane meets or exceeds the threshold.
 */
export function shouldSkipWhenLaneBusy(
  job: CronJob,
  activeCronTaskCount: number,
): boolean {
  if (!SKIP_WHEN_BUSY_JOB_IDS.has(job.id)) {
    return false;
  }
  return activeCronTaskCount >= CRON_LANE_BUSY_SKIP_THRESHOLD;
}

export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const configuredTimeoutMs =
    job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
      ? Math.floor(job.payload.timeoutSeconds * 1_000)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
