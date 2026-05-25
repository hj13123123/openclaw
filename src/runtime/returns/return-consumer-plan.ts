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

function containsTruthyKey(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsTruthyKey(item, keys));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => (keys.has(key) && child === true) || containsTruthyKey(child, keys),
  );
}
