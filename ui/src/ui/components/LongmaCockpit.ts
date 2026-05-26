import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { icons } from "../icons.ts";

type HudAgent = {
  agentId?: string;
  displayName?: string | null;
  role?: string;
  status?: string;
  source?: string;
};

type HudState = {
  generatedAt?: string;
  globalStatus?: {
    status?: string;
    runningCount?: number;
    pendingReviewCount?: number;
    alertCount?: number;
  };
  agentGroups?: HudAgent[];
  returnRepairDryRun?: {
    candidateCount?: number;
    repairableCount?: number;
    packagePreviewAvailableCount?: number;
  };
  returnReconciliationApplyPlan?: {
    status?: string;
    readyStepCount?: number;
    stepCount?: number;
  };
  positionConfigAudit?: {
    configuredOnlyPositions?: string[];
  };
  positionConfigCleanupGate?: {
    status?: string;
    applyBlockedReason?: string | null;
  };
  semanticRebuild?: {
    stage?: string;
    executionStatus?: string | null;
  };
  controlSignals?: {
    status?: string;
    frozen?: boolean;
    pendingCount?: number;
    invalidCount?: number;
  };
  recoveryCandidates?: {
    candidateCount?: number;
    errorCount?: number;
  };
  mirrorObserve?: {
    status?: string;
  };
  autoEvolutionObserve?: {
    status?: string;
  };
};

type ChatEntry = {
  speaker: "user" | "system";
  text: string;
};

const CORE_PARTICLE_COUNT = 260;

const DOCK_ITEMS: Array<{ id: string; label: string; icon: TemplateResult; status: string }> = [
  { id: "chat", label: "对话", icon: icons.messageSquare, status: "ready" },
  { id: "voice", label: "语音", icon: icons.mic, status: "reserved" },
  { id: "vision", label: "视觉", icon: icons.image, status: "reserved" },
  { id: "memory", label: "记忆", icon: icons.book, status: "linked" },
  { id: "skills", label: "技能", icon: icons.puzzle, status: "observe" },
  { id: "devices", label: "设备", icon: icons.smartphone, status: "planned" },
];

function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toneForStatus(status: string | undefined): "ok" | "warn" | "hot" | "idle" {
  switch (status) {
    case "healthy":
    case "applied":
    case "ready":
    case "completed":
      return "ok";
    case "attention_required":
    case "blocked":
    case "frozen":
      return "warn";
    case "failed":
    case "error":
      return "hot";
    default:
      return "idle";
  }
}

function agentLabel(agent: HudAgent): string {
  return text(agent.displayName, text(agent.agentId, "agent"));
}

@customElement("longma-cockpit")
export class LongmaCockpit extends LitElement {
  @state() private open = false;
  @state() private chatOpen = false;
  @state() private hud: HudState | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private draft = "";
  @state() private chatEntries: ChatEntry[] = [];
  @query(".core-canvas") private coreCanvas?: HTMLCanvasElement;

  private frameHandle = 0;
  private refreshHandle = 0;
  private pointerX = 0;
  private pointerY = 0;
  private coreScale = 1;

  connectedCallback() {
    super.connectedCallback();
    void this.refreshHud();
  }

