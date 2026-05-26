import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

type HudStatus =
  | "healthy"
  | "warning"
  | "error"
  | "idle"
  | "degraded"
  | "attention_required"
  | string;

type AgentState = {
  agentId: string;
  displayName?: string | null;
  role?: string;
  status?: string;
  currentTaskTitle?: string | null;
  currentTask?: string | null;
  progressPct?: number;
  source?: string;
  lastProgressAt?: string | null;
};

type AttentionItem = {
  id?: string;
  taskId?: string;
  severity?: string;
  reason?: string;
  createdAt?: string;
  needsReview?: boolean;
};

type ActiveTask = {
  taskId: string;
  taskTitle?: string;
  agentId?: string;
  status?: string;
  progressPct?: number;
};

type ReturnPendingItem = {
  returnId: string;
  taskId?: string | null;
  status?: string;
  createdAt?: string;
  needsReview?: boolean;
  summary?: string | null;
};

type ReturnConsumerPlanState = {
  mode?: string;
  totalCount?: number;
  processCount?: number;
  skipCount?: number;
  warningCount?: number;
  byReason?: Array<{ reason?: string; count?: number }>;
  constraintsVerified?: Record<string, string>;
};

type ReturnDiagnosisState = {
  mode?: string;
  totalCount?: number;
  diagnosableCount?: number;
  warningCount?: number;
  byCompatibility?: Array<{ compatibility?: string; count?: number }>;
  bySuggestedAction?: Array<{ action?: string; count?: number }>;
  byIssueCode?: Array<{ code?: string; count?: number }>;
  constraintsVerified?: Record<string, string>;
};

type ControlSignalsState = {
  mode?: string;
  status?: string;
  frozen?: boolean;
  g2Approved?: boolean;
  pendingCount?: number;
  validCount?: number;
  invalidCount?: number;
  expiredCount?: number;
  errorCount?: number;
  byRole?: Array<{ role?: string; count?: number }>;
  byAction?: Array<{ action?: string; count?: number }>;
  constraintsVerified?: Record<string, string>;
};

type RecoveryCandidatesState = {
  mode?: string;
  frozen?: boolean;
  graphCount?: number;
  candidateCount?: number;
  errorCount?: number;
  byStatus?: Array<{ status?: string; count?: number }>;
  bySuggestedAction?: Array<{ action?: string; count?: number }>;
  constraintsVerified?: Record<string, string>;
};

type PromotionCandidatesState = {
  available?: boolean;
  status?: string;
  generatedAt?: string | null;
  lastSyncedAt?: string | null;
  stats?: {
    total?: number;
    byState?: Record<string, number>;
    byRisk?: Record<string, number>;
    byConsistency?: Record<string, number>;
    invalid?: number;
    safeApplyEligible?: number;
  };
  errorCount?: number;
  constraintsVerified?: Record<string, string>;
};

type SchedulerTickPlanState = {
  mode?: string;
  decision?: string;
  reason?: string;
  enabled?: boolean;
  markerMode?: string;
  stateStatus?: string;
  running?: boolean;
  totalTicks?: number;
  nextTickIndex?: number | null;
  warningCount?: number;
  maxTicks?: {
    effective?: number;
    reason?: string;
    global?: number;
    perTask?: number | null;
    perTaskId?: string | null;
    reached?: boolean;
  };
  sourceFiles?: {
    tickScriptExists?: boolean;
  };
  constraintsVerified?: Record<string, string>;
};

type ObserveSummaryState = {
  available?: boolean;
  reportPath?: string | null;
  mirrorId?: string | null;
  generatedAt?: string | null;
  mode?: string | null;
  stats?: {
    observationCount?: number;
    findingCount?: number;
    totalSuggestions?: number;
    bySeverity?: Record<string, number>;
    byPriority?: Record<string, number>;
    bySource?: Record<string, number>;
  } | null;
  constraintsVerified?: Record<string, string> | null;
  verdict?: string | null;
};

type TaskGraphItem = {
  graphId: string;
  title?: string | null;
  aggregateStatus?: string | null;
  nodeSummary?: {
    total?: number;
    completed?: number;
    running?: number;
    ready?: number;
    blocked?: number;
    failed?: number;
  };
  blockers?: Array<{ nodeId?: string; reason?: string }>;
  nextRunnable?: string[];
  lastValidatedAt?: string | null;
  validationSeverity?: string | null;
};

type TaskGraphReturnPreviewState = {
  mode?: string;
  observedAt?: string;
  graphCount?: number;
  nodeCount?: number;
  pendingReturnCount?: number;
  matchedNodeCount?: number;
  missingNodeCount?: number;
  ambiguousNodeCount?: number;
  declaredReturnNodeCount?: number;
  unmatchedReturnCount?: number;
  graphErrorCount?: number;
  sampleUnmatchedReturns?: Array<{
    returnId?: string;
    taskId?: string | null;
    reason?: string;
  }>;
  constraintsVerified?: Record<string, string>;
};

type TaskGraphValidationIssue = {
  check?: string;
  field?: string;
  message?: string;
};

type TaskGraphValidationReport = {
  graphId?: string | null;
  checkedAt?: string | null;
  status?: string;
  severity?: string;
  errors?: TaskGraphValidationIssue[];
  warnings?: TaskGraphValidationIssue[];
};

type TaskGraphValidationState = {
  available?: boolean;
  total?: number;
  valid?: boolean;
  bySeverity?: Record<string, number>;
  reports?: TaskGraphValidationReport[];
};

type RecentCompletionItem = {
  taskId: string;
  level: "L0" | "L1" | "L2";
  status: string;
  completedAt: string;
};

type RuntimeEvent = {
  eventId?: string;
  eventType?: string;
  timestamp?: string;
  source?: string;
};

type SchedulerState = {
  enabled?: boolean;
  mode?: string;
  status?: string;
  totalTicks?: number;
  maxTicks?: number | null;
  maxTicksReached?: boolean;
  lastExitCode?: number | null;
  lastTickFinishedAt?: string | null;
  skippedBecauseRunning?: number;
  skippedBecauseDisabled?: number;
  skippedBecauseMaxTicks?: number;
  running?: boolean;
};

type TaskStateData = {
  summary?: {
    total?: number;
    queued?: number;
    completed?: number;
    failed?: number;
    deferred?: number;
    blocked?: number;
    quarantined?: number;
  } | null;
  tasks?: Array<{
    taskId: string;
    status: string;
    sourceRole?: string;
    updatedAt?: string;
    summary?: string;
  }>;
};

type RuntimeLoopStateData = {
  ok?: boolean;
  data?: {
    latest_tick_id?: string | null;
    latest_tick_at?: string | null;
    freshness?: {
      status?: string;
      ageMs?: number | null;
      staleAfterMs?: number;
    };
    mode?: string;
    dispatch_plan_count?: number;
    inbox_count?: number;
    warnings?: string[];
  } | null;
};

type PromoteGateStateData = {
  available?: boolean;
  status?: string;
  mode?: string;
  generatedAt?: string | null;
  frozenActive?: boolean;
  reportPath?: string | null;
  reportDir?: string;
  error?: string;
  stats?: {
    total?: number;
    byVerdict?: Record<string, number>;
    byType?: Record<string, number>;
  } | null;
  constraintsVerified?: Record<string, string> | null;
};

