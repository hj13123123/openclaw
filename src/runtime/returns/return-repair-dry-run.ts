import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  asNonEmptyString,
  extractReturnPackageIdentity,
  isPlainObject,
  validateRoleReturnPackageV1,
  type RoleReturnPackageV1,
} from "./return-consumer-plan.js";
import { scanReturnDiagnosis, type ReturnCompatibility } from "./return-diagnosis.js";
import { RETURNS_INBOX_RELATIVE_PATH } from "./return-inbox.js";

export type ReturnRepairAction =
  | "set-package-version"
  | "normalize-task"
  | "synthesize-delivery-receipt"
  | "synthesize-return-summary"
  | "synthesize-candidate-eligibility"
  | "preserve-recommended-next-action"
  | "synthesize-recommended-next-action";

export interface ReturnRepairDryRunPlan {
  sourceFile: string;
  returnId: string | null;
  taskId: string | null;
  compatibility: ReturnCompatibility;
  repairable: boolean;
  blockedReasons: string[];
  fieldActions: ReturnRepairAction[];
  remainingValidationErrors: string[];
  proposedPackagePreview: {
    packageId: string | null;
    packageVersion: "1.0";
    taskTicketId: string | null;
    roleId: string | null;
    returnType: string | null;
    recommendedNextAction: string | null;
  } | null;
}

export interface ReturnRepairDryRunResult {
  mode: "observe-only";
  dryRun: true;
  plannedAt: string;
  inboxPath: string;
  totalDiagnosed: number;
  candidateCount: number;
  repairableCount: number;
  blockedCount: number;
  plans: ReturnRepairDryRunPlan[];
  warnings: string[];
  constraintsVerified: {
    readOnly: "yes";
    returnWritten: "no";
    originalReturnMutated: "no";
    archived: "no";
    receiptWritten: "no";
    consumerTriggered: "no";
    applied: "no";
  };
}

export interface ReturnRepairPackagePreviewResult {
  mode: "observe-only";
  dryRun: true;
  plannedAt: string;
  inboxPath: string;
  sourceFile: string;
  returnId: string | null;
  taskId: string | null;
  compatibility: ReturnCompatibility | null;
  repairable: boolean;
  blockedReasons: string[];
  fieldActions: ReturnRepairAction[];
  remainingValidationErrors: string[];
  proposedPackage: RoleReturnPackageV1 | null;
  constraintsVerified: {
    readOnly: "yes";
    returnWritten: "no";
    originalReturnMutated: "no";
    archived: "no";
    receiptWritten: "no";
    consumerTriggered: "no";
    applied: "no";
  };
}

export interface ReturnRepairDryRunOptions {
  plannedAt?: string;
  limit?: number;
}

