import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RETURNS_INBOX_RELATIVE_PATH } from "./return-inbox.js";

export type RoleReturnPackageV1 = {
  packageId?: unknown;
  packageVersion?: unknown;
  role?: unknown;
  returnType?: unknown;
  producedAt?: unknown;
  task?: unknown;
  deliveryReceipt?: unknown;
  returnSummary?: unknown;
  candidateEligibility?: unknown;
  recommendedNextAction?: unknown;
  roleReturnPackageId?: unknown;
  roleId?: unknown;
  taskId?: unknown;
  runId?: unknown;
  status?: unknown;
  verificationChecklist?: unknown;
  buildResult?: unknown;
  [key: string]: unknown;
};

export type ReturnConsumerPlan =
  | {
      status: "process";
      sourceFile: string;
      returnId: string;
      taskId: string;
      actionRequired: boolean;
    }
  | {
      status: "skip";
      sourceFile: string;
      returnId?: string;
      taskId?: string;
      reason: "legacy-p2-p-skipped" | "schema-invalid" | "receipt-exists" | "processed-file-exists";
      validationErrors?: string[];
    };

export type ReturnConsumerPlanScanItem =
  | ReturnConsumerPlan
  | {
      status: "skip";
      sourceFile: string;
      reason: "json-parse-failed";
      error: string;
    };

export interface ReturnConsumerPlanScanResult {
  mode: "observe-only";
  scannedAt: string;
  inboxPath: string;
  processedPath: string;
  totalCount: number;
  processCount: number;
  skipCount: number;
  byReason: Array<{ reason: string; count: number }>;
  plans: ReturnConsumerPlanScanItem[];
  warnings: string[];
  constraintsVerified: {
    consumed: "no";
    archived: "no";
    receiptWritten: "no";
    taskGraphMutated: "no";
    applied: "no";
  };
}

export interface ReturnConsumerPlanScanOptions {
  scannedAt?: string;
  limit?: number;
}

const RETURNS_PROCESSED_RELATIVE_PATH = "system/returns/processed";

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractReturnPackageIdentity(pkg: RoleReturnPackageV1): {
  returnId?: string;
  taskId?: string;
} {
  const returnId = asNonEmptyString(pkg.packageId) ?? asNonEmptyString(pkg.roleReturnPackageId);
  const taskId = isPlainObject(pkg.task)
    ? asNonEmptyString(pkg.task.ticketId)
    : asNonEmptyString(pkg.taskId);
  return { returnId, taskId };
}

export function validateRoleReturnPackageV1(pkg: RoleReturnPackageV1): string[] {
  const errors: string[] = [];

  for (const field of ["packageId", "packageVersion", "returnType", "producedAt"] as const) {
    if (!asNonEmptyString(pkg[field])) errors.push(field);
  }

  if (asNonEmptyString(pkg.packageVersion) !== "1.0") {
    errors.push("packageVersion.const:1.0");
  }

  const validReturnTypes = new Set(["completion", "inspection", "partial", "failure"]);
  const returnType = asNonEmptyString(pkg.returnType);
  if (returnType && !validReturnTypes.has(returnType)) {
    errors.push("returnType.enum");
  }

  if (!isPlainObject(pkg.role)) {
    errors.push("role");
  } else {
    if (!asNonEmptyString(pkg.role.roleId)) errors.push("role.roleId");
    if (!asNonEmptyString(pkg.role.roleType)) errors.push("role.roleType");
  }

  for (const field of [
    "task",
    "deliveryReceipt",
    "returnSummary",
    "candidateEligibility",
  ] as const) {
    if (!isPlainObject(pkg[field])) errors.push(field);
  }

  if (!isPlainObject(pkg.recommendedNextAction)) {
    errors.push("recommendedNextAction");
  } else {
    for (const field of ["action", "target", "description"] as const) {
      if (!asNonEmptyString(pkg.recommendedNextAction[field])) {
        errors.push(`recommendedNextAction.${field}`);
      }
    }
  }

  return errors;
}

export function hasRequiredFollowup(pkg: RoleReturnPackageV1): boolean {
  return containsTruthyKey(pkg, new Set(["restartRequired", "buildRequired"]));
}

