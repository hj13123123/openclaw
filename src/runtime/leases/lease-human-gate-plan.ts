import type { ExecutionLeaseEvaluation, ExecutionLeaseVerdict } from "./execution-lease.js";

export type LeaseTaskType = "validationOnly" | "smoke" | "realTask" | "unknown";
export type LeaseHumanGateAction = "no_action" | "log_observation" | "create_dry_run_candidate";

export interface LeaseHumanGateTaskMetadata {
  taskId?: string;
  taskType?: string;
  tags?: unknown;
  phase?: string;
  runId?: string;
  sessionKey?: string;
}

export interface LeaseHumanGatePlan {
  mode: "dry-run";
  action: LeaseHumanGateAction;
  leaseVerdict: ExecutionLeaseVerdict;
  taskType: LeaseTaskType;
  classificationSource: string;
  classificationPriority: number;
  ruleNumber: number;
  candidateType: "execution_stalled" | "execution_hard_stop" | null;
  humanGateRequired: boolean;
  recommendedActions: string[];
  forbiddenActions: string[];
  constraintsVerified: {
    readOnly: "yes";
    humanGateCandidateWritten: "no";
    observationWritten: "no";
    sessionKilled: "no";
    sessionRestarted: "no";
    autoRecoveryTriggered: "no";
    applied: "no";
  };
}

const EXPLICIT_TASK_TYPES = new Set<LeaseTaskType>([
  "validationOnly",
  "smoke",
  "realTask",
  "unknown",
]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function classifyLeaseTaskType(taskMetadata: LeaseHumanGateTaskMetadata): {
  taskType: LeaseTaskType;
  source: string;
  priority: number;
} {
  const explicitType = stringValue(taskMetadata.taskType);
  if (explicitType && EXPLICIT_TASK_TYPES.has(explicitType as LeaseTaskType)) {
    return {
      taskType: explicitType as LeaseTaskType,
      source: "taskMetadata.taskType",
      priority: 1,
    };
  }

  for (const tag of tags(taskMetadata.tags)) {
    if (/validation_only|^validation$/iu.test(tag)) {
      return { taskType: "validationOnly", source: "tags[]", priority: 2 };
    }
    if (/smoke/iu.test(tag)) {
      return { taskType: "smoke", source: "tags[]", priority: 2 };
    }
  }

  const taskId = stringValue(taskMetadata.taskId) ?? "";
  if (/DRYRUN|Validation|validation_only/iu.test(taskId)) {
    return { taskType: "validationOnly", source: "taskId pattern", priority: 3 };
  }
  if (/Smoke|SMOKE/u.test(taskId)) {
    return { taskType: "smoke", source: "taskId pattern", priority: 3 };
  }

  return { taskType: "unknown", source: "fallback", priority: 4 };
}

function mappingRule(
  leaseVerdict: ExecutionLeaseVerdict,
  taskType: LeaseTaskType,
): {
  ruleNumber: number;
  action: LeaseHumanGateAction;
  candidateType: LeaseHumanGatePlan["candidateType"];
  humanGateRequired: boolean;
} {
  if (leaseVerdict === "LEASE_ACTIVE") {
    return {
      ruleNumber: 1,
      action: "no_action",
      candidateType: null,
      humanGateRequired: false,
    };
  }

  if (taskType === "unknown") {
    return {
      ruleNumber: 8,
      action: "create_dry_run_candidate",
      candidateType: leaseVerdict === "HARD_STOP" ? "execution_hard_stop" : "execution_stalled",
      humanGateRequired: true,
    };
  }

  if (leaseVerdict === "EXECUTION_STALLED" && taskType === "realTask") {
    return {
      ruleNumber: 2,
      action: "create_dry_run_candidate",
      candidateType: "execution_stalled",
      humanGateRequired: true,
    };
  }

  if (leaseVerdict === "HARD_STOP" && taskType === "realTask") {
    return {
      ruleNumber: 5,
      action: "create_dry_run_candidate",
      candidateType: "execution_hard_stop",
      humanGateRequired: true,
    };
  }

  return {
    ruleNumber:
      leaseVerdict === "EXECUTION_STALLED"
        ? taskType === "validationOnly"
          ? 3
          : 4
        : taskType === "validationOnly"
          ? 6
          : 7,
    action: "log_observation",
    candidateType: null,
    humanGateRequired: false,
  };
}

function recommendedActions(
  leaseVerdict: ExecutionLeaseVerdict,
  action: LeaseHumanGateAction,
): string[] {
  if (action === "no_action") return ["no human action required"];
  if (action === "log_observation") return ["log observation only", "no recovery action required"];
  return leaseVerdict === "HARD_STOP"
    ? ["HUMAN_GATE_REQUIRED", "option_kill", "option_fresh_session", "option_delegate"]
    : ["HUMAN_GATE_REQUIRED", "option_wait", "option_retry", "option_kill", "option_delegate"];
}

function forbiddenActions(action: LeaseHumanGateAction): string[] {
  return action === "no_action"
    ? ["no auto recovery"]
    : ["no auto retry", "no auto respawn", "no auto kill", "no continuous apply"];
}

export function planLeaseHumanGate(params: {
  lease: Pick<ExecutionLeaseEvaluation, "leaseVerdict">;
  taskMetadata: LeaseHumanGateTaskMetadata;
}): LeaseHumanGatePlan {
  const classification = classifyLeaseTaskType(params.taskMetadata);
  const rule = mappingRule(params.lease.leaseVerdict, classification.taskType);
  return {
    mode: "dry-run",
    action: rule.action,
    leaseVerdict: params.lease.leaseVerdict,
    taskType: classification.taskType,
    classificationSource: classification.source,
    classificationPriority: classification.priority,
    ruleNumber: rule.ruleNumber,
    candidateType: rule.candidateType,
    humanGateRequired: rule.humanGateRequired,
    recommendedActions: recommendedActions(params.lease.leaseVerdict, rule.action),
    forbiddenActions: forbiddenActions(rule.action),
    constraintsVerified: {
      readOnly: "yes",
      humanGateCandidateWritten: "no",
      observationWritten: "no",
      sessionKilled: "no",
      sessionRestarted: "no",
      autoRecoveryTriggered: "no",
      applied: "no",
    },
  };
}
