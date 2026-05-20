export const TASK_GRAPH_STATUSES = [
  "planned",
  "ready",
  "dispatched",
  "running",
  "returned",
  "review_pending",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type TaskGraphStatus = (typeof TASK_GRAPH_STATUSES)[number];

export const TASK_GRAPH_ROLES = [
  "main",
  "engineering-executive",
  "front-end-executive",
  "patrol",
  "curator",
  "evolution-curator",
] as const;

export type TaskGraphRole = (typeof TASK_GRAPH_ROLES)[number];

export const TASK_GRAPH_EDGE_TYPES = ["hard", "soft", "parallel"] as const;

export type TaskGraphEdgeType = (typeof TASK_GRAPH_EDGE_TYPES)[number];

export interface TaskGraphNode {
  nodeId: string;
  role: TaskGraphRole | string;
  taskId: string;
  description: string;
  dependsOn: string[];
  status: TaskGraphStatus;
  runId: string | null;
  sessionKey: string | null;
  returnId: string | null;
  humanGateRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  type: TaskGraphEdgeType;
}

export interface TaskGraphBlocker {
  nodeId: string;
  reason: string;
}

export interface TaskGraph {
  graphId: string;
  parentTaskId: string;
  title: string;
  status: TaskGraphStatus;
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  aggregateStatus: TaskGraphStatus;
  blockers: TaskGraphBlocker[];
  nextRunnable: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraphValidationIssue {
  check: string;
  field: string;
  expected: string;
  actual: string;
  message: string;
}

export interface TaskGraphValidationResult {
  valid: boolean;
  errors: TaskGraphValidationIssue[];
  warnings: TaskGraphValidationIssue[];
  calculatedAggregateStatus: TaskGraphStatus;
  calculatedNextRunnable: string[];
  calculatedBlockers: TaskGraphBlocker[];
}

export interface TaskGraphReconcileResult {
  graph: TaskGraph;
  changedNodeIds: string[];
  blockedNodeIds: string[];
}

const BLOCKING_STATUSES = new Set<TaskGraphStatus>(["blocked", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set<TaskGraphStatus>(["dispatched", "running", "returned", "review_pending"]);
const DISPATCHABLE_STATUSES = new Set<TaskGraphStatus>(["planned", "ready"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(params: TaskGraphValidationIssue): TaskGraphValidationIssue {
  return params;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTaskGraphStatus(value: unknown): value is TaskGraphStatus {
  return typeof value === "string" && TASK_GRAPH_STATUSES.includes(value as TaskGraphStatus);
}

export function isTaskGraphEdgeType(value: unknown): value is TaskGraphEdgeType {
  return typeof value === "string" && TASK_GRAPH_EDGE_TYPES.includes(value as TaskGraphEdgeType);
}

export function calculateTaskGraphAggregateStatus(nodes: readonly TaskGraphNode[]): TaskGraphStatus {
  if (nodes.length === 0) return "planned";
  const statuses = nodes.map((node) => node.status);
  if (statuses.some((status) => BLOCKING_STATUSES.has(status))) return "blocked";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.some((status) => ACTIVE_STATUSES.has(status))) return "running";
  if (statuses.some((status) => status === "ready")) return "ready";
  return "planned";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolveHardDependencyIds(graph: Pick<TaskGraph, "nodes" | "edges">, node: TaskGraphNode): string[] {
  return unique([
    ...node.dependsOn,
    ...graph.edges
      .filter((edge) => edge.to === node.nodeId && edge.type === "hard")
      .map((edge) => edge.from),
  ]);
}

export function resolveTaskGraphBlockers(graph: Pick<TaskGraph, "nodes" | "edges">): TaskGraphBlocker[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const blockers: TaskGraphBlocker[] = [];

  for (const node of graph.nodes) {
    for (const depId of resolveHardDependencyIds(graph, node)) {
      const dependency = nodesById.get(depId);
      if (!dependency) {
        blockers.push({ nodeId: node.nodeId, reason: `missing hard dependency: ${depId}` });
      } else if (BLOCKING_STATUSES.has(dependency.status)) {
        blockers.push({ nodeId: node.nodeId, reason: `hard dependency ${depId} is ${dependency.status}` });
      }
    }
  }

  for (const node of graph.nodes) {
    if (BLOCKING_STATUSES.has(node.status)) blockers.push({ nodeId: node.nodeId, reason: `status=${node.status}` });
  }

  return blockers;
}

export function resolveTaskGraphNextRunnable(graph: Pick<TaskGraph, "nodes" | "edges">): string[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const blockersByNodeId = new Set(resolveTaskGraphBlockers(graph).map((blocker) => blocker.nodeId));
  const nextRunnable: string[] = [];

  for (const node of graph.nodes) {
    if (!DISPATCHABLE_STATUSES.has(node.status) || blockersByNodeId.has(node.nodeId)) continue;
    const hardDependencyIds = resolveHardDependencyIds(graph, node);
    const hardDependenciesComplete = hardDependencyIds.every((depId) => nodesById.get(depId)?.status === "completed");
    if (hardDependenciesComplete) nextRunnable.push(node.nodeId);
  }

  return nextRunnable;
}

function validateRequiredString(
  value: Record<string, unknown>,
  field: string,
  errors: TaskGraphValidationIssue[],
  prefix = "",
): void {
  if (!isNonEmptyString(value[field])) {
    errors.push(issue({
      check: "required_string",
      field: `${prefix}${field}`,
      expected: "non-empty string",
      actual: jsonType(value[field]),
      message: `${prefix}${field} must be a non-empty string.`,
    }));
  }
}

function validateStringOrNull(
  value: Record<string, unknown>,
  field: string,
  errors: TaskGraphValidationIssue[],
  prefix = "",
): void {
  if (value[field] !== null && typeof value[field] !== "string") {
    errors.push(issue({
      check: "string_or_null",
      field: `${prefix}${field}`,
      expected: "string or null",
      actual: jsonType(value[field]),
      message: `${prefix}${field} must be a string or null.`,
    }));
  }
}

export function validateTaskGraph(value: unknown): TaskGraphValidationResult {
  const errors: TaskGraphValidationIssue[] = [];
  const warnings: TaskGraphValidationIssue[] = [];

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: [issue({
        check: "top_level_object",
        field: "$",
        expected: "object",
        actual: jsonType(value),
        message: "Task graph must be a JSON object.",
      })],
      warnings,
      calculatedAggregateStatus: "planned",
      calculatedNextRunnable: [],
      calculatedBlockers: [],
    };
  }

  for (const field of ["graphId", "parentTaskId", "title", "createdAt", "updatedAt"]) {
    validateRequiredString(value, field, errors);
  }
  for (const field of ["nodes", "edges", "blockers", "nextRunnable"]) {
    if (!Array.isArray(value[field])) {
      errors.push(issue({
        check: "required_array",
        field,
        expected: "array",
        actual: jsonType(value[field]),
        message: `${field} must be an array.`,
      }));
    }
  }
  for (const field of ["status", "aggregateStatus"]) {
    if (!isTaskGraphStatus(value[field])) {
      errors.push(issue({
        check: "status_enum",
        field,
        expected: TASK_GRAPH_STATUSES.join(","),
        actual: String(value[field]),
        message: `${field} is outside the allowed enum.`,
      }));
    }
  }

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  const nodes = rawNodes.filter(isRecord) as unknown as TaskGraphNode[];
  const edges = rawEdges.filter(isRecord) as unknown as TaskGraphEdge[];
  const nodeIds = new Set<string>();

  rawNodes.forEach((rawNode, index) => {
    const prefix = `nodes[${index}].`;
    if (!isRecord(rawNode)) {
      errors.push(issue({
        check: "node_object",
        field: `nodes[${index}]`,
        expected: "object",
        actual: jsonType(rawNode),
        message: "Task graph node must be an object.",
      }));
      return;
    }

    for (const field of ["nodeId", "role", "taskId", "description", "createdAt", "updatedAt"]) {
      validateRequiredString(rawNode, field, errors, prefix);
    }
    for (const field of ["runId", "sessionKey", "returnId"]) {
      validateStringOrNull(rawNode, field, errors, prefix);
    }
    if (!Array.isArray(rawNode.dependsOn) || rawNode.dependsOn.some((entry) => typeof entry !== "string")) {
      errors.push(issue({
        check: "depends_on_array",
        field: `${prefix}dependsOn`,
        expected: "string array",
        actual: jsonType(rawNode.dependsOn),
        message: `${prefix}dependsOn must be a string array.`,
      }));
    }
    if (!isTaskGraphStatus(rawNode.status)) {
      errors.push(issue({
        check: "status_enum",
        field: `${prefix}status`,
        expected: TASK_GRAPH_STATUSES.join(","),
        actual: String(rawNode.status),
        message: `${prefix}status is outside the allowed enum.`,
      }));
    }
    if (typeof rawNode.humanGateRequired !== "boolean") {
      errors.push(issue({
        check: "human_gate_boolean",
        field: `${prefix}humanGateRequired`,
        expected: "boolean",
        actual: jsonType(rawNode.humanGateRequired),
        message: `${prefix}humanGateRequired must be a boolean.`,
      }));
    }
    if (isNonEmptyString(rawNode.nodeId)) {
      if (nodeIds.has(rawNode.nodeId)) {
        errors.push(issue({
          check: "duplicate_node_id",
          field: `${prefix}nodeId`,
          expected: "unique nodeId",
          actual: rawNode.nodeId,
          message: "Duplicate nodeId found in task graph.",
        }));
      }
      nodeIds.add(rawNode.nodeId);
    }
    if (isNonEmptyString(rawNode.role) && !TASK_GRAPH_ROLES.includes(rawNode.role as TaskGraphRole)) {
      warnings.push(issue({
        check: "role_enum",
        field: `${prefix}role`,
        expected: TASK_GRAPH_ROLES.join(","),
        actual: rawNode.role,
        message: `${prefix}role is unknown.`,
      }));
    }
  });

  rawEdges.forEach((rawEdge, index) => {
    const prefix = `edges[${index}].`;
    if (!isRecord(rawEdge)) {
      errors.push(issue({
        check: "edge_object",
        field: `edges[${index}]`,
        expected: "object",
        actual: jsonType(rawEdge),
        message: "Task graph edge must be an object.",
      }));
      return;
    }
    for (const field of ["from", "to"]) {
      validateRequiredString(rawEdge, field, errors, prefix);
      if (isNonEmptyString(rawEdge[field]) && !nodeIds.has(rawEdge[field])) {
        errors.push(issue({
          check: "edge_reference",
          field: `${prefix}${field}`,
          expected: "existing nodeId",
          actual: rawEdge[field],
          message: `${prefix}${field} must reference an existing nodeId.`,
        }));
      }
    }
    if (!isTaskGraphEdgeType(rawEdge.type)) {
      errors.push(issue({
        check: "edge_type_enum",
        field: `${prefix}type`,
        expected: TASK_GRAPH_EDGE_TYPES.join(","),
        actual: String(rawEdge.type),
        message: `${prefix}type is outside the allowed enum.`,
      }));
    }
  });

  for (const [index, node] of nodes.entries()) {
    const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    for (const depId of dependsOn) {
      if (!nodeIds.has(depId)) {
        errors.push(issue({
          check: "depends_on_reference",
          field: `nodes[${index}].dependsOn`,
          expected: "existing nodeId",
          actual: depId,
          message: "dependsOn entry must reference an existing nodeId.",
        }));
      }
    }
  }

  const graphForCalculation = { nodes, edges };
  const calculatedAggregateStatus = calculateTaskGraphAggregateStatus(nodes);
  const calculatedNextRunnable = resolveTaskGraphNextRunnable(graphForCalculation);
  const calculatedBlockers = resolveTaskGraphBlockers(graphForCalculation);

  if (isTaskGraphStatus(value.aggregateStatus) && value.aggregateStatus !== calculatedAggregateStatus) {
    errors.push(issue({
      check: "aggregate_status",
      field: "aggregateStatus",
      expected: calculatedAggregateStatus,
      actual: value.aggregateStatus,
      message: "Declared aggregateStatus does not match calculated aggregate status.",
    }));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    calculatedAggregateStatus,
    calculatedNextRunnable,
    calculatedBlockers,
  };
}

export function reconcileTaskGraph(graph: TaskGraph, nowIso = new Date().toISOString()): TaskGraphReconcileResult {
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const changedNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];
  const blockers = resolveTaskGraphBlockers(graph);
  const blockersByNodeId = new Set(blockers.map((blocker) => blocker.nodeId));

  const nodes = graph.nodes.map((node) => {
    if (!DISPATCHABLE_STATUSES.has(node.status)) return node;
    const hardDependencyIds = resolveHardDependencyIds(graph, node);
    const hardDependenciesComplete = hardDependencyIds.every((depId) => nodesById.get(depId)?.status === "completed");
    const nextStatus: TaskGraphStatus = blockersByNodeId.has(node.nodeId)
      ? "blocked"
      : hardDependenciesComplete
        ? "ready"
        : "planned";
    if (nextStatus === node.status) return node;
    changedNodeIds.push(node.nodeId);
    if (nextStatus === "blocked") blockedNodeIds.push(node.nodeId);
    return { ...node, status: nextStatus, updatedAt: nowIso };
  });

  const nextGraphBase = { ...graph, nodes };
  const nextBlockers = resolveTaskGraphBlockers(nextGraphBase);
  const nextRunnable = resolveTaskGraphNextRunnable(nextGraphBase);
  const aggregateStatus = calculateTaskGraphAggregateStatus(nodes);

  return {
    graph: {
      ...nextGraphBase,
      aggregateStatus,
      blockers: nextBlockers,
      nextRunnable,
      updatedAt: changedNodeIds.length > 0 || aggregateStatus !== graph.aggregateStatus ? nowIso : graph.updatedAt,
    },
    changedNodeIds,
    blockedNodeIds,
  };
}