function readReturnPackage(
  workspaceRoot: string,
  sourceFile: string,
): Record<string, unknown> | null {
  const filePath = path.join(workspaceRoot, RETURNS_INBOX_RELATIVE_PATH, sourceFile);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nestedString(record: Record<string, unknown>, dottedPath: string): string | null {
  let current: unknown = record;
  for (const segment of dottedPath.split(".")) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return asNonEmptyString(current) ?? null;
}

function safeSegment(value: string | null): string {
  return (value ?? "unknown")
    .replace(/[^a-z0-9_.-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function normalizeReturnType(value: unknown): string {
  const raw = asNonEmptyString(value);
  return raw && ["completion", "inspection", "partial", "failure"].includes(raw)
    ? raw
    : "completion";
}

function normalizedStatus(record: Record<string, unknown>): string {
  const raw = asNonEmptyString(record.status)?.toLowerCase();
  if (raw === "pass" || raw === "passed" || raw === "complete") return "completed";
  return raw ?? "completed";
}

function summaryText(record: Record<string, unknown>, sourceFile: string): string {
  return (
    nestedString(record, "deliveryReceipt.summary") ??
    nestedString(record, "returnSummary.notesForMain") ??
    nestedString(record, "outcome.summary") ??
    nestedString(record, "result.summary") ??
    `Dry-run repaired return package from ${sourceFile}.`
  );
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function buildProposedPackage(params: {
  sourceFile: string;
  record: Record<string, unknown>;
  taskId: string;
  plannedAt: string;
  fieldActions: ReturnRepairAction[];
}): RoleReturnPackageV1 {
  const record = params.record;
  const identity = extractReturnPackageIdentity(record);
  const role = objectOrNull(record.role) ?? {};
  const roleId = asNonEmptyString(role.roleId) ?? asNonEmptyString(record.roleId) ?? "unknown-role";
  const roleType = asNonEmptyString(role.roleType) ?? "executor";
  const task = objectOrNull(record.task) ?? {};
  const deliveryReceipt = objectOrNull(record.deliveryReceipt);
  const returnSummary = objectOrNull(record.returnSummary);
  const candidateEligibility = objectOrNull(record.candidateEligibility);
  const recommendedNextAction = objectOrNull(record.recommendedNextAction);
  const summary = summaryText(record, params.sourceFile);

  if (asNonEmptyString(record.packageVersion) !== "1.0") {
    params.fieldActions.push("set-package-version");
  }
  if (!asNonEmptyString(task.ticketId)) {
    params.fieldActions.push("normalize-task");
  }
  if (!deliveryReceipt) params.fieldActions.push("synthesize-delivery-receipt");
  if (!returnSummary) params.fieldActions.push("synthesize-return-summary");
  if (!candidateEligibility) params.fieldActions.push("synthesize-candidate-eligibility");
  params.fieldActions.push(
    recommendedNextAction
      ? "preserve-recommended-next-action"
      : "synthesize-recommended-next-action",
  );

  return {
    ...record,
    packageId:
      identity.returnId ??
      `return-repair-${safeSegment(params.taskId)}-${safeSegment(params.plannedAt)}`,
    packageVersion: "1.0",
    returnType: normalizeReturnType(record.returnType),
    producedAt: asNonEmptyString(record.producedAt) ?? params.plannedAt,
    role: {
      ...role,
      roleId,
      roleType,
    },
    task: {
      ...task,
      ticketId: params.taskId,
      taskTitle:
        asNonEmptyString(task.taskTitle) ??
        asNonEmptyString(task.title) ??
        asNonEmptyString(record.taskTitle) ??
        params.taskId,
    },
    deliveryReceipt:
      deliveryReceipt ??
      ({
        receiptId: `dry-run-delivery-${safeSegment(params.taskId)}-${safeSegment(
          params.plannedAt,
        )}`,
        deliveryStatus: "delivered",
        summary,
      } satisfies Record<string, unknown>),
    returnSummary:
      returnSummary ??
      ({
        status: normalizedStatus(record),
        taskCompleted: ["pass", "passed", "completed"].includes(
          asNonEmptyString(record.status)?.toLowerCase() ?? "",
        ),
        notesForMain: summary,
      } satisfies Record<string, unknown>),
    candidateEligibility:
      candidateEligibility ??
      ({
        eligible: false,
        source: "return-repair-dry-run",
        humanGateRequired: true,
      } satisfies Record<string, unknown>),
    recommendedNextAction:
      recommendedNextAction ??
      ({
        action: "manual-review",
        target: "main",
        description: "Review dry-run repaired return package before any apply step.",
      } satisfies Record<string, unknown>),
  };
}

function previewPackage(
  pkg: RoleReturnPackageV1,
): ReturnRepairDryRunPlan["proposedPackagePreview"] {
  const role = objectOrNull(pkg.role);
  const task = objectOrNull(pkg.task);
  const action = objectOrNull(pkg.recommendedNextAction);
  return {
    packageId: asNonEmptyString(pkg.packageId) ?? null,
    packageVersion: "1.0",
    taskTicketId: task ? (asNonEmptyString(task.ticketId) ?? null) : null,
    roleId: role ? (asNonEmptyString(role.roleId) ?? null) : null,
    returnType: asNonEmptyString(pkg.returnType) ?? null,
    recommendedNextAction: action ? (asNonEmptyString(action.action) ?? null) : null,
  };
}

function materializeRepair(params: {
  workspaceRoot: string;
  sourceFile: string;
  returnId: string | null;
  taskId: string | null;
  compatibility: ReturnCompatibility;
  plannedAt: string;
}): { plan: ReturnRepairDryRunPlan; proposedPackage: RoleReturnPackageV1 | null } {
  const record = readReturnPackage(params.workspaceRoot, params.sourceFile);
  const blockedReasons: string[] = [];
  const fieldActions: ReturnRepairAction[] = [];
  if (!record) blockedReasons.push("return_package_unreadable");
  if (!params.taskId) blockedReasons.push("task_id_missing");
  if (params.compatibility !== "v2-shaped" && params.compatibility !== "legacy-flat") {
    blockedReasons.push("compatibility_not_repair_candidate");
  }

  if (!record || !params.taskId || blockedReasons.length > 0) {
    return {
      plan: {
        sourceFile: params.sourceFile,
        returnId: params.returnId,
        taskId: params.taskId,
        compatibility: params.compatibility,
        repairable: false,
        blockedReasons,
        fieldActions,
        remainingValidationErrors: [],
        proposedPackagePreview: null,
      },
      proposedPackage: null,
    };
  }

  const proposedPackage = buildProposedPackage({
    sourceFile: params.sourceFile,
    record,
    taskId: params.taskId,
    plannedAt: params.plannedAt,
    fieldActions,
  });
  const remainingValidationErrors = validateRoleReturnPackageV1(proposedPackage);
  return {
    plan: {
      sourceFile: params.sourceFile,
      returnId: params.returnId,
      taskId: params.taskId,
      compatibility: params.compatibility,
      repairable: remainingValidationErrors.length === 0,
      blockedReasons: remainingValidationErrors.length === 0 ? [] : ["proposed_package_invalid"],
      fieldActions,
      remainingValidationErrors,
      proposedPackagePreview: previewPackage(proposedPackage),
    },
    proposedPackage,
  };
}

function constraints(): ReturnRepairPackagePreviewResult["constraintsVerified"] {
  return {
    readOnly: "yes",
    returnWritten: "no",
    originalReturnMutated: "no",
    archived: "no",
    receiptWritten: "no",
    consumerTriggered: "no",
    applied: "no",
  };
}

export function buildReturnRepairPackagePreview(
  workspaceRoot: string,
  sourceFile: string,
  options: { plannedAt?: string } = {},
): ReturnRepairPackagePreviewResult {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const diagnosis = scanReturnDiagnosis(workspaceRoot, {
    scannedAt: plannedAt,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const item = diagnosis.items.find((candidate) => candidate.sourceFile === sourceFile);
  if (!item) {
    return {
      mode: "observe-only",
      dryRun: true,
      plannedAt,
      inboxPath: RETURNS_INBOX_RELATIVE_PATH,
      sourceFile,
      returnId: null,
      taskId: null,
      compatibility: null,
      repairable: false,
      blockedReasons: ["diagnosis_item_missing"],
      fieldActions: [],
      remainingValidationErrors: [],
      proposedPackage: null,
      constraintsVerified: constraints(),
    };
  }

  const materialized = materializeRepair({
    workspaceRoot,
    sourceFile: item.sourceFile,
    returnId: item.returnId,
    taskId: item.taskId,
    compatibility: item.compatibility,
    plannedAt,
  });
  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    inboxPath: RETURNS_INBOX_RELATIVE_PATH,
    sourceFile: item.sourceFile,
    returnId: item.returnId,
    taskId: item.taskId,
    compatibility: item.compatibility,
    repairable: materialized.plan.repairable,
    blockedReasons: materialized.plan.blockedReasons,
    fieldActions: materialized.plan.fieldActions,
    remainingValidationErrors: materialized.plan.remainingValidationErrors,
    proposedPackage: materialized.proposedPackage,
    constraintsVerified: constraints(),
  };
}

export function buildReturnRepairDryRun(
  workspaceRoot: string,
  options: ReturnRepairDryRunOptions = {},
): ReturnRepairDryRunResult {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const diagnosis = scanReturnDiagnosis(workspaceRoot, {
    scannedAt: plannedAt,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const candidateItems = diagnosis.items.filter(
    (item) => item.suggestedAction === "repair-to-v1-dry-run",
  );
  const plans = candidateItems.map(
    (item) =>
      materializeRepair({
        workspaceRoot,
        sourceFile: item.sourceFile,
        returnId: item.returnId,
        taskId: item.taskId,
        compatibility: item.compatibility,
        plannedAt,
      }).plan,
  );

  return {
    mode: "observe-only",
    dryRun: true,
    plannedAt,
    inboxPath: RETURNS_INBOX_RELATIVE_PATH,
    totalDiagnosed: diagnosis.totalCount,
    candidateCount: candidateItems.length,
    repairableCount: plans.filter((plan) => plan.repairable).length,
    blockedCount: plans.filter((plan) => !plan.repairable).length,
    plans: plans.slice(0, limit),
    warnings: diagnosis.warnings,
    constraintsVerified: {
      readOnly: "yes",
      returnWritten: "no",
      originalReturnMutated: "no",
      archived: "no",
      receiptWritten: "no",
      consumerTriggered: "no",
      applied: "no",
    },
  };
}