type KbStateData = {
  available?: boolean;
  indexPath?: string;
  generatedAt?: string | null;
  totalItems?: number;
  sourceCaseCount?: number;
  sourceSkillCount?: number;
  keywordCount?: number;
  semantic?: {
    status?: string;
    mode?: string;
    rebuild?: string;
    provider?: string | null;
    model?: string | null;
    vectorEnabled?: boolean | null;
    hybridEnabled?: boolean | null;
  };
};

type KbSemanticPlanStateData = {
  available?: boolean;
  status?: string;
  mode?: string;
  dryRun?: boolean;
  generatedAt?: string | null;
  reportPath?: string | null;
  plannedBatches?: number;
  blockedReasons?: string[];
  source?: {
    totalItems?: number;
    sourceCaseCount?: number;
    sourceSkillCount?: number;
    keywordCount?: number;
    warnings?: string[];
  };
  constraintsVerified?: {
    embeddingCalls?: string;
    fileWrites?: string;
    keywordIndexWritten?: string;
    vectorIndexWritten?: string;
    applied?: string;
    dryRunReportWritten?: string;
  };
};

type KbSemanticAcceptanceStateData = {
  mode?: string;
  checkedAt?: string | null;
  proposalPath?: string | null;
  wouldWrite?: boolean;
  wouldWritePath?: string | null;
  acceptance?: {
    mode?: string;
    checkedAt?: string | null;
    proposalPath?: string | null;
    status?: string;
    readyForHumanGate?: boolean;
    blockReasons?: string[];
    proposalSummary?: {
      proposalId?: string;
      status?: string;
      generatedAt?: string;
      provider?: string | null;
      model?: string | null;
      totalItems?: number;
      plannedBatches?: number;
      blockedReasons?: string[];
    } | null;
    currentSummary?: {
      status?: string;
      provider?: string | null;
      model?: string | null;
      totalItems?: number;
      plannedBatches?: number;
      blockedReasons?: string[];
    } | null;
    constraintsVerified?: {
      acceptanceRecordWritten?: string;
      stateWritten?: string;
      embeddingCalls?: string;
      keywordIndexWritten?: string;
      vectorIndexWritten?: string;
      realRebuildTriggered?: string;
      applied?: string;
    };
  };
  recordPreview?: {
    acceptanceId?: string;
    createdAt?: string;
    status?: string;
    proposalId?: string;
    proposalPath?: string;
    plannedBatches?: number;
    totalItems?: number;
    requiredApproval?: string;
    nextAction?: string;
    approved?: boolean;
    rebuildTriggered?: boolean;
  } | null;
  constraintsVerified?: {
    recordWritten?: string;
    stateWritten?: string;
    embeddingCalls?: string;
    keywordIndexWritten?: string;
    vectorIndexWritten?: string;
    realRebuildTriggered?: string;
    applied?: string;
  };
};

type KbSemanticAcceptanceRecordsStateData = {
  available?: boolean;
  mode?: string;
  reportDir?: string;
  reportPrefix?: string;
  totalRecords?: number;
  returnedRecords?: number;
  invalidRecords?: number;
  records?: Array<{
    recordPath?: string;
    acceptanceId?: string;
    createdAt?: string;
    status?: string;
    proposalId?: string;
    proposalPath?: string;
    plannedBatches?: number;
    totalItems?: number;
    requiredApproval?: string;
    nextAction?: string;
    approved?: boolean;
    rebuildTriggered?: boolean;
    constraintsVerified?: {
      recordWritten?: string;
      stateWritten?: string;
      embeddingCalls?: string;
      keywordIndexWritten?: string;
      vectorIndexWritten?: string;
      realRebuildTriggered?: string;
      applied?: string;
    };
  }>;
  constraintsVerified?: {
    fileWrites?: string;
    embeddingCalls?: string;
    keywordIndexWritten?: string;
    vectorIndexWritten?: string;
    realRebuildTriggered?: string;
    applied?: string;
  };
};

type PolicyStateData = {
  policyVersion?: string | null;
  rulesCount?: number;
  enabledCount?: number;
  lastEvaluation?: string | null;
  recentDecisions?: Array<{
    taskId?: string;
    riskLevel?: string;
    action?: string;
    reason?: string;
    timestamp?: string;
  }>;
};

type HUDState = {
  generatedAt?: string;
  available?: boolean | null;
  message?: string;
  globalStatus?: {
    status?: HudStatus;
    runningCount?: number;
    pendingReviewCount?: number;
    alertCount?: number;
  };
  agentGroups?: AgentState[];
  attentionQueue?: AttentionItem[];
  activeTasks?: ActiveTask[];
  returnInbox?: {
    pendingCount?: number;
    lastScanAt?: string;
    pendingItems?: ReturnPendingItem[];
  };
  returnConsumerPlan?: ReturnConsumerPlanState;
  returnDiagnosis?: ReturnDiagnosisState;
  controlSignals?: ControlSignalsState;
  recoveryCandidates?: RecoveryCandidatesState;
  promotionCandidates?: PromotionCandidatesState;
  schedulerTickPlan?: SchedulerTickPlanState;
  watchdogSnapshot?: {
    totalAlerts?: number;
    healthyCount?: number;
    byCondition?: Record<string, number>;
  };
  taskGraphs?: {
    items?: TaskGraphItem[];
    returnPreview?: TaskGraphReturnPreviewState;
  };
  mirrorObserve?: ObserveSummaryState;
  autoEvolutionObserve?: ObserveSummaryState;
  recentCompletions?: {
    totalToday: number;
    lastCompletedAt: string | null;
    items: RecentCompletionItem[];
  };
  warnings?: string[];
};

const AGENT_NAME_MAP: Record<string, string> = {
  main: "主控",
  "engineering-executive": "工程执行岗",
  "front-end-executive": "前端执行岗",
  patrol: "巡检岗",
  "evolution-curator": "进化策展岗",
};

const STATUS_LABELS: Record<string, string> = {
  healthy: "正常",
  warning: "警告",
  error: "异常",
  idle: "空闲",
  degraded: "降级",
  attention_required: "需要关注",
  completed: "已完成",
  running: "运行中",
  active: "活跃",
  failed: "失败",
  blocked: "阻塞",
  queued: "排队中",
  deferred: "已延期",
  quarantined: "已隔离",
  ready: "就绪",
  planned: "计划中",
  pending: "待处理",
  reviewed: "已验收",
  approved: "已批准",
  rejected: "已拒绝",
  disabled: "已停用",
  unknown: "未知",
};

const ROLE_LABELS: Record<string, string> = {
  orchestrator: "主控",
  execution: "执行岗",
  observability: "观测岗",
};

function text(value: unknown, fallback = "暂无"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function truncate(value: unknown, max = 34): string {
  const raw = text(value, "");
  if (!raw) return "暂无";
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function labelStatus(status: unknown): string {
  const key = typeof status === "string" ? status.trim().toLowerCase() : "";
  return STATUS_LABELS[key] ?? text(status, "未知");
}

function formatTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "暂无时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
    2,
    "0",
  )} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatRelative(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return formatTime(value);
}

function statusClass(status: unknown): string {
  return typeof status === "string"
    ? status
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
    : "unknown";
}

@customElement("task-hud")
export class TaskHUD extends LitElement {
  @state() private panelOpen = false;
  @state() private hud: HUDState | null = null;
  @state() private hudStatus: "loading" | "live" | "unavailable" = "loading";
  @state() private scheduler: SchedulerState | null = null;
  @state() private events: RuntimeEvent[] = [];
  @state() private taskState: TaskStateData | null = null;
  @state() private taskGraphValidation: TaskGraphValidationState | null = null;
  @state() private runtimeLoop: RuntimeLoopStateData | null = null;
  @state() private promoteGate: PromoteGateStateData | null = null;
  @state() private kbState: KbStateData | null = null;
  @state() private kbSemanticPlan: KbSemanticPlanStateData | null = null;
  @state() private kbSemanticAcceptance: KbSemanticAcceptanceStateData | null = null;
  @state() private kbSemanticAcceptanceRecords: KbSemanticAcceptanceRecordsStateData | null = null;
  @state() private policy: PolicyStateData | null = null;
  @state() private refreshing = false;

