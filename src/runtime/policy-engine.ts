import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TaskRecord } from "./task-state-machine.js";

const POLICY_RULES_REL = "runtime/policy/policy-rules.json";

export type RiskLevel = "L0" | "L1" | "L2" | "L3";

export type PolicyAction =
  | "auto_close"
  | "auto_defer"
  | "quarantine"
  | "retry"
  | "block_by_policy"
  | "human_gate";

export type PolicyOperator = "eq" | "neq" | "in" | "not_in" | "regex" | "contains";

export interface PolicyCondition {
  field: string;
  operator: PolicyOperator;
  value: unknown;
}

export interface PolicyRule {
  ruleId: string;
  description: string;
  riskLevel: RiskLevel;
  conditions: PolicyCondition[];
  action: PolicyAction;
  reason: string;
  priority: number;
  enabled: boolean;
}

export interface PolicyDecision {
  decisionId: string;
  taskId: string;
  ruleId: string;
  riskLevel: RiskLevel;
  action: PolicyAction;
  reason: string;
  timestamp: string;
  previousStatus: TaskRecord["status"];
  newStatus: TaskRecord["status"];
}

export interface PolicyRulesFile {
  $schema: "policy-rules-v1";
  policyVersion?: string;
  description?: string;
  safetyBoundary?: {
    noAutoExecute?: string[];
    frozenTasks?: string[];
    preservedDeferred?: string[];
  };
  rules: PolicyRule[];
}

const FALLBACK_RULE: PolicyRule = {
  ruleId: "R008-built-in-fallback-human-gate",
  description: "内置回退：未匹配规则进 human-gate",
  riskLevel: "L2",
  conditions: [],
  action: "human_gate",
  reason: "无匹配规则，提交人工审批",
  priority: 0,
  enabled: true,
};

function policyRulesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, POLICY_RULES_REL);
}

function isPolicyRule(value: unknown): value is PolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Partial<PolicyRule>;
  return typeof rule.ruleId === "string"
    && typeof rule.description === "string"
    && ["L0", "L1", "L2", "L3"].includes(String(rule.riskLevel))
    && Array.isArray(rule.conditions)
    && ["auto_close", "auto_defer", "quarantine", "retry", "block_by_policy", "human_gate"].includes(String(rule.action))
    && typeof rule.reason === "string"
    && typeof rule.priority === "number"
    && typeof rule.enabled === "boolean";
}

export function loadPolicyRules(workspaceRoot: string): PolicyRule[] {
  const filePath = policyRulesPath(workspaceRoot);
  if (!existsSync(filePath)) return [FALLBACK_RULE];

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PolicyRulesFile>;
    const rules = Array.isArray(parsed.rules) ? parsed.rules.filter(isPolicyRule) : [];
    return rules.length > 0 ? rules : [FALLBACK_RULE];
  } catch {
    return [FALLBACK_RULE];
  }
}

function getFieldValue(record: Record<string, unknown>, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, record);
}

function asComparableString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  return JSON.stringify(value);
}

function valueMatches(condition: PolicyCondition, actual: unknown): boolean {
  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "not_in":
      return Array.isArray(condition.value) && !condition.value.includes(actual);
    case "regex":
      try {
        return new RegExp(String(condition.value), "u").test(asComparableString(actual).replaceAll("\\", "/"));
      } catch {
        return false;
      }
    case "contains":
      if (Array.isArray(actual)) return actual.includes(condition.value);
      return asComparableString(actual).includes(asComparableString(condition.value));
    default:
      return false;
  }
}

function ruleMatches(task: TaskRecord, rule: PolicyRule): boolean {
  return rule.conditions.every((condition) => valueMatches(condition, getFieldValue(task as unknown as Record<string, unknown>, condition.field)));
}

function statusForAction(action: PolicyAction, previousStatus: TaskRecord["status"]): TaskRecord["status"] {
  switch (action) {
    case "auto_close":
      return "completed";
    case "auto_defer":
      return "deferred";
    case "quarantine":
      return "quarantined";
    case "retry":
      return "queued";
    case "block_by_policy":
    case "human_gate":
      return "blocked_by_policy";
    default:
      return previousStatus;
  }
}

export function evaluatePolicyForTask(task: TaskRecord, rules: PolicyRule[]): PolicyDecision {
  const sortedRules = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => (b.priority - a.priority) || a.ruleId.localeCompare(b.ruleId));
  const matchedRule = sortedRules.find((rule) => ruleMatches(task, rule)) ?? FALLBACK_RULE;
  return {
    decisionId: `policy-${Date.now()}-${task.taskId}-${matchedRule.ruleId}`,
    taskId: task.taskId,
    ruleId: matchedRule.ruleId,
    riskLevel: matchedRule.riskLevel,
    action: matchedRule.action,
    reason: matchedRule.reason,
    timestamp: new Date().toISOString(),
    previousStatus: task.status,
    newStatus: statusForAction(matchedRule.action, task.status),
  };
}

export function evaluatePolicy(workspaceRoot: string, tasks: TaskRecord[]): PolicyDecision[] {
  const rules = loadPolicyRules(workspaceRoot);
  return tasks.map((task) => evaluatePolicyForTask(task, rules));
}
