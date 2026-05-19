import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearBlockedInterruptState,
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
  isCandidateExpired,
  readCurrentInterruptState,
  updateCheckpointInterruptState,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });

  it("writes, reads, expires, and clears interrupt checkpoint state", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-"));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await updateCheckpointInterruptState({
      workspaceDir,
      interruptState: {
        status: "blocked",
        candidateId: "candidate-1",
        expiresAt,
      },
      humanGate: {
        required: true,
        gateStatus: "pending",
      },
      pendingWrites: [{ path: "example" }],
      rollbackHint: { action: "clear" },
    });

    const current = await readCurrentInterruptState(workspaceDir);
    expect(current?.interruptState).toMatchObject({
      status: "blocked",
      candidateId: "candidate-1",
      expiresAt,
    });
    expect(current?.humanGate).toMatchObject({
      required: true,
      gateStatus: "pending",
    });
    expect(isCandidateExpired({ expiresAt })).toBe(false);
    expect(isCandidateExpired({ expiresAt: "not-a-date" })).toBe(true);

    await clearBlockedInterruptState(workspaceDir);

    const cleared = await readCurrentInterruptState(workspaceDir);
    expect(cleared).toEqual({
      interruptState: null,
      humanGate: null,
    });
    const raw = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "continuity_checkpoint.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.pendingWrites).toBeUndefined();
    expect(raw.rollbackHint).toBeUndefined();
  });
});
