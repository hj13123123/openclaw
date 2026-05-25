import { describe, expect, it } from "vitest";
import { classifyLeaseTaskType, planLeaseHumanGate } from "./lease-human-gate-plan.js";

describe("lease human-gate plan", () => {
  it("classifies explicit, tag, and task id task types", () => {
    expect(classifyLeaseTaskType({ taskType: "realTask" })).toEqual({
      taskType: "realTask",
      source: "taskMetadata.taskType",
      priority: 1,
    });
    expect(classifyLeaseTaskType({ tags: ["validation_only"] })).toEqual({
      taskType: "validationOnly",
      source: "tags[]",
      priority: 2,
    });
    expect(classifyLeaseTaskType({ taskId: "TASK-SMOKE-A" })).toEqual({
      taskType: "smoke",
      source: "taskId pattern",
      priority: 3,
    });
  });

  it("maps active leases to no action", () => {
    const plan = planLeaseHumanGate({
      lease: { leaseVerdict: "LEASE_ACTIVE" },
      taskMetadata: { taskType: "realTask" },
    });

    expect(plan).toEqual(
      expect.objectContaining({
        mode: "dry-run",
        action: "no_action",
        candidateType: null,
        humanGateRequired: false,
        ruleNumber: 1,
      }),
    );
    expect(plan.constraintsVerified.humanGateCandidateWritten).toBe("no");
  });

  it("maps stalled real tasks to dry-run human-gate candidates", () => {
    const plan = planLeaseHumanGate({
      lease: { leaseVerdict: "EXECUTION_STALLED" },
      taskMetadata: { taskType: "realTask" },
    });

    expect(plan).toEqual(
      expect.objectContaining({
        action: "create_dry_run_candidate",
        candidateType: "execution_stalled",
        humanGateRequired: true,
        ruleNumber: 2,
      }),
    );
    expect(plan.recommendedActions).toContain("HUMAN_GATE_REQUIRED");
  });

  it("keeps validation and smoke stalls as observations", () => {
    expect(
      planLeaseHumanGate({
        lease: { leaseVerdict: "EXECUTION_STALLED" },
        taskMetadata: { taskType: "validationOnly" },
      }),
    ).toEqual(
      expect.objectContaining({
        action: "log_observation",
        candidateType: null,
        humanGateRequired: false,
        ruleNumber: 3,
      }),
    );
    expect(
      planLeaseHumanGate({
        lease: { leaseVerdict: "HARD_STOP" },
        taskMetadata: { taskType: "smoke" },
      }),
    ).toEqual(
      expect.objectContaining({
        action: "log_observation",
        humanGateRequired: false,
        ruleNumber: 7,
      }),
    );
  });

  it("fails closed for unknown task types without writing candidates", () => {
    const plan = planLeaseHumanGate({
      lease: { leaseVerdict: "HARD_STOP" },
      taskMetadata: { taskId: "TASK-A" },
    });

    expect(plan).toEqual(
      expect.objectContaining({
        action: "create_dry_run_candidate",
        taskType: "unknown",
        candidateType: "execution_hard_stop",
        humanGateRequired: true,
        ruleNumber: 8,
      }),
    );
    expect(plan.constraintsVerified).toEqual({
      readOnly: "yes",
      humanGateCandidateWritten: "no",
      observationWritten: "no",
      sessionKilled: "no",
      sessionRestarted: "no",
      autoRecoveryTriggered: "no",
      applied: "no",
    });
  });
});