  private refreshTimer: number | null = null;

  static override styles = css`
    :host {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 9999;
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      color: #e5edf8;
    }

    button {
      font: inherit;
    }

    .toggle {
      min-width: 42px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.96);
      color: #dbeafe;
      cursor: pointer;
      box-shadow: 0 8px 22px rgba(15, 23, 42, 0.35);
    }

    .toggle.active {
      border-color: rgba(96, 165, 250, 0.9);
      color: #bfdbfe;
    }

    .panel {
      position: absolute;
      right: 0;
      bottom: 44px;
      width: min(430px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 80px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.98);
      box-shadow: 0 18px 48px rgba(2, 6, 23, 0.46);
    }

    .header,
    .footer {
      padding: 12px 14px;
      background: rgba(30, 41, 59, 0.62);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.16);
    }

    .title {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .refresh {
      height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 6px;
      background: rgba(51, 65, 85, 0.78);
      color: #bfdbfe;
      cursor: pointer;
    }

    .refresh[disabled] {
      opacity: 0.55;
      cursor: default;
    }

    .body {
      min-height: 0;
      overflow-y: auto;
      padding: 12px;
    }

    .status {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 8px;
      background: rgba(30, 41, 59, 0.58);
    }

    .status-line {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: #64748b;
    }

    .dot.healthy,
    .dot.completed,
    .dot.running,
    .dot.active,
    .dot.ready {
      background: #22c55e;
    }

    .dot.warning,
    .dot.degraded,
    .dot.attention_required,
    .dot.blocked,
    .dot.pending {
      background: #f59e0b;
    }

    .dot.error,
    .dot.failed,
    .dot.quarantined {
      background: #ef4444;
    }

    .primary,
    .name {
      min-width: 0;
      overflow: hidden;
      color: #f8fafc;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .counts {
      display: flex;
      gap: 10px;
      color: #94a3b8;
      font-size: 11px;
      white-space: nowrap;
    }

    .counts strong {
      color: #f8fafc;
    }

    .section {
      margin-top: 12px;
    }

    .section-title {
      margin: 0 0 7px;
      color: #93c5fd;
      font-size: 12px;
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .card,
    .row {
      border: 1px solid rgba(148, 163, 184, 0.13);
      border-radius: 8px;
      background: rgba(30, 41, 59, 0.5);
    }

    .card {
      padding: 10px;
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      margin-bottom: 6px;
      font-size: 11px;
    }

    .meta,
    .secondary {
      min-width: 0;
      overflow: hidden;
      color: #94a3b8;
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      color: #cbd5e1;
      font-size: 10px;
      white-space: nowrap;
    }

    .details {
      margin-top: 6px;
      color: #cbd5e1;
      font-size: 10px;
    }

    .details summary {
      color: #bfdbfe;
      cursor: pointer;
    }

    .issue {
      margin-top: 5px;
      padding-left: 8px;
      border-left: 2px solid rgba(148, 163, 184, 0.24);
    }

    .progress-track {
      height: 4px;
      margin-top: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.2);
    }

    .progress {
      height: 100%;
      background: #3b82f6;
    }

    .fallback,
    .empty {
      padding: 18px 12px;
      color: #94a3b8;
      text-align: center;
      font-size: 12px;
    }

    .fallback strong {
      display: block;
      margin-bottom: 6px;
      color: #f8fafc;
      font-size: 14px;
    }

    .footer {
      border-top: 1px solid rgba(148, 163, 184, 0.16);
      color: #64748b;
      font-size: 10px;
      text-align: center;
    }

    @media (max-width: 520px) {
      :host {
        right: 12px;
        bottom: 12px;
      }

      .grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refreshAll();
    this.refreshTimer = window.setInterval(() => void this.refreshAll(false), 30_000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshAll(triggerGenerator = false) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (triggerGenerator) {
        await Promise.all([
          fetch("/api/hud/refresh", { method: "POST" }),
          fetch("/api/hud/runtime-loop/refresh", { method: "POST" }),
        ]);
      }
      await Promise.all([
        this.fetchHudState(),
        this.fetchSchedulerState(),
        this.fetchTaskState(),
        this.fetchTaskGraphValidation(),
        this.fetchRuntimeLoopState(),
        this.fetchPromoteGateState(),
        this.fetchKbState(),
        this.fetchKbSemanticPlanState(),
        this.fetchKbSemanticAcceptanceState(),
        this.fetchKbSemanticAcceptanceRecordsState(),
        this.fetchPolicyState(),
      ]);
    } finally {
      this.refreshing = false;
    }
  }

  private async fetchHudState() {
    try {
      const response = await fetch("/api/hud/state");
      const json = (await response.json()) as HUDState;
      this.hud = json;
      this.hudStatus = json.available === false || json.available === null ? "unavailable" : "live";
    } catch {
      this.hud = null;
      this.hudStatus = "unavailable";
    }
  }

  private async fetchSchedulerState() {
    try {
      const [stateResponse, eventsResponse] = await Promise.all([
        fetch("/api/hud/scheduler-state"),
        fetch("/api/hud/scheduler-events?limit=8"),
      ]);
      this.scheduler = stateResponse.ok ? ((await stateResponse.json()) as SchedulerState) : null;
      this.events = eventsResponse.ok ? ((await eventsResponse.json()) as RuntimeEvent[]) : [];
    } catch {
      this.scheduler = null;
      this.events = [];
    }
  }

  private async fetchTaskState() {
    try {
      const response = await fetch("/api/hud/task-state");
      this.taskState = response.ok ? ((await response.json()) as TaskStateData) : null;
    } catch {
      this.taskState = null;
    }
  }

  private async fetchTaskGraphValidation() {
    try {
      const response = await fetch("/api/task-graph/validation");
      this.taskGraphValidation = response.ok
        ? ((await response.json()) as TaskGraphValidationState)
        : null;
    } catch {
      this.taskGraphValidation = null;
    }
  }

  private async fetchRuntimeLoopState() {
    try {
      const response = await fetch("/api/hud/runtime-loop");
      this.runtimeLoop = response.ok ? ((await response.json()) as RuntimeLoopStateData) : null;
    } catch {
      this.runtimeLoop = null;
    }
  }

  private async fetchPromoteGateState() {
    try {
      const response = await fetch("/api/promote-gate/state");
      this.promoteGate = response.ok ? ((await response.json()) as PromoteGateStateData) : null;
    } catch {
      this.promoteGate = null;
    }
  }

  private async fetchKbState() {
    try {
      const response = await fetch("/api/kb/state");
      this.kbState = response.ok ? ((await response.json()) as KbStateData) : null;
    } catch {
      this.kbState = null;
    }
  }

  private async fetchKbSemanticPlanState() {
    try {
      const response = await fetch("/api/kb/semantic-rebuild-plan/state");
      this.kbSemanticPlan = response.ok
        ? ((await response.json()) as KbSemanticPlanStateData)
        : null;
    } catch {
      this.kbSemanticPlan = null;
    }
  }

  private async fetchKbSemanticAcceptanceState() {
    try {
      const response = await fetch("/api/kb/semantic-rebuild-plan/acceptance");
      this.kbSemanticAcceptance = response.ok
        ? ((await response.json()) as KbSemanticAcceptanceStateData)
        : null;
    } catch {
      this.kbSemanticAcceptance = null;
    }
  }

  private async fetchKbSemanticAcceptanceRecordsState() {
    try {
      const response = await fetch("/api/kb/semantic-rebuild-plan/acceptance-records");
      this.kbSemanticAcceptanceRecords = response.ok
        ? ((await response.json()) as KbSemanticAcceptanceRecordsStateData)
        : null;
    } catch {
      this.kbSemanticAcceptanceRecords = null;
    }
  }

  private async fetchPolicyState() {
    try {
      const response = await fetch("/api/hud/policy-state");
      this.policy = response.ok ? ((await response.json()) as PolicyStateData) : null;
    } catch {
      this.policy = null;
    }
  }

  private agentName(agentId: unknown, displayName?: unknown): string {
    const id = typeof agentId === "string" ? agentId : "";
    return AGENT_NAME_MAP[id] ?? text(displayName, id || "未知岗位");
  }

  private renderShell(content: unknown) {
    return html`
      <div class="panel">
        <div class="header">
          <h3 class="title">OpenClaw 任务看板</h3>
          <button
            class="refresh"
            title="刷新任务看板"
            ?disabled=${this.refreshing}
            @click=${() => void this.refreshAll(true)}
          >
            刷新
          </button>
        </div>
        <div class="body">${content}</div>
        <div class="footer">上次快照：${formatRelative(this.hud?.generatedAt)}</div>
      </div>
    `;
  }

  private renderPanel() {
    if (this.hudStatus === "loading") {
      return this.renderShell(html`<div class="fallback">正在加载任务看板...</div>`);
    }
    if (this.hudStatus === "unavailable" || !this.hud) {
      return this.renderShell(html`
        <div class="fallback">
          <strong>任务看板暂不可用</strong>
          <div>${text(this.hud?.message, "task-hud-state.json 尚未生成")}</div>
        </div>
      `);
    }
    return this.renderShell(this.renderLiveData());
  }

  private renderLiveData() {
    const attention = this.hud?.attentionQueue ?? [];
    const alerts = attention.filter((item) =>
      ["critical", "error", "warning", "warn"].includes(String(item.severity ?? "").toLowerCase()),
    );
    const watchdogAlertCount = Number(this.hud?.watchdogSnapshot?.totalAlerts ?? 0);
    const globalAlertCount = Number(this.hud?.globalStatus?.alertCount ?? 0);
    const alertCount = Math.max(alerts.length, watchdogAlertCount, globalAlertCount);
    const reviews = [
      ...attention.filter((item) => item.needsReview === true),
      ...(this.hud?.returnInbox?.pendingItems ?? []).map((item) => ({
        taskId: item.taskId ?? item.returnId,
        reason: item.summary ?? "回收单待验收",
        severity: "warning",
        createdAt: item.createdAt,
        needsReview: true,
      })),
    ];
    const runningTasks = this.hud?.activeTasks?.filter((task) => task.status === "running") ?? [];
    const status = this.hud?.globalStatus?.status ?? "unknown";

    return html`
      <div class="status">
        <div class="status-line">
          <span class="dot ${statusClass(status)}"></span>
          <span class="primary">${labelStatus(status)} · 运行态</span>
        </div>
        <div class="counts">
          <span><strong>${runningTasks.length}</strong> 运行</span>
          <span><strong>${reviews.length}</strong> 验收</span>
          <span><strong>${alertCount}</strong> 警告</span>
        </div>
      </div>

