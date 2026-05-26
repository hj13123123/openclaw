import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { icons } from "../icons.ts";

type HudState = {
  generatedAt?: string;
  globalStatus?: {
    status?: string;
    runningCount?: number;
    pendingReviewCount?: number;
    alertCount?: number;
  };
  agentGroups?: unknown[];
  semanticRebuild?: {
    stage?: string;
    executionStatus?: string | null;
  };
};

type ChatEntry = {
  speaker: "user" | "system";
  text: string;
};

type Particle = {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: string;
  glow: number;
};

const CORE_PARTICLE_COUNT = 1600;
const DIFFUSION_PARTICLE_COUNT = 360;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function random(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function normal(index: number, salt: number): number {
  const u = Math.max(0.0001, random(index * 1.73 + salt));
  const v = random(index * 2.11 + salt * 3.17);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
}

function mixColor(
  a: [number, number, number],
  b: [number, number, number],
  amount: number,
  alpha: number,
): string {
  const t = Math.max(0, Math.min(1, amount));
  const red = Math.round(a[0] + (b[0] - a[0]) * t);
  const green = Math.round(a[1] + (b[1] - a[1]) * t);
  const blue = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function mixTuple(
  a: [number, number, number],
  b: [number, number, number],
  amount: number,
): [number, number, number] {
  const t = Math.max(0, Math.min(1, amount));
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "healthy":
      return "健康";
    case "attention_required":
      return "需要关注";
    case "ready":
      return "就绪";
    case "applied":
      return "已完成";
    case "blocked":
      return "受阻";
    case "frozen":
      return "冻结";
    case "failed":
      return "失败";
    case "observe-only":
      return "观察中";
    case "syncing":
      return "同步中";
    default:
      return "待同步";
  }
}

@customElement("longma-cockpit")
export class LongmaCockpit extends LitElement {
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) chatSending = false;
  @property({ attribute: false }) chatError: string | null = null;
  @property({ attribute: false }) sendMessage?: (message: string) => Promise<void> | void;

  @state() private hud: HudState | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private draft = "";
  @state() private notice = "龙马在线，等待输入。";
  @state() private chatEntries: ChatEntry[] = [];

  @query(".core-canvas") private coreCanvas?: HTMLCanvasElement;

  private frameHandle = 0;
  private refreshHandle = 0;
  private pointerX = 0.64;
  private pointerY = -0.16;
  private activationStartedAt = 0;
  private activationUntil = 0;

  connectedCallback() {
    super.connectedCallback();
    void this.refreshHud();
    this.refreshHandle = window.setInterval(() => void this.refreshHud(), 15_000);
  }

  disconnectedCallback() {
    window.cancelAnimationFrame(this.frameHandle);
    window.clearInterval(this.refreshHandle);
    super.disconnectedCallback();
  }

  protected firstUpdated() {
    this.startCore();
  }

  private async refreshHud() {
    this.loading = true;
    try {
      const response = await fetch("/api/hud/state");
      if (!response.ok) throw new Error(`状态同步失败：${response.status}`);
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
      this.frameHandle = window.requestAnimationFrame(draw);
    };
    this.frameHandle = window.requestAnimationFrame(draw);
  }

  private handlePointerMove(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.pointerX = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
    this.pointerY = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    this.activationStartedAt = performance.now();
    this.activationUntil = this.activationStartedAt + 2200;
  }

  private handlePointerDown(event: PointerEvent) {
    this.handlePointerMove(event);
  }

  private drawGlowDot(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    color: string,
    glow: number,
  ) {
    for (let layer = 4; layer >= 1; layer -= 1) {
      context.beginPath();
      context.fillStyle = color.replace(/[\d.]+\)$/u, `${Math.min(0.11, glow * 0.038) / layer})`);
      const halo = radius * layer * 2.8;
      context.arc(x, y, halo, 0, Math.PI * 2);
      context.fill();
    }
    context.beginPath();
    context.fillStyle = color;
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
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
    const cy = rect.height * 0.43;
    const radius = Math.min(rect.width, rect.height) * 0.29;
    const now = performance.now();
    const triggered = Math.max(0, Math.min(1, (this.activationUntil - now) / 1800));
    const triggeredAge = Math.max(0, Math.min(1, (now - this.activationStartedAt) / 1200));
    const idlePulse = 0.08 + Math.sin(timestamp / 1300) * 0.025;
    const activation = Math.max(triggered, idlePulse);
    const direction = Math.atan2(this.pointerY, this.pointerX || 0.01);
    const warmRed: [number, number, number] = [255, 48, 36];
    const warmOrange: [number, number, number] = [255, 124, 47];
    const warmGold: [number, number, number] = [255, 209, 106];
    const coolCyan: [number, number, number] = [69, 247, 255];
    const coolBlue: [number, number, number] = [88, 166, 255];

    context.globalCompositeOperation = "source-over";
    const warmGlow = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 2.15);
    warmGlow.addColorStop(0, "rgba(255, 142, 55, 0.34)");
    warmGlow.addColorStop(0.42, "rgba(255, 88, 44, 0.14)");
    warmGlow.addColorStop(1, "rgba(255, 75, 35, 0)");
    context.fillStyle = warmGlow;
    context.beginPath();
    context.ellipse(cx, cy, radius * 2.35, radius * 1.72, 0, 0, Math.PI * 2);
    context.fill();

    context.globalCompositeOperation = "lighter";
    const particles: Particle[] = [];
    const lobes = [
      [-0.44, -0.06, 0.34, 0.22],
      [-0.14, -0.3, 0.36, 0.2],
      [0.24, -0.18, 0.38, 0.22],
      [0.42, 0.18, 0.34, 0.22],
      [-0.08, 0.28, 0.42, 0.24],
      [-0.55, 0.22, 0.26, 0.16],
      [0.02, 0.02, 0.52, 0.3],
    ];

    for (let index = 0; index < CORE_PARTICLE_COUNT; index += 1) {
      const lobe = lobes[index % lobes.length];
      const x = cx + (lobe[0] + normal(index, 1.2) * lobe[2]) * radius;
      const y = cy + (lobe[1] + normal(index, 4.8) * lobe[3]) * radius;
      const dx = (x - cx) / (radius * 1.15);
      const dy = (y - cy) / (radius * 0.86);
      const distance = Math.hypot(dx, dy);
      if (distance > 1.35) continue;

      const front = Math.max(0, 1 - distance * 0.58) + random(index * 1.9) * 0.18;
      const selected = random(index * 8.1) < activation * 0.28;
      const travel = selected ? activation * (0.45 + random(index * 3.7) * 0.82) : 0;
      const fan = (random(index * 6.4) - 0.5) * 0.7;
      const angle = direction + fan + Math.sin(timestamp / 900 + index) * 0.04;
      const drift = travel * radius * (1.1 + random(index * 5.2) * 1.5);
      const px = x + Math.cos(angle) * drift;
      const py = y + Math.sin(angle) * drift * 0.72 + Math.sin(travel * Math.PI) * radius * 0.15;
      const coolAmount = Math.max(0, (travel - 0.18) / 0.82);
      const base = random(index * 11.4) > 0.72 ? warmGold : warmOrange;
      const warmBase = mixTuple(warmRed, base, 0.45 + front * 0.42);
      const color = mixColor(
        warmBase,
        random(index * 2.5) > 0.48 ? coolCyan : coolBlue,
        coolAmount,
        Math.min(0.44, 0.13 + front * 0.23 + coolAmount * 0.08),
      );
      particles.push({
        x: px,
        y: py,
        z: front + travel,
        radius: 0.48 + random(index * 9.2) * 1.55 + front * 0.58 + coolAmount * 0.58,
        color,
        glow: 0.48 + front * 0.26 + coolAmount * 0.72,
      });
    }

    for (let arm = 0; arm < 5; arm += 1) {
      const baseAngle = direction + (arm - 2) * 0.22;
      for (let index = 0; index < DIFFUSION_PARTICLE_COUNT / 5; index += 1) {
        const seed = arm * 1000 + index;
        const t = Math.pow(random(seed * 1.5 + timestamp / 2400), 0.72);
        const force = triggered * (0.35 + triggeredAge * 0.65);
        if (force <= 0.04) continue;
        const curve = Math.sin(t * Math.PI * (1.05 + arm * 0.05)) * radius * (0.14 + arm * 0.04);
        const distance = radius * (0.46 + t * (1.45 + arm * 0.18)) * force;
        const angle = baseAngle + normal(seed, 2.4) * 0.12 + t * 0.24;
        const x = cx + Math.cos(angle) * distance - Math.sin(angle) * curve;
        const y = cy + Math.sin(angle) * distance * 0.68 + Math.cos(angle) * curve * 0.36;
        const color = mixColor(
          warmOrange,
          random(seed * 2.7) > 0.4 ? coolCyan : coolBlue,
          Math.max(0, (t - 0.16) / 0.84),
          0.08 + force * 0.2,
        );
        particles.push({
          x,
          y,
          z: 1.2 + t,
          radius: 0.5 + random(seed * 9.2) * 1.65 + t * 0.75,
          color,
          glow: 0.52 + t * 0.48,
        });
      }
    }

    particles
      .sort((a, b) => a.z - b.z)
      .forEach((particle) =>
        this.drawGlowDot(
          context,
          particle.x,
          particle.y,
          particle.radius,
          particle.color,
          particle.glow,
        ),
      );

    context.globalCompositeOperation = "source-over";
    for (let ring = 0; ring < 7; ring += 1) {
      context.save();
      context.translate(cx, cy);
      context.rotate(-0.32 + ring * 0.18 + Math.sin(timestamp / 1900 + ring) * 0.04);
      context.beginPath();
      context.strokeStyle =
        ring % 2 === 0
          ? `rgba(255, 138, 61, ${0.07 + ring * 0.012})`
          : `rgba(69, 247, 255, ${0.04 + activation * 0.08})`;
      context.lineWidth = 0.8;
      context.ellipse(
        0,
        0,
        radius * (1.1 + ring * 0.13),
        radius * (0.28 + ring * 0.03),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      context.restore();
    }
  }

  private async submitPrompt(event: SubmitEvent) {
    event.preventDefault();
    const message = this.draft.trim();
    if (!message) return;

    this.chatEntries = [...this.chatEntries, { speaker: "user", text: message }];
    this.draft = "";

    if (!this.connected || !this.sendMessage) {
      const text = "主会话尚未连接，消息未发送。";
      this.notice = text;
      this.chatEntries = [...this.chatEntries, { speaker: "system", text }];
      return;
    }

    try {
      this.notice = "正在发送给龙马。";
      await this.sendMessage(message);
      this.notice = "已发送到主会话。";
      this.chatEntries = [...this.chatEntries, { speaker: "system", text: this.notice }];
    } catch (error) {
      const text = `发送失败：${error instanceof Error ? error.message : String(error)}`;
      this.notice = text;
      this.chatEntries = [...this.chatEntries, { speaker: "system", text }];
    }
  }

  private systemSummary(): string {
    const global = this.hud?.globalStatus;
    const status = statusLabel(global?.status);
    const running = count(global?.runningCount);
    const review = count(global?.pendingReviewCount);
    const alerts = count(global?.alertCount);
    const agents = this.hud?.agentGroups?.length ?? 0;
    return `${status} · ${agents} 岗位 · ${running} 运行 · ${review} 待验收 · ${alerts} 警告`;
  }

  protected render() {
    const semantic = statusLabel(this.hud?.semanticRebuild?.stage);
    return html`
      <main class="os-shell" aria-label="龙马操作系统">
        <header class="topbar">
          <div>
            <strong>龙马操作系统</strong>
            <h1>龙马</h1>
            <p>记忆连续 · 语音待命 · 摄像头待接入</p>
          </div>
          <button type="button" class="sync-button" @click=${() => void this.refreshHud()}>
            ${this.loading ? "同步中" : "同步"}
          </button>
        </header>

        <section
          class="core-stage"
          aria-label="龙马核心"
          @pointermove=${this.handlePointerMove}
          @pointerdown=${this.handlePointerDown}
        >
          <canvas class="core-canvas" aria-hidden="true"></canvas>
          <div class="core-readout">
            <strong>龙马核心</strong>
            <span>橙红凝聚 · 触发扩散 · 渐变青蓝</span>
          </div>
        </section>

        <section class="prompt-zone" aria-label="对话输入">
          <p class="summary">
            ${this.error ? `状态同步异常：${this.error}` : this.systemSummary()}
          </p>
          <form class="prompt-form" @submit=${this.submitPrompt}>
            <button type="button" class="round-button" aria-label="添加">${icons.plus}</button>
            <input
              .value=${this.draft}
              @input=${(event: InputEvent) =>
                (this.draft = (event.target as HTMLInputElement).value)}
              placeholder="和龙马说点什么..."
            />
            <button type="button" class="round-button accent" aria-label="语音输入">
              ${icons.mic}
            </button>
            <button
              type="submit"
              class="round-button"
              aria-label="发送"
              ?disabled=${this.chatSending || this.draft.trim().length === 0}
            >
              ${this.chatSending ? icons.loader : icons.send}
            </button>
          </form>
          <p class="notice">${this.chatError ?? this.notice}</p>
          <div class="quick-actions" aria-label="快捷入口">
            <button type="button">文字</button>
            <button type="button">语音</button>
            <button type="button">摄像头</button>
            <button type="button">操作舱</button>
            <button type="button">语义知识：${semantic}</button>
          </div>
          ${this.chatEntries.length > 0
            ? html`<div class="history" aria-label="最近对话">
                ${this.chatEntries.slice(-2).map((entry) => html`<p>${entry.text}</p>`)}
              </div>`
            : nothing}
        </section>
      </main>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 20000;
      display: block;
      color: #f4fbff;
      font-family: "Microsoft YaHei UI", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    button,
    input {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    .os-shell {
      position: relative;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      padding: 34px 48px 44px;
      background:
        radial-gradient(circle at 50% 35%, rgba(255, 112, 45, 0.11), transparent 30%),
        radial-gradient(circle at 70% 36%, rgba(69, 247, 255, 0.09), transparent 28%),
        linear-gradient(180deg, #020407 0%, #050b10 52%, #071017 100%);
      overflow: hidden;
    }

    .os-shell::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 16% 18%, rgba(255, 255, 255, 0.08), transparent 1.8%),
        radial-gradient(circle at 78% 12%, rgba(69, 247, 255, 0.08), transparent 2.2%),
        radial-gradient(circle at 12% 78%, rgba(255, 138, 61, 0.08), transparent 2.2%);
      opacity: 0.76;
    }

    .os-shell::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 72px 72px;
      mask-image: radial-gradient(circle at 50% 42%, #000 0 28%, transparent 72%);
      opacity: 0.42;
    }

    .topbar,
    .core-stage,
    .prompt-zone {
      position: relative;
      z-index: 1;
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      min-width: 0;
    }

    .topbar strong {
      display: block;
      color: #ff8a3d;
      font-size: 13px;
      font-weight: 800;
    }

    .topbar h1 {
      margin: 5px 0 0;
      font-size: clamp(30px, 4vw, 48px);
      line-height: 1;
      letter-spacing: 0;
    }

    .topbar p {
      margin: 9px 0 0;
      color: #9eb2bc;
      font-size: 15px;
    }

    .sync-button {
      min-width: 86px;
      min-height: 40px;
      border: 1px solid rgba(255, 138, 61, 0.34);
      border-radius: 999px;
      color: #ffd7bf;
      background: rgba(255, 138, 61, 0.08);
    }

    .core-stage {
      display: grid;
      min-height: 0;
      place-items: center;
      touch-action: none;
    }

    .core-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      mask-image: radial-gradient(
        ellipse at 50% 43%,
        #000 0 38%,
        rgba(0, 0, 0, 0.86) 54%,
        transparent 78%
      );
    }

    .core-readout {
      position: absolute;
      left: 50%;
      top: calc(43% + min(24vw, 150px));
      transform: translateX(-50%);
      display: grid;
      place-items: center;
      text-align: center;
      pointer-events: none;
      text-shadow:
        0 0 18px rgba(255, 138, 61, 0.42),
        0 0 32px rgba(69, 247, 255, 0.16);
    }

    .core-readout strong {
      font-size: clamp(22px, 2.4vw, 34px);
      line-height: 1;
    }

    .core-readout span {
      margin-top: 14px;
      border: 1px solid rgba(255, 138, 61, 0.32);
      border-radius: 999px;
      padding: 7px 14px;
      color: #c8d7dd;
      background: rgba(5, 11, 16, 0.48);
      font-size: 14px;
      backdrop-filter: blur(10px);
    }

    .prompt-zone {
      display: grid;
      justify-items: center;
      gap: 12px;
    }

    .summary,
    .notice {
      margin: 0;
      color: #9eb2bc;
      font-size: 14px;
      text-align: center;
    }

    .prompt-form {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 12px;
      width: min(760px, calc(100vw - 48px));
      min-height: 70px;
      border: 1px solid rgba(255, 138, 61, 0.42);
      border-radius: 24px;
      padding: 10px 14px;
      background: rgba(9, 16, 22, 0.78);
      box-shadow:
        0 0 48px rgba(255, 104, 38, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
      backdrop-filter: blur(18px);
    }

    .prompt-form input {
      min-width: 0;
      border: 0;
      outline: 0;
      color: #f4fbff;
      background: transparent;
      font-size: 16px;
    }

    .prompt-form input::placeholder {
      color: #80949f;
    }

    .round-button {
      display: grid;
      width: 42px;
      height: 42px;
      place-items: center;
      border: 0;
      border-radius: 50%;
      color: #f4fbff;
      background: rgba(255, 255, 255, 0.04);
    }

    .round-button.accent {
      color: #45f7ff;
    }

    .round-button:disabled {
      color: #61727b;
      cursor: not-allowed;
    }

    .round-button svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .quick-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      max-width: min(780px, calc(100vw - 48px));
    }

    .quick-actions button {
      border: 1px solid rgba(255, 138, 61, 0.28);
      border-radius: 999px;
      padding: 7px 15px;
      color: #ffb37e;
      background: rgba(255, 138, 61, 0.08);
      font-size: 14px;
    }

    .history {
      display: grid;
      gap: 6px;
      width: min(760px, calc(100vw - 48px));
      color: #b8c9d2;
      font-size: 13px;
      text-align: center;
    }

    .history p {
      margin: 0;
    }

    @media (max-width: 720px) {
      .os-shell {
        padding: 22px 18px 28px;
      }

      .topbar h1 {
        font-size: 34px;
      }

      .topbar p,
      .summary,
      .notice {
        font-size: 13px;
      }

      .sync-button {
        min-width: 68px;
      }

      .prompt-form {
        width: 100%;
        min-height: 62px;
        border-radius: 20px;
        gap: 7px;
      }

      .round-button {
        width: 36px;
        height: 36px;
      }
    }
  `;
}
