import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateExecutionLease, evaluateExecutionLeaseFromFiles } from "./execution-lease.js";

function line(timestamp: string, role: string, content: string): string {
  return JSON.stringify({
    type: "message",
    timestamp,
    message: {
      role,
      content,
    },
  });
}

describe("execution lease evaluator", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-execution-lease-"));
    roots.push(root);
    return root;
  }

  it("keeps the lease active when progress signals are recent", () => {
    const result = evaluateExecutionLease({
      now: "2026-05-26T00:05:00.000Z",
      taskMetadata: { taskId: "TASK-A", phase: "D7", runId: "run-a" },
      transcriptLines: [
        line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A"),
        line("2026-05-26T00:04:30.000Z", "assistant", "working"),
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        leaseVerdict: "LEASE_ACTIVE",
        task: { taskId: "TASK-A", phase: "D7", runId: "run-a" },
        constraintsVerified: {
          readOnly: "yes",
          humanGateCandidateWritten: "no",
          sessionKilled: "no",
          sessionRestarted: "no",
          autoRecoveryTriggered: "no",
          applied: "no",
        },
      }),
    );
    expect(result.evidence.progressSignals).toEqual(["assistant"]);
  });

  it("fails closed to stalled when dispatch has no progress past timeout", () => {
    const result = evaluateExecutionLease({
      now: "2026-05-26T00:07:00.000Z",
      taskMetadata: { taskId: "TASK-A" },
      config: { noProgressTimeoutSec: 300, hardStopSec: 1800 },
      transcriptLines: [line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A")],
    });

    expect(result.leaseVerdict).toBe("EXECUTION_STALLED");
    expect(result.evidence.noProgressExpired).toBe(true);
    expect(result.evidence.hardStopReached).toBe(false);
  });

  it("escalates to hard stop after the hard timeout", () => {
    const result = evaluateExecutionLease({
      now: "2026-05-26T00:35:00.000Z",
      taskMetadata: { taskId: "TASK-A" },
      transcriptLines: [
        line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A"),
        line("2026-05-26T00:01:00.000Z", "assistant", "started"),
      ],
    });

    expect(result.leaseVerdict).toBe("HARD_STOP");
    expect(result.evidence.hardStopReached).toBe(true);
  });

  it("treats a return package as active completion evidence", () => {
    const result = evaluateExecutionLease({
      now: "2026-05-26T01:00:00.000Z",
      taskMetadata: { taskId: "TASK-A" },
      transcriptLines: [
        line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A"),
        line("2026-05-26T00:01:00.000Z", "assistant", "ROLE_RETURN_PACKAGE_START"),
      ],
    });

    expect(result.leaseVerdict).toBe("LEASE_ACTIVE");
    expect(result.evidence.roleReturnPackageDetected).toBe(true);
    expect(result.evidence.progressSignals).toEqual(["assistant", "ROLE_RETURN_PACKAGE"]);
  });

  it("reads transcript, task metadata, and config files without writing", () => {
    const root = workspace();
    const transcriptPath = path.join(root, "session.jsonl");
    const taskMetadataPath = path.join(root, "task.json");
    const configPath = path.join(root, "lease-config.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      transcriptPath,
      `${line("2026-05-26T00:00:00.000Z", "user", "dispatch TASK-A")}\n`,
      "utf8",
    );
    writeFileSync(taskMetadataPath, JSON.stringify({ taskId: "TASK-A" }), "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({ noProgressTimeoutSec: 60, hardStopSec: 120 }),
      "utf8",
    );

    const result = evaluateExecutionLeaseFromFiles({
      transcriptPath,
      taskMetadataPath,
      configPath,
      now: "2026-05-26T00:03:00.000Z",
    });

    expect(result.leaseVerdict).toBe("HARD_STOP");
    expect(result.source.totalLines).toBe(1);
    expect(result.constraintsVerified.applied).toBe("no");
  });
});