      ${this.renderAgents(this.hud?.agentGroups ?? [])} ${this.renderActiveTasks(runningTasks)}
      ${this.renderReviews(reviews)} ${this.renderReturnConsumerPlan()}
      ${this.renderReturnDiagnosis()} ${this.renderSafetyControl()} ${this.renderWatchdog()}
      ${this.renderTaskGraphs(this.hud?.taskGraphs?.items ?? [])}
      ${this.renderRecentCompletions(this.hud?.recentCompletions?.items ?? [])}
      ${this.renderScheduler()} ${this.renderRuntimeLoop()} ${this.renderTaskState()}
      ${this.renderObserveLayer()} ${this.renderPromoteGate()} ${this.renderKnowledgeBase()}
      ${this.renderPolicy()} ${this.renderWarnings()}
    `;
  }

  private renderAgents(agents: AgentState[]) {
    return html`
      <section class="section">
        <h4 class="section-title">岗位状态</h4>
        ${agents.length === 0
          ? html`<div class="empty">暂无岗位状态</div>`
          : html`
              <div class="grid">
                ${agents.map((agent) => {
                  const progress = Math.max(0, Math.min(100, Number(agent.progressPct ?? 0)));
                  return html`
                    <div class="card">
                      <div class="status-line">
                        <span class="dot ${statusClass(agent.status)}"></span>
                        <span class="name"
                          >${this.agentName(agent.agentId, agent.displayName)}</span
                        >
                        <span class="badge"
                          >${ROLE_LABELS[text(agent.role, "")] ?? text(agent.role, "岗位")}</span
                        >
                      </div>
                      <div class="meta">
                        ${agent.source === "configured"
                          ? "待接入"
                          : html`${labelStatus(agent.status)} · 真实状态 ·
                            ${formatRelative(agent.lastProgressAt)}`}
                      </div>
                      <div
                        class="secondary"
                        title=${text(agent.currentTaskTitle ?? agent.currentTask, "暂无任务")}
                      >
                        ${truncate(agent.currentTaskTitle ?? agent.currentTask)}
                      </div>
                      <div class="progress-track">
                        <div class="progress" style=${`width:${progress}%`}></div>
                      </div>
                    </div>
                  `;
                })}
              </div>
            `}
      </section>
    `;
  }

  private renderActiveTasks(tasks: ActiveTask[]) {
    return html`
      <section class="section">
        <h4 class="section-title">运行任务</h4>
        ${tasks.length === 0
          ? html`<div class="empty">暂无运行任务</div>`
          : tasks.slice(0, 6).map(
              (task) => html`
                <div class="row">
                  <div>
                    <div class="primary">${truncate(task.taskTitle ?? task.taskId)}</div>
                    <div class="secondary">
                      ${text(task.agentId, "未知岗位")} · ${labelStatus(task.status)}
                    </div>
                  </div>
                  <span class="badge">${Math.round(Number(task.progressPct ?? 0))}%</span>
                </div>
              `,
            )}
      </section>
    `;
  }

  private renderReviews(items: AttentionItem[]) {
    return html`
      <section class="section">
        <h4 class="section-title">待验收</h4>
        ${items.length === 0
          ? html`<div class="empty">暂无待验收事项</div>`
          : items.slice(0, 6).map(
              (item) => html`
                <div class="row">
                  <div>
                    <div class="primary">${truncate(item.reason ?? item.taskId ?? item.id)}</div>
                    <div class="secondary">
                      ${text(item.taskId ?? item.id, "未知任务")} ·
                      ${formatRelative(item.createdAt)}
                    </div>
                  </div>
                  <span class="badge">${labelStatus(item.severity)}</span>
                </div>
              `,
            )}
      </section>
    `;
  }

  private renderReturnConsumerPlan() {
    const plan = this.hud?.returnConsumerPlan;
    if (!plan || Number(plan.totalCount ?? 0) <= 0) return nothing;
    const reasons = plan.byReason ?? [];
    const constraints = plan.constraintsVerified ?? {};
    return html`
      <section class="section">
        <h4 class="section-title">回执消费计划</h4>
        <div class="row">
          <div>
            <div class="primary">${text(plan.mode, "observe-only")}</div>
            <div class="secondary">
              总数 ${plan.totalCount ?? 0} · 可消费 ${plan.processCount ?? 0} · 跳过
              ${plan.skipCount ?? 0} · 警告 ${plan.warningCount ?? 0}
            </div>
            ${reasons.length > 0
              ? html`
                  <details class="details">
                    <summary>查看跳过原因</summary>
                    ${reasons.slice(0, 5).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            ${text(item.reason, "unknown")} · ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
            <details class="details">
              <summary>查看消费约束</summary>
              ${[
                ["consumed", constraints.consumed],
                ["archived", constraints.archived],
                ["receiptWritten", constraints.receiptWritten],
                ["taskGraphMutated", constraints.taskGraphMutated],
                ["applied", constraints.applied],
              ].map(
                ([label, value]) => html`
                  <div class="issue">
                    <div class="secondary">${label} · ${text(value, "unknown")}</div>
                  </div>
                `,
              )}
            </details>
          </div>
          <span class="badge">只读</span>
        </div>
      </section>
    `;
  }