  disconnectedCallback() {
    window.cancelAnimationFrame(this.frameHandle);
    window.clearInterval(this.refreshHandle);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("open")) {
      if (this.open) {
        void this.refreshHud();
        this.startCore();
        window.clearInterval(this.refreshHandle);
        this.refreshHandle = window.setInterval(() => void this.refreshHud(), 15_000);
      } else {
        window.cancelAnimationFrame(this.frameHandle);
        window.clearInterval(this.refreshHandle);
      }
    }
  }

  private async refreshHud() {
    this.loading = true;
    try {
      const response = await fetch("/api/hud/state");
      if (!response.ok) throw new Error(`HUD ${response.status}`);
      this.hud = (await response.json()) as HudState;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private startCore() {
    window.cancelAnimationFrame(this.frameHandle);
    const draw = (timestamp: number) => {
      this.drawCore(timestamp);
      if (this.open) this.frameHandle = window.requestAnimationFrame(draw);
    };
    this.frameHandle = window.requestAnimationFrame(draw);
  }

  private drawCore(timestamp: number) {
    const canvas = this.coreCanvas;
    if (!canvas) return;

    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const agentEnergy = Math.min(1, (this.hud?.agentGroups?.length ?? 0) / 8);
    const reviewEnergy = Math.min(1, count(this.hud?.globalStatus?.pendingReviewCount) / 8);
    const alertEnergy = Math.min(1, count(this.hud?.globalStatus?.alertCount) / 12);
    const t = timestamp / 1000;
    const radius = Math.min(rect.width, rect.height) * 0.2 * this.coreScale;

    context.globalCompositeOperation = "lighter";
    for (let index = 0; index < CORE_PARTICLE_COUNT; index += 1) {
      const seed = index * 10.917;
      const layer = index % 6;
      const wave = Math.sin(t * (0.55 + layer * 0.06) + seed) * 0.5 + 0.5;
      const angle = index * 2.399963 + t * (0.08 + reviewEnergy * 0.04) + this.pointerX * 0.35;
      const spread = radius * (0.38 + layer * 0.2 + wave * 0.2 + agentEnergy * 0.16);
      const x = cx + Math.cos(angle) * spread * (0.8 + Math.sin(seed) * 0.18);
      const y = cy + Math.sin(angle * 1.23 + this.pointerY * 0.4) * spread * 0.78;
      const alpha = 0.24 + wave * 0.44;
      context.beginPath();
      context.fillStyle =
        layer === 0
          ? `rgba(255, 197, 92, ${alpha})`
          : layer === 1
            ? `rgba(88, 218, 255, ${alpha})`
            : layer === 2
              ? `rgba(111, 255, 193, ${alpha})`
              : `rgba(255, ${115 + Math.floor(wave * 54)}, ${132 + Math.floor(alertEnergy * 80)}, ${alpha})`;
      context.arc(x, y, 1.2 + wave * 2.6 + alertEnergy, 0, Math.PI * 2);
      context.fill();
    }

    context.globalCompositeOperation = "source-over";
    context.strokeStyle = "rgba(159, 229, 255, 0.28)";
    context.lineWidth = 1;
    for (let ring = 0; ring < 3; ring += 1) {
      context.beginPath();
      context.ellipse(
        cx,
        cy,
        radius * (1.3 + ring * 0.35),
        radius * (0.54 + ring * 0.16),
        -0.28 + ring * 0.18 + this.pointerX * 0.12,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }
  }

  private handlePointerMove(event: PointerEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.pointerX = ((event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * 2;
    this.pointerY = ((event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5) * 2;
  }

  private handleWheel(event: WheelEvent) {
    event.preventDefault();
    const next = this.coreScale + (event.deltaY > 0 ? -0.06 : 0.06);
    this.coreScale = Math.min(1.28, Math.max(0.82, next));
  }

  private submitChat(event: SubmitEvent) {
    event.preventDefault();
    const message = this.draft.trim();
    if (!message) return;
    this.chatEntries = [
      ...this.chatEntries,
      { speaker: "user", text: message },
      { speaker: "system", text: "D14 conversation layer pending" },
    ];
    this.draft = "";
  }

  private domainTelemetry() {
    const hud = this.hud;
    const returnRepair = hud?.returnRepairDryRun;
    const control = hud?.controlSignals;
    const cleanup = hud?.positionConfigCleanupGate;
    return [
      { id: "D1", label: "记忆", value: hud?.generatedAt ? "synced" : "pending", tone: "ok" },
      { id: "D2", label: "岗位", value: `${hud?.agentGroups?.length ?? 0} active`, tone: "ok" },
      {
        id: "D3",
        label: "推进",
        value: `${count(hud?.globalStatus?.runningCount)} running`,
        tone: count(hud?.globalStatus?.runningCount) > 0 ? "ok" : "idle",
      },
      {
        id: "D4",
        label: "遥测",
        value: text(hud?.globalStatus?.status, "unknown"),
        tone: toneForStatus(hud?.globalStatus?.status),
      },
      {
        id: "D5",
        label: "回执",
        value: `${returnRepair?.repairableCount ?? 0}/${returnRepair?.candidateCount ?? 0}`,
        tone: (returnRepair?.repairableCount ?? 0) > 0 ? "warn" : "ok",
      },
      {
        id: "D6",
        label: "任务图",
        value: `${count(hud?.globalStatus?.pendingReviewCount)} review`,
        tone: count(hud?.globalStatus?.pendingReviewCount) > 0 ? "warn" : "ok",
      },
      {
        id: "D7",
        label: "安全",
        value: control?.frozen ? "frozen" : text(control?.status, "observe"),
        tone: control?.frozen ? "warn" : toneForStatus(control?.status),
      },
      {
        id: "D8",
        label: "知识",
        value: text(hud?.semanticRebuild?.stage, "keyword"),
        tone: toneForStatus(hud?.semanticRebuild?.stage),
      },
      {
        id: "D9",
        label: "技能",
        value: "gate",
        tone: "idle",
      },
      {
        id: "D10",
        label: "镜像",
        value: text(hud?.mirrorObserve?.status, "observe"),
        tone: toneForStatus(hud?.mirrorObserve?.status),
      },
      {
        id: "D11",
        label: "进化",
        value: text(hud?.autoEvolutionObserve?.status, "observe"),
        tone: toneForStatus(hud?.autoEvolutionObserve?.status),
      },
      {
        id: "D12",
        label: "健康",
        value: `${count(hud?.globalStatus?.alertCount)} alerts`,
        tone: count(hud?.globalStatus?.alertCount) > 0 ? "hot" : "ok",
      },
    ] as Array<{ id: string; label: string; value: string; tone: "ok" | "warn" | "hot" | "idle" }>;
  }

  private renderLauncher() {
    const status = text(this.hud?.globalStatus?.status, "syncing");
    return html`
      <button class="cockpit-launcher" type="button" @click=${() => (this.open = true)}>
        <span class="launcher-mark">${icons.brain}</span>
        <span>
          <strong>龙马 OS</strong>
          <small>${status}</small>
        </span>
      </button>
    `;
  }

  private renderMetric(label: string, value: string | number, tone = "neutral") {
    return html`
      <div class="metric ${tone}">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
    `;
  }

  private renderAgents() {
    const agents = this.hud?.agentGroups ?? [];
    return html`
      <div class="agent-list">
        ${agents.map(
          (agent) => html`
            <div class="agent-row">
              <span class="agent-light ${text(agent.status, "unknown")}"></span>
              <span>${agentLabel(agent)}</span>
              <small>${text(agent.role, text(agent.source, "source"))}</small>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderDomains() {
    return html`
      <div class="domain-grid">
        ${this.domainTelemetry().map(
          (domain) => html`
            <button class="domain-pill ${domain.tone}" type="button">
              <strong>${domain.id}</strong>
              <span>${domain.label}</span>
              <small>${domain.value}</small>
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderDock() {
    return html`
      <div class="dock" role="toolbar" aria-label="Longma capabilities">
        ${DOCK_ITEMS.map(
          (item) => html`
            <button
              class=${item.id === "chat" && this.chatOpen ? "dock-item active" : "dock-item"}
              type="button"
              title=${item.label}
              @click=${() => {
                if (item.id === "chat") this.chatOpen = !this.chatOpen;
              }}
            >
              ${item.icon}
              <span>${item.label}</span>
              <small>${item.status}</small>
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderChat() {
    return html`
      <aside class=${this.chatOpen ? "chat-panel open" : "chat-panel"} aria-label="Longma chat">
        <div class="chat-head">
          <div>
            <strong>实时对话</strong>
            <span>D14</span>
          </div>
          <button
            type="button"
            class="icon-button"
            @click=${() => (this.chatOpen = false)}
            title="关闭"
          >
            ${icons.x}
          </button>
        </div>
        <div class="chat-log">
          ${this.chatEntries.length === 0
            ? html`<p class="chat-empty">龙马在线，等待输入。</p>`
            : this.chatEntries.map(
                (entry) => html`<p class=${entry.speaker === "user" ? "chat-user" : "chat-system"}>
                  ${entry.text}
                </p>`,
              )}
        </div>
        <form class="chat-form" @submit=${this.submitChat}>
          <input
            .value=${this.draft}
            @input=${(event: InputEvent) => (this.draft = (event.target as HTMLInputElement).value)}
            placeholder="对龙马说..."
          />
          <button type="submit" title="发送">${icons.send}</button>
        </form>
      </aside>
    `;
  }

  private renderCockpit() {
    const global = this.hud?.globalStatus;
    const repair = this.hud?.returnRepairDryRun;
    const applyPlan = this.hud?.returnReconciliationApplyPlan;
    const cleanup = this.hud?.positionConfigCleanupGate;
    const stale = this.hud?.positionConfigAudit?.configuredOnlyPositions ?? [];
    return html`
      <section class="cockpit" aria-label="Longma OS cockpit">
        <header class="cockpit-top">
          <div>
            <span>D13 / LONGMA OS</span>
            <h2>龙马操作舱</h2>
          </div>
          <div class="top-actions">
            ${this.error ? html`<strong class="error">${this.error}</strong>` : nothing}
            <button type="button" class="ghost" @click=${() => void this.refreshHud()}>
              ${this.loading ? "同步中" : "同步"}
            </button>
            <button
              type="button"
              class="icon-button"
              @click=${() => (this.open = false)}
              title="关闭"
            >
              ${icons.x}
            </button>
          </div>
        </header>

        <div class="cockpit-grid">
          <aside class="telemetry-panel">
            <h3>运行态</h3>
            <div class="metrics">
              ${this.renderMetric("岗位", this.hud?.agentGroups?.length ?? 0, "ok")}
              ${this.renderMetric("运行", global?.runningCount ?? 0)}
              ${this.renderMetric("待验收", global?.pendingReviewCount ?? 0, "warn")}
              ${this.renderMetric("警告", global?.alertCount ?? 0, "hot")}
            </div>
            ${this.renderAgents()}
          </aside>

          <main
            class="core-stage"
            @pointermove=${this.handlePointerMove}
            @wheel=${this.handleWheel}
          >
            <canvas class="core-canvas" aria-hidden="true"></canvas>
            <div class="core-readout">
              <span>INTELLIGENCE CORE</span>
              <strong>${text(global?.status, "syncing")}</strong>
              <small
                >${this.hud?.generatedAt
                  ? new Date(this.hud.generatedAt).toLocaleTimeString()
                  : "no snapshot"}</small
              >
            </div>
          </main>

          <aside class="telemetry-panel right">
            <h3>V3 遥测</h3>
            ${this.renderDomains()}
          </aside>
        </div>

        <section class="status-strip">
          <div>
            <span>RETURN</span>
            <strong>${repair?.repairableCount ?? 0}/${repair?.candidateCount ?? 0}</strong>
            <small>preview ${repair?.packagePreviewAvailableCount ?? 0}</small>
          </div>
          <div>
            <span>APPLY</span>
            <strong>${text(applyPlan?.status, "observe")}</strong>
            <small>${applyPlan?.readyStepCount ?? 0}/${applyPlan?.stepCount ?? 0}</small>
          </div>
          <div>
            <span>POSITION</span>
            <strong>${text(cleanup?.status, "ready")}</strong>
            <small
              >${stale.length
                ? stale.join(", ")
                : text(cleanup?.applyBlockedReason, "clean")}</small
            >
          </div>
          <div>
            <span>SEMANTIC</span>
            <strong>${text(this.hud?.semanticRebuild?.stage, "keyword")}</strong>
            <small>${text(this.hud?.semanticRebuild?.executionStatus, "observe")}</small>
          </div>
        </section>

        ${this.renderDock()} ${this.renderChat()}
      </section>
    `;
  }

  protected render() {
    return html`${this.renderLauncher()} ${this.open ? this.renderCockpit() : nothing}`;
  }

  static styles = css`
    :host {
      color: #e9f3ff;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    button,
    input {
      font: inherit;
    }

    .cockpit-launcher {
      position: fixed;
      right: 18px;
      bottom: 78px;
      z-index: 90;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 140px;
      border: 1px solid rgba(117, 210, 255, 0.34);
      border-radius: 8px;
      padding: 10px 12px;
      color: #eaf7ff;
      background: rgba(9, 18, 32, 0.92);
      box-shadow: 0 14px 42px rgba(0, 0, 0, 0.4);
      cursor: pointer;
    }

    .launcher-mark,
    .icon-button,
    .dock-item svg,
    .chat-form button svg {
      width: 20px;
      height: 20px;
      color: currentColor;
    }

    .launcher-mark {
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      border-radius: 50%;
      color: #72e0ff;
      background: rgba(114, 224, 255, 0.12);
    }

    .launcher-mark svg,
    .icon-button svg,
    .dock-item svg,
    .chat-form button svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .cockpit-launcher strong,
    .cockpit-launcher small {
      display: block;
      text-align: left;
      line-height: 1.1;
    }

    .cockpit-launcher small {
      margin-top: 3px;
      color: #9cb5c9;
      font-size: 11px;
      text-transform: uppercase;
    }

    .cockpit {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto auto;
      gap: 12px;
      min-width: 0;
      min-height: 0;
      padding: 18px;
      color: #edf7ff;
      background: #07101c;
      overflow: hidden;
    }

    .cockpit::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
      background-size: 36px 36px;
      mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.76), rgba(0, 0, 0, 0.12));
    }

    .cockpit-top,
    .cockpit-grid,
    .status-strip,
    .dock,
    .chat-panel {
      position: relative;
      z-index: 1;
    }

    .cockpit-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
      border-bottom: 1px solid rgba(132, 168, 198, 0.18);
      padding-bottom: 12px;
    }

    .cockpit-top span {
      color: #70d8ff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .cockpit-top h2 {
      margin: 2px 0 0;
      font-size: 24px;
      line-height: 1.15;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .error {
      max-width: 240px;
      color: #ff9d9d;
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ghost,
    .icon-button {
      border: 1px solid rgba(159, 193, 224, 0.24);
      border-radius: 8px;
      color: #dcecff;
      background: rgba(255, 255, 255, 0.06);
      cursor: pointer;
    }

    .ghost {
      min-height: 36px;
      padding: 0 14px;
    }

    .icon-button {
      display: grid;
      width: 36px;
      height: 36px;
      place-items: center;
      padding: 0;
    }

    .cockpit-grid {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(300px, 1fr) minmax(260px, 340px);
      gap: 14px;
      min-height: 0;
    }

    .telemetry-panel {
      min-width: 0;
      min-height: 0;
      border: 1px solid rgba(128, 169, 204, 0.2);
      border-radius: 8px;
      padding: 14px;
      background: rgba(11, 23, 39, 0.78);
      overflow: hidden;
    }

    .telemetry-panel h3 {
      margin: 0 0 12px;
      color: #b8ddff;
      font-size: 13px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      min-width: 0;
      border: 1px solid rgba(137, 164, 196, 0.16);
      border-radius: 7px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.045);
    }

    .metric span,
    .metric small,
    .agent-row small,
    .status-strip span,
    .status-strip small,
    .domain-pill small,
    .dock-item small {
      color: #9eb4c8;
      font-size: 11px;
    }

    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 20px;
    }

    .metric.ok strong,
    .domain-pill.ok strong {
      color: #6af0b8;
    }

    .metric.warn strong,
    .domain-pill.warn strong {
      color: #ffd06d;
    }

    .metric.hot strong,
    .domain-pill.hot strong {
      color: #ff8f9a;
    }

    .agent-list {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }

    .agent-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-width: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px 0;
      font-size: 13px;
    }

    .agent-row span:nth-child(2) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-light {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6f8298;
    }

    .agent-light.completed {
      background: #4cec9f;
    }

    .agent-light.running {
      background: #67d8ff;
    }

    .agent-light.failed,
    .agent-light.attention_required {
      background: #ff7e8b;
    }

    .core-stage {
      position: relative;
      min-width: 0;
      min-height: 340px;
      border: 1px solid rgba(102, 177, 219, 0.16);
      border-radius: 8px;
      background: #050a12;
      overflow: hidden;
      touch-action: none;
    }

    .core-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }

    .core-readout {
      position: absolute;
      left: 50%;
      top: 50%;
      display: grid;
      min-width: 180px;
      transform: translate(-50%, -50%);
      place-items: center;
      text-align: center;
      pointer-events: none;
    }

    .core-readout span {
      color: #81e1ff;
      font-size: 11px;
      font-weight: 700;
    }

    .core-readout strong {
      margin-top: 6px;
      font-size: 28px;
      line-height: 1.05;
      text-transform: uppercase;
    }

    .core-readout small {
      margin-top: 8px;
      color: #9eb4c8;
      font-size: 12px;
    }

    .domain-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .domain-pill {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-rows: auto auto;
      gap: 2px 8px;
      min-width: 0;
      border: 1px solid rgba(137, 164, 196, 0.16);
      border-radius: 7px;
      padding: 9px;
      color: #e8f4ff;
      background: rgba(255, 255, 255, 0.045);
      text-align: left;
      cursor: pointer;
    }

    .domain-pill strong {
      grid-row: 1 / span 2;
      align-self: center;
      font-size: 14px;
    }

    .domain-pill span,
    .domain-pill small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .status-strip div {
      min-width: 0;
      border: 1px solid rgba(128, 169, 204, 0.18);
      border-radius: 8px;
      padding: 10px 12px;
      background: rgba(11, 23, 39, 0.78);
    }

    .status-strip strong,
    .status-strip small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-strip strong {
      margin-top: 4px;
      color: #f2fbff;
      font-size: 15px;
    }

    .dock {
      display: flex;
      justify-content: center;
      gap: 8px;
      min-width: 0;
    }

    .dock-item {
      display: grid;
      grid-template-columns: auto;
      justify-items: center;
      gap: 3px;
      width: 76px;
      border: 1px solid rgba(128, 169, 204, 0.2);
      border-radius: 8px;
      padding: 9px 6px;
      color: #dcecff;
      background: rgba(255, 255, 255, 0.055);
      cursor: pointer;
    }

    .dock-item.active {
      border-color: rgba(109, 224, 255, 0.48);
      color: #7fe2ff;
      background: rgba(109, 224, 255, 0.12);
    }

    .dock-item span {
      font-size: 12px;
      line-height: 1.1;
    }

    .chat-panel {
      position: absolute;
      right: 18px;
      bottom: 104px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      width: min(420px, calc(100vw - 36px));
      height: min(520px, calc(100vh - 150px));
      border: 1px solid rgba(130, 204, 255, 0.28);
      border-radius: 8px;
      background: rgba(8, 17, 30, 0.96);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      opacity: 0;
      pointer-events: none;
      transform: translateY(12px);
      transition:
        opacity 0.16s ease,
        transform 0.16s ease;
    }

    .chat-panel.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .chat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding: 12px;
    }

    .chat-head strong,
    .chat-head span {
      display: block;
    }

    .chat-head span {
      color: #88dfff;
      font-size: 11px;
    }

    .chat-log {
      min-height: 0;
      padding: 12px;
      overflow: auto;
    }

    .chat-empty {
      color: #9eb4c8;
      font-size: 13px;
      text-align: center;
    }

    .chat-user,
    .chat-system {
      width: fit-content;
      max-width: 88%;
      border-radius: 8px;
      margin: 0 0 8px;
      padding: 9px 10px;
      line-height: 1.45;
      word-break: break-word;
    }

    .chat-user {
      margin-left: auto;
      color: #062235;
      background: #8ce8ff;
    }

    .chat-system {
      color: #c8d9e8;
      background: rgba(255, 255, 255, 0.08);
    }

    .chat-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding: 12px;
    }

    .chat-form input {
      min-width: 0;
      border: 1px solid rgba(159, 193, 224, 0.24);
      border-radius: 8px;
      padding: 0 12px;
      color: #edf7ff;
      background: rgba(255, 255, 255, 0.06);
      outline: none;
    }

    .chat-form button {
      display: grid;
      width: 40px;
      height: 40px;
      place-items: center;
      border: 1px solid rgba(109, 224, 255, 0.4);
      border-radius: 8px;
      color: #7fe2ff;
      background: rgba(109, 224, 255, 0.12);
      cursor: pointer;
    }

    @media (max-width: 920px) {
      .cockpit {
        overflow: auto;
      }

      .cockpit-grid,
      .status-strip {
        grid-template-columns: 1fr;
      }

      .core-stage {
        min-height: 360px;
      }

      .dock {
        justify-content: flex-start;
        overflow-x: auto;
        padding-bottom: 4px;
      }

      .dock-item {
        flex: 0 0 74px;
      }
    }

    @media (max-width: 560px) {
      .cockpit {
        padding: 12px;
      }

      .cockpit-top {
        align-items: flex-start;
      }

      .cockpit-top h2 {
        font-size: 20px;
      }

      .top-actions {
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .metrics,
      .domain-grid {
        grid-template-columns: 1fr;
      }

      .chat-panel {
        right: 12px;
        bottom: 92px;
        width: calc(100vw - 24px);
      }
    }
  `;
}