export function planReturnConsumption(params: {
  sourceFile: string;
  pkg: RoleReturnPackageV1;
  receiptExists: boolean;
  processedFileExists: boolean;
}): ReturnConsumerPlan {
  const { returnId, taskId } = extractReturnPackageIdentity(params.pkg);
  if (returnId?.startsWith("P2-P-") || taskId?.startsWith("P2-P-")) {
    return {
      status: "skip",
      sourceFile: params.sourceFile,
      returnId,
      taskId,
      reason: "legacy-p2-p-skipped",
    };
  }

  const validationErrors = validateRoleReturnPackageV1(params.pkg);
  if (validationErrors.length > 0) {
    return {
      status: "skip",
      sourceFile: params.sourceFile,
      returnId,
      taskId,
      reason: "schema-invalid",
      validationErrors,
    };
  }

  if (params.receiptExists) {
    return {
      status: "skip",
      sourceFile: params.sourceFile,
      returnId,
      taskId,
      reason: "receipt-exists",
    };
  }

  if (params.processedFileExists) {
    return {
      status: "skip",
      sourceFile: params.sourceFile,
      returnId,
      taskId,
      reason: "processed-file-exists",
    };
  }

  return {
    status: "process",
    sourceFile: params.sourceFile,
    returnId: returnId ?? "",
    taskId: taskId ?? "",
    actionRequired: hasRequiredFollowup(params.pkg),
  };
}

export function scanReturnConsumerPlan(
  workspaceRoot: string,
  options: ReturnConsumerPlanScanOptions = {},
): ReturnConsumerPlanScanResult {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const limit = Math.max(0, Math.floor(options.limit ?? 50));
  const inboxDir = path.join(workspaceRoot, RETURNS_INBOX_RELATIVE_PATH);
  const processedDir = path.join(workspaceRoot, RETURNS_PROCESSED_RELATIVE_PATH);
  const warnings: string[] = [];

  if (!existsSync(inboxDir)) {
    warnings.push("return inbox directory missing");
    return {
      mode: "observe-only",
      scannedAt,
      inboxPath: RETURNS_INBOX_RELATIVE_PATH,
      processedPath: RETURNS_PROCESSED_RELATIVE_PATH,
      totalCount: 0,
      processCount: 0,
      skipCount: 0,
      byReason: [],
      plans: [],
      warnings,
      constraintsVerified: defaultObserveOnlyConstraints(),
    };
  }

  const plans = readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^return-.*\.json$/u.test(entry.name))
    .map((entry): ReturnConsumerPlanScanItem => {
      const sourceFile = entry.name;
      const filePath = path.join(inboxDir, sourceFile);
      try {
        const pkg = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as
          | RoleReturnPackageV1
          | unknown;
        if (!isPlainObject(pkg)) {
          return {
            status: "skip",
            sourceFile,
            reason: "json-parse-failed",
            error: "return package root is not an object",
          };
        }
        const identity = extractReturnPackageIdentity(pkg);
        return planReturnConsumption({
          sourceFile,
          pkg,
          receiptExists: hasExistingReceipt(
            processedDir,
            identity.returnId,
            identity.taskId,
            sourceFile,
          ),
          processedFileExists: existsSync(path.join(processedDir, sourceFile)),
        });
      } catch (error) {
        warnings.push(`Failed to parse return: ${sourceFile}`);
        return {
          status: "skip",
          sourceFile,
          reason: "json-parse-failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  const visiblePlans = plans.slice(0, limit);
  const byReason = new Map<string, number>();
  for (const plan of plans) {
    if (plan.status !== "skip") continue;
    byReason.set(plan.reason, (byReason.get(plan.reason) ?? 0) + 1);
  }

  return {
    mode: "observe-only",
    scannedAt,
    inboxPath: RETURNS_INBOX_RELATIVE_PATH,
    processedPath: RETURNS_PROCESSED_RELATIVE_PATH,
    totalCount: plans.length,
    processCount: plans.filter((plan) => plan.status === "process").length,
    skipCount: plans.filter((plan) => plan.status === "skip").length,
    byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })),
    plans: visiblePlans,
    warnings,
    constraintsVerified: defaultObserveOnlyConstraints(),
  };
}

function containsTruthyKey(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsTruthyKey(item, keys));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => (keys.has(key) && child === true) || containsTruthyKey(child, keys),
  );
}

function hasExistingReceipt(
  processedDir: string,
  returnId: string | undefined,
  taskId: string | undefined,
  sourceFile: string,
): boolean {
  if (!existsSync(processedDir)) return false;
  for (const entry of readdirSync(processedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^receipt-rrpkg-.*\.json$/u.test(entry.name)) continue;
    try {
      const receipt = JSON.parse(
        readFileSync(path.join(processedDir, entry.name), "utf8"),
      ) as Record<string, unknown>;
      if (receipt.sourcePackage === sourceFile) return true;
      if (
        returnId &&
        (receipt.sourceReturnId === returnId || receipt.roleReturnPackageId === returnId)
      )
        return true;
      if (taskId && receipt.taskId === taskId && receipt.status === "consumed") return true;
    } catch {
      // Ignore unreadable legacy receipts.
    }
  }
  return false;
}

function defaultObserveOnlyConstraints(): ReturnConsumerPlanScanResult["constraintsVerified"] {
  return {
    consumed: "no",
    archived: "no",
    receiptWritten: "no",
    taskGraphMutated: "no",
    applied: "no",
  };
}