  private renderReturnDiagnosis() {
    const diagnosis = this.hud?.returnDiagnosis;
    if (!diagnosis || Number(diagnosis.totalCount ?? 0) <= 0) return nothing;
    const compatibility = diagnosis.byCompatibility ?? [];
    const actions = diagnosis.bySuggestedAction ?? [];
    const issueCodes = diagnosis.byIssueCode ?? [];
    const constraints = diagnosis.constraintsVerified ?? {};
    return html`
      <section class="section">
        <h4 class="section-title">Return diagnosis</h4>
        <div class="row">
          <div>
            <div class="primary">${text(diagnosis.mode, "observe-only")}</div>
            <div class="secondary">
              total ${diagnosis.totalCount ?? 0} 路 diagnosable ${diagnosis.diagnosableCount ?? 0}
              路 warnings ${diagnosis.warningCount ?? 0}
            </div>
            ${compatibility.length > 0
              ? html`
                  <details class="details">
                    <summary>view compatibility</summary>
                    ${compatibility.slice(0, 5).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            ${text(item.compatibility, "unknown")} 路 ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
            ${actions.length > 0
              ? html`
                  <details class="details">
                    <summary>view suggested actions</summary>
                    ${actions.slice(0, 5).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            ${text(item.action, "unknown")} 路 ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
            ${issueCodes.length > 0
              ? html`
                  <details class="details">
                    <summary>view issue codes</summary>
                    ${issueCodes.slice(0, 6).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            ${text(item.code, "unknown")} 路 ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
            <details class="details">
              <summary>view diagnosis constraints</summary>
              ${[
                ["returnConsumed", constraints.returnConsumed],
                ["archived", constraints.archived],
                ["receiptWritten", constraints.receiptWritten],
                ["taskGraphMutated", constraints.taskGraphMutated],
                ["applied", constraints.applied],
              ].map(
                ([label, value]) => html`
                  <div class="issue">
                    <div class="secondary">${label} 路 ${text(value, "unknown")}</div>
                  </div>
                `,
              )}
            </details>
          </div>
          <span class="badge">D5</span>
        </div>
      </section>
    `;
  }

  private renderSafetyControl() {
    const control = this.hud?.controlSignals;
    const recovery = this.hud?.recoveryCandidates;
    const promotion = this.hud?.promotionCandidates;
    const scheduler = this.hud?.schedulerTickPlan;
    if (!control && !recovery && !promotion && !scheduler) return nothing;

    const controlConstraints = control?.constraintsVerified ?? {};
    const recoveryConstraints = recovery?.constraintsVerified ?? {};
    const promotionConstraints = promotion?.constraintsVerified ?? {};
    const schedulerConstraints = scheduler?.constraintsVerified ?? {};
    const roleEntries = control?.byRole ?? [];
    const actionEntries = control?.byAction ?? [];
    const recoveryStatusEntries = recovery?.byStatus ?? [];
    const recoveryActionEntries = recovery?.bySuggestedAction ?? [];
    const promotionStateEntries = Object.entries(promotion?.stats?.byState ?? {});
    const promotionConsistencyEntries = Object.entries(promotion?.stats?.byConsistency ?? {});
    const promotionConsistencyIssueCount = promotionConsistencyEntries.reduce(
      (sum, [key, count]) => (key === "ok" ? sum : sum + Math.max(0, Number(count) || 0)),
      0,
    );
    return html`
      <section class="section">
        <h4 class="section-title">安全控制</h4>
        <div class="row">
          <div>
            <div class="primary">
              ${control?.frozen || recovery?.frozen ? "冻结生效" : "只读观察"} ·
              ${text(control?.mode ?? recovery?.mode, "observe-only")}
            </div>
            <div class="secondary">
              signals ${control?.pendingCount ?? 0} · valid ${control?.validCount ?? 0} · invalid
              ${control?.invalidCount ?? 0} · recovery ${recovery?.candidateCount ?? 0}
            </div>
            <div class="secondary">
              graphs ${recovery?.graphCount ?? 0} · errors
              ${(control?.errorCount ?? 0) +
              (recovery?.errorCount ?? 0) +
              (promotion?.errorCount ?? 0)}
              · G2 ${control?.g2Approved ? "approved" : "locked"}
            </div>
            <div class="secondary">
              promotion ${promotion?.stats?.total ?? 0} · invalid ${promotion?.stats?.invalid ?? 0}
              · consistency ${promotionConsistencyIssueCount}
            </div>
            <div class="secondary">
              scheduler ${text(scheduler?.decision, "disabled")} · tick
              ${scheduler?.nextTickIndex ?? "none"} · warnings ${scheduler?.warningCount ?? 0}
            </div>
            <details class="details">
              <summary>查看安全约束</summary>
              ${[
                ["control.readOnly", controlConstraints.readOnly],
                ["control.taskGraphMutated", controlConstraints.taskGraphMutated],
                ["control.sessionsSent", controlConstraints.sessionsSent],
                ["control.applied", controlConstraints.applied],
                ["recovery.readOnly", recoveryConstraints.readOnly],
                ["recovery.taskGraphMutated", recoveryConstraints.taskGraphMutated],
                ["recovery.autoDispatchTriggered", recoveryConstraints.autoDispatchTriggered],
                ["recovery.applied", recoveryConstraints.applied],
                ["promotion.readOnly", promotionConstraints.readOnly],
                ["promotion.candidateStateWritten", promotionConstraints.candidateStateWritten],
                ["promotion.truthFilesWritten", promotionConstraints.truthFilesWritten],
                ["promotion.autoPromote", promotionConstraints.autoPromote],
                ["scheduler.readOnly", schedulerConstraints.readOnly],
                ["scheduler.scriptInvoked", schedulerConstraints.scriptInvoked],
                ["scheduler.childProcessSpawned", schedulerConstraints.childProcessSpawned],
                ["scheduler.autoDispatchTriggered", schedulerConstraints.autoDispatchTriggered],
                ["scheduler.applied", schedulerConstraints.applied],
              ].map(
                ([label, value]) => html`
                  <div class="issue">
                    <div class="secondary">${label} · ${text(value, "unknown")}</div>
                  </div>
                `,
              )}
            </details>
            ${roleEntries.length +
              actionEntries.length +
              recoveryStatusEntries.length +
              recoveryActionEntries.length +
              promotionStateEntries.length +
              promotionConsistencyEntries.length >
            0
              ? html`
                  <details class="details">
                    <summary>查看分布</summary>
                    ${roleEntries.slice(0, 4).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            role ${text(item.role, "unknown")} · ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                    ${actionEntries.slice(0, 4).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            signal ${text(item.action, "unknown")} · ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                    ${recoveryStatusEntries.slice(0, 4).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            status ${text(item.status, "unknown")} · ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                    ${recoveryActionEntries.slice(0, 4).map(
                      (item) => html`
                        <div class="issue">
                          <div class="secondary">
                            recovery ${text(item.action, "unknown")} · ${item.count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                    ${promotionStateEntries.slice(0, 4).map(
                      ([state, count]) => html`
                        <div class="issue">
                          <div class="secondary">
                            promotion state ${text(state, "unknown")} · ${count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                    ${promotionConsistencyEntries.slice(0, 4).map(
                      ([state, count]) => html`
                        <div class="issue">
                          <div class="secondary">
                            promotion consistency ${text(state, "unknown")} · ${count ?? 0}
                          </div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
          </div>
          <span class="badge">${control?.frozen || recovery?.frozen ? "冻结" : "只读"}</span>
        </div>
      </section>
    `;
  }

  private renderWatchdog() {
    const snapshot = this.hud?.watchdogSnapshot;
    const entries = Object.entries(snapshot?.byCondition ?? {})
      .filter(([, count]) => Number(count) > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    if (!snapshot || (Number(snapshot.totalAlerts ?? 0) <= 0 && entries.length === 0)) {
      return nothing;
    }
    return html`
      <section class="section">
        <h4 class="section-title">健康巡检</h4>
        <div class="row">
          <div>
            <div class="primary">警告 ${snapshot.totalAlerts ?? 0}</div>
            <div class="secondary">健康岗位 ${snapshot.healthyCount ?? 0}</div>
          </div>
          <span class="badge">watchdog</span>
        </div>
        ${entries.slice(0, 6).map(
          ([condition, count]) => html`
            <div class="row">
              <div class="primary">${condition}</div>
              <span class="badge">${count}</span>
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderObserveLayer() {
    const mirror = this.hud?.mirrorObserve;
    const evolution = this.hud?.autoEvolutionObserve;
    if (!mirror?.available && !evolution?.available) return nothing;
    return html`
      <section class="section">
        <h4 class="section-title">观察层</h4>
        ${mirror?.available
          ? html`
              <div class="row">
                <div>
                  <div class="primary">Mirror Observe</div>
                  <div class="secondary">
                    observations ${mirror.stats?.observationCount ?? 0} · findings
                    ${mirror.stats?.findingCount ?? 0} · attention
                    ${mirror.stats?.bySeverity?.attention ?? 0}
                  </div>
                  <div class="secondary">
                    ${text(mirror.mirrorId, mirror.reportPath ?? "unknown")}
                  </div>
                  <details class="details">
                    <summary>查看 Mirror 约束</summary>
                    ${Object.entries(mirror.constraintsVerified ?? {})
                      .slice(0, 6)
                      .map(
                        ([label, value]) => html`
                          <div class="issue">
                            <div class="secondary">${label} · ${text(value, "unknown")}</div>
                          </div>
                        `,
                      )}
                  </details>
                </div>
                <span class="badge">${text(mirror.mode, "observe-only")}</span>
              </div>
            `
          : nothing}
        ${evolution?.available
          ? html`
              <div class="row">
                <div>
                  <div class="primary">Auto-Evolution Observe</div>
                  <div class="secondary">
                    suggestions ${evolution.stats?.totalSuggestions ?? 0} · P0
                    ${evolution.stats?.byPriority?.P0 ?? 0} · P1
                    ${evolution.stats?.byPriority?.P1 ?? 0}
                  </div>
                  <div class="secondary">
                    mirror ${evolution.stats?.bySource?.mirror ?? 0} · promote
                    ${evolution.stats?.bySource?.promote_gate ?? 0} · hud
                    ${evolution.stats?.bySource?.hud ?? 0}
                  </div>
                  <details class="details">
                    <summary>查看 Evolution 约束</summary>
                    ${Object.entries(evolution.constraintsVerified ?? {})
                      .slice(0, 6)
                      .map(
                        ([label, value]) => html`
                          <div class="issue">
                            <div class="secondary">${label} · ${text(value, "unknown")}</div>
                          </div>
                        `,
                      )}
                  </details>
                </div>
                <span class="badge">${text(evolution.mode, "observe-only")}</span>
              </div>
            `
          : nothing}
      </section>
    `;
  }

  private findTaskGraphValidation(
    graphId: string | null | undefined,
  ): TaskGraphValidationReport | null {
    if (!graphId) return null;
    return this.taskGraphValidation?.reports?.find((report) => report.graphId === graphId) ?? null;
  }

  private renderTaskGraphValidationIssues(validation: TaskGraphValidationReport | null) {
    const issues = [
      ...(validation?.errors ?? []).map((issue) => ({ ...issue, kind: "错误" })),
      ...(validation?.warnings ?? []).map((issue) => ({ ...issue, kind: "警告" })),
    ].slice(0, 4);

    if (issues.length === 0) return nothing;

    return html`
      <details class="details">
        <summary>查看验真明细</summary>
        ${issues.map(
          (issue) => html`
            <div class="issue">
              <div class="secondary">
                ${issue.kind} · ${text(issue.check, "未知检查")} · ${text(issue.field, "未知字段")}
              </div>
              <div class="secondary">${text(issue.message, "暂无说明")}</div>
            </div>
          `,
        )}
      </details>
    `;
  }

  private renderTaskGraphs(graphs: TaskGraphItem[]) {
    const validationSummary = this.taskGraphValidation;
    const returnPreview = this.hud?.taskGraphs?.returnPreview;
    const returnConstraints = returnPreview?.constraintsVerified ?? {};
    return html`
      <section class="section">
        <h4 class="section-title">任务图</h4>
        ${validationSummary?.available
          ? html`
              <div class="row">
                <div>
                  <div class="primary">任务图验真</div>
                  <div class="secondary">
                    总数 ${validationSummary.total ?? 0} · 错误
                    ${validationSummary.bySeverity?.error ?? 0} · 警告
                    ${validationSummary.bySeverity?.warning ?? 0}
                  </div>
                </div>
                <span class="badge">${validationSummary.valid ? "通过" : "需关注"}</span>
              </div>
            `
          : nothing}
        ${returnPreview
          ? html`
              <div class="row">
                <div>
                  <div class="primary">
                    return match · ${text(returnPreview.mode, "observe-only")}
                  </div>
                  <div class="secondary">
                    pending ${returnPreview.pendingReturnCount ?? 0} · matched
                    ${returnPreview.matchedNodeCount ?? 0} · unmatched
                    ${returnPreview.unmatchedReturnCount ?? 0}
                  </div>
                  <div class="secondary">
                    nodes ${returnPreview.nodeCount ?? 0} · missing
                    ${returnPreview.missingNodeCount ?? 0} · ambiguous
                    ${returnPreview.ambiguousNodeCount ?? 0}
                  </div>
                  ${(returnPreview.sampleUnmatchedReturns?.length ?? 0) > 0
                    ? html`
                        <details class="details">
                          <summary>view unmatched returns</summary>
                          ${returnPreview.sampleUnmatchedReturns?.slice(0, 4).map(
                            (item) => html`
                              <div class="issue">
                                <div class="secondary">
                                  ${truncate(item.returnId, 42)} ·
                                  ${text(item.taskId, "missing taskId")} ·
                                  ${text(item.reason, "unknown")}
                                </div>
                              </div>
                            `,
                          )}
                        </details>
                      `
                    : nothing}
                  <details class="details">
                    <summary>view return match constraints</summary>
                    ${[
                      ["graphMutated", returnConstraints.graphMutated],
                      ["returnConsumed", returnConstraints.returnConsumed],
                      ["receiptWritten", returnConstraints.receiptWritten],
                      ["dispatchTriggered", returnConstraints.dispatchTriggered],
                      ["applied", returnConstraints.applied],
                    ].map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">${label} · ${text(value, "unknown")}</div>
                        </div>
                      `,
                    )}
                  </details>
                </div>
                <span class="badge">
                  ${(returnPreview.unmatchedReturnCount ?? 0) > 0 ? "needs match" : "matched"}
                </span>
              </div>
            `
          : nothing}
        ${graphs.length === 0
          ? html`<div class="empty">暂无任务图</div>`
          : graphs.slice(0, 4).map((graph) => {
              const validation = this.findTaskGraphValidation(graph.graphId);
              const severity = validation?.severity ?? graph.validationSeverity ?? null;
              const issueCount =
                (validation?.errors?.length ?? 0) + (validation?.warnings?.length ?? 0);
              const validatedAt = validation?.checkedAt ?? graph.lastValidatedAt;
              return html`
                <div class="row">
                  <div>
                    <div class="primary">${truncate(graph.title ?? graph.graphId)}</div>
                    <div class="secondary">
                      总数 ${graph.nodeSummary?.total ?? 0} · 完成
                      ${graph.nodeSummary?.completed ?? 0} · 阻塞 ${graph.nodeSummary?.blocked ?? 0}
                    </div>
                    <div class="secondary">
                      验真 ${severity ? labelStatus(severity) : "暂无"} · 问题 ${issueCount} ·
                      ${formatRelative(validatedAt)}
                    </div>
                    ${this.renderTaskGraphValidationIssues(validation)}
                  </div>
                  <span class="badge">${labelStatus(graph.aggregateStatus)}</span>
                </div>
              `;
            })}
      </section>
    `;
  }

  private renderRecentCompletions(items: RecentCompletionItem[]) {
    return html`
      <section class="section">
        <h4 class="section-title">今日完成</h4>
        ${items.length === 0
          ? html`<div class="empty">暂无完成记录</div>`
          : items.slice(0, 5).map(
              (item) => html`
                <div class="row">
                  <div>
                    <div class="primary">${truncate(item.taskId)}</div>
                    <div class="secondary">${formatRelative(item.completedAt)}</div>
                  </div>
                  <span class="badge">${item.level} · ${labelStatus(item.status)}</span>
                </div>
              `,
            )}
      </section>
    `;
  }

  private renderScheduler() {
    return html`
      <section class="section">
        <h4 class="section-title">调度器</h4>
        <div class="row">
          <div>
            <div class="primary">
              ${this.scheduler?.enabled ? "已启用" : "未启用"} ·
              ${labelStatus(this.scheduler?.status)}
            </div>
            <div class="secondary">
              模式 ${text(this.scheduler?.mode, "observe")} · tick
              ${this.scheduler?.totalTicks ?? 0} · 跳过
              ${this.scheduler?.skippedBecauseRunning ?? 0}
            </div>
          </div>
          <span class="badge">${this.scheduler?.running ? "运行中" : "空闲"}</span>
        </div>
        ${this.events.slice(0, 3).map(
          (event) => html`
            <div class="row">
              <div>
                <div class="primary">${truncate(event.eventType)}</div>
                <div class="secondary">${text(event.source, "未知来源")}</div>
              </div>
              <span class="badge">${formatRelative(event.timestamp)}</span>
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderRuntimeLoop() {
    const data = this.runtimeLoop?.data ?? null;
    const warnings = data?.warnings ?? [];
    return html`
      <section class="section">
        <h4 class="section-title">运行态总线</h4>
        <div class="row">
          <div>
            <div class="primary">
              ${data ? "快照可用" : "暂无快照"} · ${text(data?.mode, "observe")}
            </div>
            <div class="secondary">
              dispatch ${data?.dispatch_plan_count ?? 0} · inbox ${data?.inbox_count ?? 0} · 警告
              ${warnings.length}
            </div>
            <div class="secondary">
              freshness ${text(data?.freshness?.status, "unknown")} · age
              ${Math.floor(Number(data?.freshness?.ageMs ?? 0) / 60_000)}m
            </div>
            ${warnings.length > 0
              ? html`
                  <details class="details">
                    <summary>查看总线警告</summary>
                    ${warnings.slice(0, 4).map(
                      (warning) => html`
                        <div class="issue">
                          <div class="secondary">${text(warning, "未知警告")}</div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
          </div>
          <span class="badge">${formatRelative(data?.latest_tick_at)}</span>
        </div>
      </section>
    `;
  }

  private renderTaskState() {
    const summary = this.taskState?.summary;
    return html`
      <section class="section">
        <h4 class="section-title">任务台账</h4>
        <div class="secondary section-note">历史任务统计，不代表当前运行岗位数</div>
        <div class="grid">
          ${[
            ["总数", summary?.total ?? 0],
            ["排队", summary?.queued ?? 0],
            ["完成", summary?.completed ?? 0],
            ["失败", summary?.failed ?? 0],
            ["阻塞", summary?.blocked ?? 0],
            ["隔离", summary?.quarantined ?? 0],
          ].map(
            ([label, value]) => html`
              <div class="card">
                <div class="primary">${value}</div>
                <div class="secondary">${label}</div>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderPromoteGate() {
    const state = this.promoteGate;
    const stats = state?.stats;
    const byVerdict = stats?.byVerdict ?? {};
    const byType = stats?.byType ?? {};
    const constraints = state?.constraintsVerified ?? {};
    const verdictEntries = Object.entries(byVerdict)
      .filter(([, value]) => value > 0)
      .slice(0, 5);
    const typeEntries = Object.entries(byType)
      .filter(([, value]) => value > 0)
      .slice(0, 5);
    const readyCount = byVerdict.READY_FOR_PROMOTE_GATE ?? 0;
    const waitingCount =
      (byVerdict.WAITING_REVIEW ?? 0) +
      (byVerdict.NEEDS_EVIDENCE ?? 0) +
      (byVerdict.WAITING_SEPARATE_ENGINEERING_RULE_APPROVAL ?? 0);
    const blockedCount = (byVerdict.BLOCKED ?? 0) + (byVerdict.FROZEN_BLOCKED ?? 0);
    return html`
      <section class="section">
        <h4 class="section-title">蒸馏闸口</h4>
        <div class="row">
          <div>
            <div class="primary">
              ${state?.available ? "报告可用" : "暂无报告"} · ${text(state?.mode, "dry-run")}
            </div>
            <div class="secondary">
              候选 ${stats?.total ?? 0} · 就绪 ${readyCount} · 待审 ${waitingCount} · 阻塞
              ${blockedCount}
            </div>
            ${state?.available
              ? html`
                  <details class="details">
                    <summary>查看闸口约束</summary>
                    ${[
                      ["MEMORY", constraints.MEMORYWritten],
                      ["ENGINEERING_RULES", constraints.ENGINEERING_RULESWritten],
                      ["promoted", constraints.promoted],
                      ["autoPromote", constraints.autoPromote],
                    ].map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">${label} · ${text(value, "未知")}</div>
                        </div>
                      `,
                    )}
                  </details>
                  <details class="details">
                    <summary>查看判定明细</summary>
                    ${verdictEntries.map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">判定 ${label} · ${value}</div>
                        </div>
                      `,
                    )}
                    ${typeEntries.map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">类型 ${label} · ${value}</div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
          </div>
          <span class="badge">${state?.frozenActive ? "冻结" : "只读"}</span>
        </div>
      </section>
    `;
  }

  private renderKnowledgeBase() {
    const state = this.kbState;
    const semantic = state?.semantic;
    const plan = this.kbSemanticPlan;
    const planConstraints = plan?.constraintsVerified ?? {};
    const acceptance = this.kbSemanticAcceptance;
    const acceptanceGate = acceptance?.acceptance;
    const acceptanceConstraints = acceptance?.constraintsVerified ?? {};
    const acceptanceRecords = this.kbSemanticAcceptanceRecords;
    const acceptanceRecordItems = acceptanceRecords?.records ?? [];
    return html`
      <section class="section">
        <h4 class="section-title">知识库</h4>
        <div class="row">
          <div>
            <div class="primary">${state?.available ? "索引可用" : "暂无索引"} · keyword</div>
            <div class="secondary">
              条目 ${state?.totalItems ?? 0} · 案例 ${state?.sourceCaseCount ?? 0} · 技能
              ${state?.sourceSkillCount ?? 0} · 关键词 ${state?.keywordCount ?? 0}
            </div>
            <div class="secondary">
              语义 ${text(semantic?.status, "default")} · ${text(semantic?.mode, "observe-only")} ·
              向量重建 ${text(semantic?.rebuild, "disabled")}
            </div>
            <div class="secondary">
              语义计划 ${plan?.available ? text(plan.status, "ready") : "暂无"} · batch
              ${plan?.plannedBatches ?? 0} · ${formatRelative(plan?.generatedAt)}
            </div>
            <div class="secondary">
              semantic gate ${text(acceptanceGate?.status, "missing")} / human gate
              ${acceptanceGate?.readyForHumanGate ? "ready" : "blocked"}
            </div>
            <div class="secondary">
              semantic records
              ${acceptanceRecords?.returnedRecords ?? 0}/${acceptanceRecords?.totalRecords ?? 0} /
              invalid ${acceptanceRecords?.invalidRecords ?? 0}
            </div>
            ${plan?.available
              ? html`
                  <details class="details">
                    <summary>查看语义 dry-run 约束</summary>
                    ${[
                      ["embedding", planConstraints.embeddingCalls],
                      ["report", planConstraints.dryRunReportWritten],
                      ["fileWrites", planConstraints.fileWrites],
                      ["vectorIndex", planConstraints.vectorIndexWritten],
                      ["applied", planConstraints.applied],
                    ].map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">${label} · ${text(value, "未知")}</div>
                        </div>
                      `,
                    )}
                    ${(plan.blockedReasons ?? []).slice(0, 3).map(
                      (reason) => html`
                        <div class="issue">
                          <div class="secondary">blocked · ${text(reason, "未知")}</div>
                        </div>
                      `,
                    )}
                  </details>
                `
              : nothing}
            ${acceptance
              ? html`
                  <details class="details">
                    <summary>semantic acceptance dry-run</summary>
                    ${[
                      ["recordWritten", acceptanceConstraints.recordWritten],
                      ["stateWritten", acceptanceConstraints.stateWritten],
                      ["embedding", acceptanceConstraints.embeddingCalls],
                      ["vectorIndex", acceptanceConstraints.vectorIndexWritten],
                      ["realRebuild", acceptanceConstraints.realRebuildTriggered],
                      ["applied", acceptanceConstraints.applied],
                    ].map(
                      ([label, value]) => html`
                        <div class="issue">
                          <div class="secondary">${label} / ${text(value, "unknown")}</div>
                        </div>
                      `,
                    )}
                    ${(acceptanceGate?.blockReasons ?? []).slice(0, 3).map(
                      (reason) => html`
                        <div class="issue">
                          <div class="secondary">blocked / ${text(reason, "unknown")}</div>
                        </div>
                      `,
                    )}
                    ${acceptance.recordPreview
                      ? html`
                          <div class="issue">
                            <div class="secondary">
                              nextAction / ${text(acceptance.recordPreview.nextAction, "unknown")}
                            </div>
                          </div>
                        `
                      : nothing}
                  </details>
                `
              : nothing}
            ${acceptanceRecordItems.length > 0
              ? html`
                  <details class="details">
                    <summary>semantic acceptance records</summary>
                    ${acceptanceRecordItems.slice(0, 3).map(
                      (record) => html`
                        <div class="issue">
                          <div class="secondary">
                            ${text(record.status, "unknown")} /
                            ${text(record.proposalId, "unknown")}
                          </div>
                          <div class="secondary">
                            nextAction / ${text(record.nextAction, "unknown")} / realRebuild
                            ${text(record.constraintsVerified?.realRebuildTriggered, "unknown")}
                          </div>
                        </div>
                      `,
                    )}
                    ${acceptanceRecords?.constraintsVerified
                      ? html`
                          <div class="issue">
                            <div class="secondary">
                              list fileWrites /
                              ${text(acceptanceRecords.constraintsVerified.fileWrites, "unknown")}
                            </div>
                          </div>
                        `
                      : nothing}
                  </details>
                `
              : nothing}
          </div>
          <span class="badge">${text(semantic?.provider, formatRelative(state?.generatedAt))}</span>
        </div>
      </section>
    `;
  }

  private renderPolicy() {
    return html`
      <section class="section">
        <h4 class="section-title">策略闸口</h4>
        <div class="row">
          <div>
            <div class="primary">
              规则 ${this.policy?.enabledCount ?? 0}/${this.policy?.rulesCount ?? 0}
            </div>
            <div class="secondary">
              版本 ${text(this.policy?.policyVersion, "未加载")} ·
              ${formatRelative(this.policy?.lastEvaluation)}
            </div>
          </div>
          <span class="badge">只读</span>
        </div>
        ${(this.policy?.recentDecisions ?? []).slice(0, 3).map(
          (decision) => html`
            <div class="row">
              <div>
                <div class="primary">${truncate(decision.taskId ?? decision.reason)}</div>
                <div class="secondary">${text(decision.reason, "无说明")}</div>
              </div>
              <span class="badge">${text(decision.riskLevel ?? decision.action, "未知")}</span>
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderWarnings() {
    const warnings = this.hud?.warnings ?? [];
    if (warnings.length === 0) return nothing;
    return html`
      <section class="section">
        <h4 class="section-title">警告</h4>
        ${warnings.slice(0, 5).map(
          (warning) => html`
            <div class="row">
              <div class="primary">${truncate(warning, 64)}</div>
              <span class="badge">警告</span>
            </div>
          `,
        )}
      </section>
    `;
  }

  override render() {
    const status =
      this.hud?.globalStatus?.status ?? (this.hudStatus === "unavailable" ? "warning" : "idle");
    return html`
      <button
        class="toggle ${this.panelOpen ? "active" : ""}"
        title="打开任务看板"
        @click=${() => {
          this.panelOpen = !this.panelOpen;
        }}
      >
        看板
      </button>
      <span class="dot ${statusClass(status)}" aria-hidden="true"></span>
      ${this.panelOpen ? this.renderPanel() : nothing}
    `;
  }
}
