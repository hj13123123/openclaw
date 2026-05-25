import type { RuntimeLoopPreflightDispatchPlanEntry } from "./runtime-loop.js";
import type { TaskRecord } from "./task-state-machine.js";

export type DispatchRecallEmbeddingCalls = "no" | "yes";

export type DispatchRecallPreviewConstraints = ReturnType<typeof dispatchRecallPreviewConstraints>;

type DispatchRecallPreviewConstraintCarrier = {
  constraintsVerified: DispatchRecallPreviewConstraints;
};

export function normalizeDispatchRecallPreviewLimit(raw: number | null | undefined): number {
  if (!Number.isFinite(raw)) return 5;
  return Math.min(10, Math.max(0, Math.floor(raw ?? 5)));
}

export function normalizeDispatchRecallResultLimit(raw: number | null | undefined): number {
  if (!Number.isFinite(raw)) return 3;
  return Math.min(10, Math.max(1, Math.floor(raw ?? 3)));
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataText(task: TaskRecord | undefined, fields: string[]): string[] {
  if (!task) return [];
  return fields
    .map((field) => optionalText(task.metadata[field]))
    .filter((value): value is string => value !== null);
}

export function buildDispatchRecallQuery(
  candidate: RuntimeLoopPreflightDispatchPlanEntry,
  task: TaskRecord | undefined,
): string {
  return [
    task?.taskId ?? candidate.taskId,
    task?.summary,
    task?.sourceRole,
    candidate.dispatchTarget,
    candidate.policyDecision,
    candidate.riskLevel,
    ...metadataText(task, ["title", "summary", "description", "intent", "goal", "task"]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export function dispatchRecallPreviewConstraints(embeddingCalls: DispatchRecallEmbeddingCalls) {
  return {
    stateWritten: "no" as const,
    artifactWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

export function dispatchRecallAcceptanceConstraints(embeddingCalls: DispatchRecallEmbeddingCalls) {
  return {
    ...dispatchRecallPreviewConstraints(embeddingCalls),
    acceptanceRecordWritten: "no" as const,
  };
}

export function dispatchRecallAcceptanceRecordDryRunConstraints(
  embeddingCalls: DispatchRecallEmbeddingCalls,
) {
  return {
    ...dispatchRecallAcceptanceConstraints(embeddingCalls),
    recordWritten: "no" as const,
  };
}

export function dispatchRecallAcceptanceRecordWriteConstraints(
  embeddingCalls: DispatchRecallEmbeddingCalls,
  recordWritten: "no" | "yes",
) {
  return {
    stateWritten: "no" as const,
    artifactWritten:
      recordWritten === "yes" ? ("acceptance-record-only" as const) : ("no" as const),
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
    acceptanceRecordWritten: recordWritten,
    recordWritten,
  };
}

export function dispatchRecallAcceptanceRecordListConstraints() {
  return {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls: "no" as const,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

export function dispatchRecallPreflightConstraints(
  embeddingCalls: DispatchRecallEmbeddingCalls = "no",
) {
  return {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

export function dispatchRecallDispatchDryRunConstraints(
  embeddingCalls: DispatchRecallEmbeddingCalls = "no",
) {
  return {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    wouldDispatch: false as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

export function dispatchRecallStatusConstraints(embeddingCalls: DispatchRecallEmbeddingCalls) {
  return {
    fileWrites: "no" as const,
    stateWritten: "no" as const,
    eventEmitted: "no" as const,
    dispatchTriggered: "no" as const,
    wouldDispatch: false as const,
    sessionsSpawnCalled: "no" as const,
    taskGraphMutated: "no" as const,
    returnConsumed: "no" as const,
    receiptWritten: "no" as const,
    embeddingCalls,
    keywordIndexWritten: "no" as const,
    semanticIndexWritten: "no" as const,
    vectorIndexWritten: "no" as const,
    realRebuildTriggered: "no" as const,
    applied: "no" as const,
  };
}

export function dispatchRecallPreviewConstraintsValid(
  preview: DispatchRecallPreviewConstraintCarrier,
): boolean {
  const constraints = preview.constraintsVerified;
  return (
    constraints.stateWritten === "no" &&
    constraints.artifactWritten === "no" &&
    constraints.eventEmitted === "no" &&
    constraints.dispatchTriggered === "no" &&
    constraints.sessionsSpawnCalled === "no" &&
    constraints.taskGraphMutated === "no" &&
    constraints.returnConsumed === "no" &&
    constraints.receiptWritten === "no" &&
    constraints.keywordIndexWritten === "no" &&
    constraints.semanticIndexWritten === "no" &&
    constraints.vectorIndexWritten === "no" &&
    constraints.realRebuildTriggered === "no" &&
    constraints.applied === "no"
  );
}
