import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { isSttSupported, isTtsSupported, speakText, startStt, stopStt, stopTts } from "../chat/speech.ts";
import { icons } from "../icons.ts";

type HudState = {
  generatedAt?: string;
  globalStatus?: {
    status?: string;
    runningCount?: number;
    completedCount?: number;
    pendingReviewCount?: number;
    alertCount?: number;
    lastUpdatedAt?: string;
  };
  agentGroups?: Array<{
    agentId?: string;
    displayName?: string;
    status?: string;
    hasAlerts?: boolean;
  }>;
  semanticRebuild?: {
    stage?: string;
    executionStatus?: string | null;
    totalItems?: number;
  };
  taskGraphs?: unknown[];
  activeTasks?: unknown[];
  warnings?: unknown[];
  promotionCandidates?: unknown[] | { candidateCount?: number; items?: unknown[] };
  returnInbox?: unknown[] | { pendingCount?: number; items?: unknown[] };
  controlSignals?: unknown[] | { pendingCount?: number; items?: unknown[] };
  mirrorObserve?: {
    available?: boolean;
    status?: string;
    mode?: string | null;
    latestReportPath?: string | null;
    reportPath?: string | null;
    stats?: {
      observationCount?: number;
      findingCount?: number;
      bySeverity?: Record<string, number>;
    } | null;
  };
  autoEvolutionObserve?: { status?: string; latestReportPath?: string | null };
  watchdogSnapshot?: { conditions?: unknown[] };
  longmaV3?: {
    status?: string;
    lanes?: {
      memoryContinuity?: LongmaV3Lane;
      skillDistillation?: LongmaV3Lane;
      autonomousEvolution?: LongmaV3Lane;
      recoveryLoop?: LongmaV3Lane;
    };
    nextActions?: string[];
  };
};

type LongmaV3Lane = {
  status?: string;
  signalCount?: number;
  detail?: string;
  sourcePath?: string | null;
};

type ChatEntry = {
  speaker: "user" | "system";
  text: string;
};

type CommandAction = {
  label: string;
  message: string;
};

type ChatMessageLike = {
  role?: unknown;
  content?: unknown;
};

type LongmaDeviceList = {
  pending?: unknown[];
  paired?: unknown[];
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

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromContent(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (!value || typeof value !== "object") return "";
  const record = value as { text?: unknown; content?: unknown };
  return textFromContent(record.text ?? record.content);
}

function itemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const record = value as {
    candidateCount?: unknown;
    pendingCount?: unknown;
    items?: unknown;
    conditions?: unknown;
  };
  if (typeof record.candidateCount === "number") return count(record.candidateCount);
  if (typeof record.pendingCount === "number") return count(record.pendingCount);
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.conditions)) return record.conditions.length;
  return 0;
}

function formatFreshness(value: string | undefined): string {
  if (!value) return "遥测未生成";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "遥测时间未知";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "遥测刚生成";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "遥测刚刚更新";
  if (minutes < 60) return `遥测 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `遥测 ${hours} 小时前`;
  return `遥测 ${Math.floor(hours / 24)} 天前`;
}

function localizeV3Action(action: string): string {
  switch (action) {
    case "run approved semantic rebuild through the controlled execution gate":
      return "通过受控闸口执行已批准的语义记忆重建";
    case "generate a semantic rebuild plan from current memory sources":
      return "基于当前记忆源生成语义重建计划";
    case "review safe promotion candidates before controlled skill-library writes":
      return "复核安全候选后再受控写入技能库";
    case "repair invalid or inconsistent promotion candidates":
      return "修复无效或不一致的技能沉淀候选";
    case "resolve high-priority auto-evolution observations before enabling apply loop":
      return "先处理高优先进化观察，再开放应用闭环";
    case "drain return and recovery queues through dry-run gates":
      return "通过 dry-run 闸口处理回流与恢复队列";
    case "keep V3 observe loop refreshing HUD state":
      return "保持 V3 观察循环刷新遥测状态";
    default:
      return action;
  }
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
    case "online":
      return "在线";
    case "attention_required":
    case "needs_attention":
      return "需要关注";
    case "completed":
      return "已完成";
    case "ready":
      return "就绪";
    case "running":
      return "运行中";
    case "idle":
      return "空闲";
    case "applied":
      return "已完成";
    case "blocked":
      return "受阻";
    case "frozen":
      return "冻结";
    case "failed":
      return "失败";
    case "observe-only":
    case "observe_only":
      return "观察中";
    case "bootstrapping":
      return "启动中";
    case "syncing":
      return "同步中";
    case "unknown":
      return "未知";
    default:
      return "待同步";
  }
}

@customElement("longma-cockpit")
export class LongmaCockpit extends LitElement {
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) chatSending = false;
  @property({ attribute: false }) chatError: string | null = null;
  @property({ attribute: false }) messages: unknown[] = [];
  @property({ attribute: false }) devices: LongmaDeviceList | null = null;
  @property({ attribute: false }) sendMessage?: (message: string) => Promise<void> | void;

  @state() private hud: HudState | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private draft = "";
  @state() private notice = "龙马在线，等待输入。";
  @state() private chatEntries: ChatEntry[] = [];
  @state() private developerMode = false;
  @state() private voiceStatus = "语音待命";
  @state() private voiceActive = false;
  @state() private ttsStatus = "语音回复待命";
  @state() private ttsActive = false;
  @state() private cameraStatus = "摄像头待接入";
  @state() private cameraActive = false;
  @state() private distillStatus = "技能沉淀预检待命";
  @state() private memoryStatus = "记忆连续预检待命";
  @state() private mirrorStatus = "镜像观察待命";
  @state() private evolutionStatus = "自进化观察待命";

  @query(".core-canvas") private coreCanvas?: HTMLCanvasElement;
  @query(".vision-preview") private visionPreview?: HTMLVideoElement;

  private frameHandle = 0;
  private refreshHandle = 0;
  private cameraStream: MediaStream | null = null;
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
    this.stopVoiceInput();
    this.stopVoiceOutput();
    this.stopCamera();
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

  private async runSkillDistillationCheck() {
    this.distillStatus = "技能沉淀预检中";
    try {
      const response = await fetch("/api/promote-gate/dry-run", { method: "POST" });
      if (!response.ok) throw new Error(`技能沉淀预检失败：${response.status}`);
      this.distillStatus = "技能沉淀预检完成";
      this.notice = "技能沉淀预检已完成：只读 dry-run，未写入技能库。";
      await this.refreshHud();
    } catch (error) {
      this.distillStatus = "技能沉淀预检失败";
      this.notice = error instanceof Error ? error.message : String(error);
    }
  }

  private async runMemoryContinuityCheck() {
    this.memoryStatus = "记忆连续预检中";
    try {
      const response = await fetch("/api/kb/semantic-rebuild-plan", { method: "POST" });
      if (!response.ok) throw new Error(`记忆连续预检失败：${response.status}`);
      this.memoryStatus = "记忆连续预检完成";
      this.notice = "记忆连续预检已完成：只生成语义 dry-run 计划，未写入向量索引。";
      await this.refreshHud();
    } catch (error) {
      this.memoryStatus = "记忆连续预检失败";
      this.notice = error instanceof Error ? error.message : String(error);
    }
  }

  private async runMirrorObserve() {
    this.mirrorStatus = "镜像观察中";
    try {
      const response = await fetch("/api/mirror/observe", { method: "POST" });
      if (!response.ok) throw new Error(`镜像观察失败：${response.status}`);
      this.mirrorStatus = "镜像观察完成";
      this.notice = "镜像观察已完成：observe-only，未执行推广或应用。";
      await this.refreshHud();
    } catch (error) {
      this.mirrorStatus = "镜像观察失败";
      this.notice = error instanceof Error ? error.message : String(error);
    }
  }

  private async runAutoEvolutionObserve() {
    this.evolutionStatus = "自进化观察中";
    try {
      const response = await fetch("/api/auto-evolution/observe", { method: "POST" });
      if (!response.ok) throw new Error(`自进化观察失败：${response.status}`);
      this.evolutionStatus = "自进化观察完成";
      this.notice = "自进化观察已完成：observe-only，未执行自动应用。";
      await this.refreshHud();
    } catch (error) {
      this.evolutionStatus = "自进化观察失败";
      this.notice = error instanceof Error ? error.message : String(error);
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

  private enterDeveloperMode() {
    this.developerMode = true;
    this.toggleAttribute("developer-mode", true);
  }

  private exitDeveloperMode() {
    this.developerMode = false;
    this.toggleAttribute("developer-mode", false);
  }

  private toggleVoiceInput() {
    if (this.voiceActive) {
      this.stopVoiceInput();
      return;
    }
    if (!isSttSupported()) {
      this.voiceStatus = "当前浏览器不支持语音识别";
      return;
    }
    this.voiceStatus = "正在启动语音";
    startStt({
      onStart: () => {
        this.voiceActive = true;
        this.voiceStatus = "正在听你说话";
      },
      onTranscript: (text, isFinal) => {
        this.draft = text.trim();
        this.voiceStatus = isFinal ? "语音已转文字" : "正在识别语音";
      },
      onEnd: () => {
        this.voiceActive = false;
        if (this.voiceStatus === "正在听你说话" || this.voiceStatus === "正在识别语音") {
          this.voiceStatus = "语音待命";
        }
      },
      onError: (error) => {
        this.voiceActive = false;
        this.voiceStatus = `语音识别失败：${error}`;
      },
    });
  }

  private stopVoiceInput() {
    stopStt();
    this.voiceActive = false;
    if (this.voiceStatus !== "语音已转文字") {
      this.voiceStatus = "语音待命";
    }
  }

  private async toggleCamera() {
    if (this.cameraActive) {
      this.stopCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraStatus = "当前浏览器不支持摄像头";
      return;
    }
    try {
      this.cameraStatus = "正在接入摄像头";
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      this.cameraStream = stream;
      this.cameraActive = true;
      this.cameraStatus = "摄像头已接入";
      await this.updateComplete;
      if (this.visionPreview) {
        this.visionPreview.srcObject = stream;
      }
    } catch (error) {
      this.cameraActive = false;
      this.cameraStatus = `摄像头接入失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private stopCamera() {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    this.cameraActive = false;
    this.cameraStatus = "摄像头待接入";
    if (this.visionPreview) {
      this.visionPreview.srcObject = null;
    }
  }

  private speakLatestReply() {
    if (this.ttsActive) {
      this.stopVoiceOutput();
      return;
    }
    const text = this.latestAssistantText();
    if (!text) {
      this.ttsStatus = "暂无可朗读回复";
      return;
    }
    if (!isTtsSupported()) {
      this.ttsStatus = "当前浏览器不支持语音回复";
      return;
    }
    this.ttsStatus = "正在启动朗读";
    speakText(text, {
      onStart: () => {
        this.ttsActive = true;
        this.ttsStatus = "正在朗读回复";
      },
      onEnd: () => {
        this.ttsActive = false;
        this.ttsStatus = "语音回复待命";
      },
      onError: (error) => {
        this.ttsActive = false;
        this.ttsStatus = `语音回复失败：${error}`;
      },
    });
  }

  private stopVoiceOutput() {
    stopTts();
    this.ttsActive = false;
    this.ttsStatus = "语音回复待命";
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
    const pressure = this.telemetryPressure();
    const idlePulse = 0.08 + pressure * 0.11 + Math.sin(timestamp / 1300) * (0.025 + pressure * 0.018);
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
    this.draft = "";
    await this.sendCommand(message);
  }

  private async sendCommand(message: string) {
    this.chatEntries = [...this.chatEntries, { speaker: "user", text: message }];

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

  private commandActions(): CommandAction[] {
    const nextActions =
      this.hud?.longmaV3?.nextActions?.map(localizeV3Action).join("；") ?? "保持观察刷新。";
    return [
      {
        label: "V3 自检",
        message: `执行龙马 V3 自检：${this.systemSummary()}。下一步候选：${nextActions}。只读判断，不执行写入或自动应用。`,
      },
      {
        label: "状态查询",
        message: `查询龙马当前状态：${this.systemSummary()}。请只返回需要关注的异常和下一步建议。`,
      },
      {
        label: "任务概览",
        message: "查询当前任务、运行岗位、待验收项和阻塞项，并按优先级汇总。",
      },
      {
        label: "安全闸",
        message: "检查当前安全闸、控制信号、高风险操作和需要人工确认的事项。",
      },
      {
        label: "恢复预览",
        message: "预览 return、repair、recovery 相关待处理项，只读汇总，不执行修改。",
      },
    ];
  }

  private systemSummary(): string {
    const global = this.hud?.globalStatus;
    const status = statusLabel(global?.status);
    const running = count(global?.runningCount);
    const review = count(global?.pendingReviewCount);
    const alerts = count(global?.alertCount);
    const agents = this.hud?.agentGroups?.length ?? 0;
    const v3 = this.hud?.longmaV3?.status ? ` · V3 ${statusLabel(this.hud.longmaV3.status)}` : "";
    return `${status} · ${agents} 岗位 · ${running} 运行 · ${review} 待验收 · ${alerts} 警告${v3}`;
  }

  private telemetryFreshness(): string {
    return formatFreshness(this.hud?.globalStatus?.lastUpdatedAt ?? this.hud?.generatedAt);
  }

  private telemetryPressure(): number {
    const global = this.hud?.globalStatus;
    const signal =
      count(global?.runningCount) +
      count(global?.pendingReviewCount) * 0.7 +
      count(global?.alertCount) * 1.4 +
      itemCount(this.hud?.warnings) * 1.4 +
      itemCount(this.hud?.promotionCandidates) * 0.35 +
      itemCount(this.hud?.returnInbox) * 0.5 +
      itemCount(this.hud?.controlSignals) * 0.5 +
      itemCount(this.hud?.longmaV3?.nextActions) * 0.25;
    return Math.max(0, Math.min(1, signal / 10));
  }

  private v3Lane(name: keyof NonNullable<NonNullable<HudState["longmaV3"]>["lanes"]>) {
    return this.hud?.longmaV3?.lanes?.[name];
  }

  private domainCards() {
    const global = this.hud?.globalStatus;
    const memoryLane = this.v3Lane("memoryContinuity");
    const skillLane = this.v3Lane("skillDistillation");
    const evolutionLane = this.v3Lane("autonomousEvolution");
    const recoveryLane = this.v3Lane("recoveryLoop");
    const pairedDevices = Array.isArray(this.devices?.paired) ? this.devices.paired.length : 0;
    const pendingDevices = Array.isArray(this.devices?.pending) ? this.devices.pending.length : 0;
    const mirrorStats = this.hud?.mirrorObserve?.stats;
    return [
      {
        label: "记忆",
        value: statusLabel(memoryLane?.status ?? this.hud?.semanticRebuild?.stage),
        meta:
          typeof memoryLane?.signalCount === "number"
            ? `${memoryLane.signalCount} 语义项`
            : "D1 / D8",
      },
      {
        label: "技能",
        value: skillLane?.status
          ? statusLabel(skillLane.status)
          : `${itemCount(this.hud?.promotionCandidates)} 候选`,
        meta:
          typeof skillLane?.signalCount === "number"
            ? `${skillLane.signalCount} 候选`
            : "D9 沉淀",
      },
      {
        label: "回流",
        value: recoveryLane?.status
          ? statusLabel(recoveryLane.status)
          : `${count(global?.runningCount)} 运行`,
        meta: `${count(global?.pendingReviewCount)} 待验收`,
      },
      {
        label: "设备",
        value: this.connected ? `${pairedDevices} 已配对` : "离线",
        meta: pendingDevices > 0 ? `${pendingDevices} 待审批` : "本机节点",
      },
      {
        label: "镜像",
        value: statusLabel(this.hud?.mirrorObserve?.mode ?? this.hud?.mirrorObserve?.status),
        meta:
          mirrorStats &&
          typeof mirrorStats.observationCount === "number" &&
          typeof mirrorStats.findingCount === "number"
            ? `${mirrorStats.observationCount} 观察 · ${mirrorStats.findingCount} 发现`
            : "observe-only",
      },
      {
        label: "进化",
        value: statusLabel(
          evolutionLane?.status ??
            this.hud?.autoEvolutionObserve?.status ??
            this.hud?.mirrorObserve?.status,
        ),
        meta:
          typeof evolutionLane?.signalCount === "number"
            ? `${evolutionLane.signalCount} 建议`
            : "观察优先",
      },
    ];
  }

  private activeAgents() {
    return (this.hud?.agentGroups ?? []).slice(0, 4).map((agent) => ({
      name: agent.displayName ?? agent.agentId ?? "岗位",
      status: statusLabel(agent.status),
      alert: agent.hasAlerts === true,
    }));
  }

  private latestAssistantText(): string {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index] as ChatMessageLike | null | undefined;
      if (!message || typeof message !== "object" || message.role !== "assistant") continue;
      const text = textFromContent(message.content);
      if (text) return text;
    }
    return "";
  }

  protected render() {
    const semantic = statusLabel(this.hud?.semanticRebuild?.stage);
    const global = this.hud?.globalStatus;
    const domainCards = this.domainCards();
    const agents = this.activeAgents();
    const latestAssistantText = this.latestAssistantText();
    const commandActions = this.commandActions();
    if (this.developerMode) {
      return html`
        <button type="button" class="developer-return" @click=${() => this.exitDeveloperMode()}>
          返回龙马 OS
        </button>
      `;
    }

    return html`
      <main class="os-shell" aria-label="龙马操作系统">
        <header class="topbar">
          <div>
            <strong>龙马操作系统</strong>
            <h1>龙马</h1>
            <p>记忆连续 · ${this.voiceStatus} · ${this.cameraStatus}</p>
          </div>
          <button type="button" class="sync-button" @click=${() => void this.refreshHud()}>
            ${this.loading ? "同步中" : "同步"}
          </button>
        </header>

        <section class="desktop-stage" aria-label="龙马操作舱">
          <div class="holo-plane" aria-hidden="true"></div>
          <aside class="launcher" aria-label="核心能力">
            ${domainCards.map(
              (card) => html`
                <button type="button" class="launcher-tile">
                  <span>${card.label}</span>
                  <strong>${card.value}</strong>
                  <small>${card.meta}</small>
                </button>
              `,
            )}
          </aside>

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
            <div class="core-status" aria-label="核心状态">
              <span>${this.systemSummary()}</span>
              <small>${this.telemetryFreshness()}</small>
            </div>
          </section>

          <aside class="telemetry-panel" aria-label="遥测">
            <h2>运行态</h2>
            <div class="status-grid">
              <span>
                <strong>${this.hud?.agentGroups?.length ?? 0}</strong>
                岗位
              </span>
              <span>
                <strong>${count(global?.runningCount)}</strong>
                运行
              </span>
              <span>
                <strong>${count(global?.pendingReviewCount)}</strong>
                待验收
              </span>
              <span>
                <strong>${count(global?.alertCount) + itemCount(this.hud?.warnings)}</strong>
                警告
              </span>
            </div>
            <div class="agent-list" aria-label="岗位状态">
              ${agents.map(
                (agent) => html`
                  <p class=${agent.alert ? "alert" : ""}>
                    <span>${agent.name}</span>
                    <strong>${agent.status}</strong>
                  </p>
                `,
              )}
            </div>
            <div class="domain-readout">
              ${domainCards.map(
                (card) => html`
                  <p>
                    <span>${card.label}</span>
                    <strong>${card.value}</strong>
                  </p>
                `,
              )}
            </div>
            ${this.hud?.longmaV3?.nextActions?.length
              ? html`
                  <div class="next-actions" aria-label="V3 下一步">
                    ${this.hud.longmaV3.nextActions.slice(0, 2).map(
                      (action) => html`<p>${localizeV3Action(action)}</p>`,
                    )}
                  </div>
                `
              : nothing}
            <button
              type="button"
              class="developer-button"
              @click=${() => this.enterDeveloperMode()}
            >
              开发者
            </button>
          </aside>
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
            <button
              type="button"
              class=${this.voiceActive ? "round-button accent active" : "round-button accent"}
              aria-label="语音输入"
              @click=${() => this.toggleVoiceInput()}
            >
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
          <div class="sensory-row" aria-label="多模态状态">
            <button
              type="button"
              class=${this.voiceActive ? "sensory-button active" : "sensory-button"}
              @click=${() => this.toggleVoiceInput()}
            >
              ${this.voiceStatus}
            </button>
            <button
              type="button"
              class=${this.cameraActive ? "sensory-button active" : "sensory-button"}
              @click=${() => void this.toggleCamera()}
            >
              ${this.cameraStatus}
            </button>
            <button
              type="button"
              class=${this.ttsActive ? "sensory-button active" : "sensory-button"}
              @click=${() => this.speakLatestReply()}
            >
              ${this.ttsStatus}
            </button>
            <button
              type="button"
              class="sensory-button"
              @click=${() => void this.runSkillDistillationCheck()}
            >
              ${this.distillStatus}
            </button>
            <button
              type="button"
              class="sensory-button"
              @click=${() => void this.runMemoryContinuityCheck()}
            >
              ${this.memoryStatus}
            </button>
            <button
              type="button"
              class="sensory-button"
              @click=${() => void this.runMirrorObserve()}
            >
              ${this.mirrorStatus}
            </button>
            <button
              type="button"
              class="sensory-button"
              @click=${() => void this.runAutoEvolutionObserve()}
            >
              ${this.evolutionStatus}
            </button>
          </div>
          ${this.cameraActive
            ? html`<div class="vision-card" aria-label="摄像头画面">
                <video class="vision-preview" autoplay muted playsinline></video>
                <span>视觉上下文预览</span>
              </div>`
            : nothing}
          <div class="quick-actions" aria-label="快捷入口">
            ${commandActions.map(
              (action) => html`
                <button
                  type="button"
                  ?disabled=${this.chatSending}
                  @click=${() => void this.sendCommand(action.message)}
                >
                  ${action.label}
                </button>
              `,
            )}
            <button type="button">语义知识：${semantic}</button>
          </div>
          ${this.chatEntries.length > 0
            ? html`<div class="history" aria-label="最近对话">
                ${this.chatEntries.slice(-2).map((entry) => html`<p>${entry.text}</p>`)}
              </div>`
            : nothing}
          ${latestAssistantText
            ? html`<div class="assistant-reply" aria-label="龙马回复">
                <div>
                  <strong>龙马回复</strong>
                  <button type="button" @click=${() => this.speakLatestReply()}>朗读回复</button>
                </div>
                <p>${latestAssistantText}</p>
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
      background: #020407;
    }

    :host([developer-mode]) {
      pointer-events: none;
      background: transparent;
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

    .developer-return {
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 1;
      min-height: 42px;
      border: 1px solid rgba(69, 247, 255, 0.38);
      border-radius: 999px;
      padding: 0 18px;
      color: #dffcff;
      background: rgba(4, 14, 20, 0.84);
      box-shadow: 0 0 32px rgba(69, 247, 255, 0.18);
      pointer-events: auto;
      backdrop-filter: blur(18px);
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
        radial-gradient(circle at 48% 33%, rgba(255, 101, 38, 0.13), transparent 27%),
        radial-gradient(circle at 70% 38%, rgba(69, 247, 255, 0.11), transparent 29%),
        linear-gradient(180deg, #020407 0%, #05090d 48%, #081117 100%);
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
    .desktop-stage,
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

    .desktop-stage {
      display: grid;
      grid-template-columns: minmax(86px, 140px) minmax(0, 1fr) minmax(230px, 300px);
      align-items: center;
      gap: clamp(18px, 3vw, 34px);
      min-height: 0;
    }

    .holo-plane {
      position: absolute;
      inset: 8% 8% 2%;
      border: 1px solid rgba(255, 138, 61, 0.12);
      border-radius: 28px;
      background:
        radial-gradient(ellipse at 48% 45%, rgba(255, 98, 34, 0.14), transparent 22%),
        radial-gradient(ellipse at 74% 40%, rgba(69, 247, 255, 0.1), transparent 28%),
        linear-gradient(90deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.01));
      box-shadow:
        0 38px 80px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 72px rgba(255, 110, 40, 0.08);
      transform: perspective(1200px) rotateX(63deg) rotateZ(-1.5deg);
      transform-origin: 50% 82%;
      opacity: 0.78;
    }

    .launcher {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .launcher-tile {
      display: grid;
      justify-items: start;
      gap: 4px;
      min-height: 60px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 11px 12px;
      color: #f7fbff;
      background:
        linear-gradient(135deg, rgba(255, 126, 42, 0.16), rgba(69, 247, 255, 0.06)),
        rgba(7, 14, 20, 0.62);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(14px);
    }

    .launcher-tile span {
      font-size: 13px;
      color: #9eb2bc;
    }

    .launcher-tile strong {
      font-size: 15px;
      font-weight: 800;
    }

    .launcher-tile small {
      color: #8ea6b2;
      font-size: 12px;
    }

    .core-stage {
      display: grid;
      position: relative;
      height: min(58vh, 590px);
      min-height: 360px;
      place-items: center;
      touch-action: none;
    }

    .core-stage::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 47%;
      width: min(52vw, 610px);
      height: min(34vw, 390px);
      border-radius: 42% 58% 52% 48%;
      background:
        radial-gradient(circle at 44% 45%, rgba(255, 126, 42, 0.2), transparent 42%),
        radial-gradient(circle at 70% 42%, rgba(69, 247, 255, 0.16), transparent 40%);
      filter: blur(14px);
      transform: translate(-50%, -50%) rotate(-5deg);
      opacity: 0.8;
    }

    .core-canvas {
      position: absolute;
      inset: -6% -5% -2%;
      width: 100%;
      height: 100%;
      mask-image: radial-gradient(
        ellipse at 50% 43%,
        #000 0 46%,
        rgba(0, 0, 0, 0.88) 61%,
        transparent 83%
      );
    }

    .core-readout {
      position: absolute;
      left: 50%;
      top: calc(45% + min(20vw, 132px));
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

    .core-status {
      position: absolute;
      left: 50%;
      bottom: 5%;
      display: grid;
      min-width: min(520px, 92%);
      transform: translateX(-50%);
      justify-items: center;
      gap: 4px;
      border: 1px solid rgba(255, 138, 61, 0.18);
      border-radius: 999px;
      padding: 8px 16px;
      color: #dbe9ee;
      background: rgba(3, 8, 12, 0.56);
      box-shadow: 0 0 32px rgba(255, 115, 39, 0.08);
      backdrop-filter: blur(14px);
    }

    .core-status span {
      font-size: 13px;
      text-align: center;
    }

    .core-status small {
      color: #7e929d;
      font-size: 12px;
    }

    .telemetry-panel {
      display: grid;
      gap: 14px;
      align-self: center;
      min-width: 0;
      border: 1px solid rgba(69, 247, 255, 0.18);
      border-radius: 22px;
      padding: 18px;
      background:
        linear-gradient(180deg, rgba(69, 247, 255, 0.09), rgba(255, 138, 61, 0.045)),
        rgba(4, 12, 18, 0.62);
      box-shadow:
        0 0 56px rgba(69, 247, 255, 0.09),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(18px);
    }

    .telemetry-panel h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
    }

    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .status-grid span,
    .domain-readout p,
    .agent-list p,
    .next-actions p {
      margin: 0;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.035);
    }

    .status-grid span {
      display: grid;
      gap: 3px;
      min-height: 58px;
      padding: 9px 10px;
      color: #99afb9;
      font-size: 12px;
    }

    .status-grid strong {
      color: #f8fdff;
      font-size: 23px;
      line-height: 1;
    }

    .agent-list,
    .domain-readout,
    .next-actions {
      display: grid;
      gap: 8px;
    }

    .agent-list p,
    .domain-readout p,
    .next-actions p {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      padding: 9px 10px;
      color: #9eb2bc;
      font-size: 12px;
    }

    .agent-list span,
    .domain-readout span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-list strong,
    .domain-readout strong {
      flex: 0 0 auto;
      color: #dffcff;
      font-size: 12px;
    }

    .agent-list p.alert strong {
      color: #ffb37e;
    }

    .next-actions p {
      display: block;
      color: #b8cbd4;
      line-height: 1.5;
    }

    .developer-button {
      min-height: 40px;
      border: 1px solid rgba(255, 138, 61, 0.28);
      border-radius: 999px;
      color: #ffd7bf;
      background: rgba(255, 138, 61, 0.08);
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
      width: min(820px, calc(100vw - 48px));
      min-height: 70px;
      border: 1px solid rgba(255, 138, 61, 0.42);
      border-radius: 26px;
      padding: 10px 14px;
      background:
        linear-gradient(90deg, rgba(255, 138, 61, 0.08), rgba(69, 247, 255, 0.06)),
        rgba(9, 16, 22, 0.82);
      box-shadow:
        0 0 56px rgba(255, 104, 38, 0.14),
        0 0 42px rgba(69, 247, 255, 0.06),
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

    .round-button.active {
      background: rgba(69, 247, 255, 0.14);
      box-shadow: 0 0 24px rgba(69, 247, 255, 0.18);
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

    .sensory-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      width: min(760px, calc(100vw - 48px));
    }

    .sensory-button {
      min-height: 34px;
      border: 1px solid rgba(69, 247, 255, 0.18);
      border-radius: 999px;
      padding: 7px 14px;
      color: #9eb2bc;
      background: rgba(69, 247, 255, 0.06);
      font-size: 13px;
    }

    .sensory-button.active {
      color: #dffcff;
      background: rgba(69, 247, 255, 0.14);
      box-shadow: 0 0 24px rgba(69, 247, 255, 0.14);
    }

    .vision-card {
      display: grid;
      grid-template-columns: 96px minmax(0, auto);
      align-items: center;
      gap: 12px;
      width: min(360px, calc(100vw - 48px));
      border: 1px solid rgba(69, 247, 255, 0.2);
      border-radius: 18px;
      padding: 8px 12px 8px 8px;
      color: #dbe9ee;
      background: rgba(4, 12, 18, 0.58);
      font-size: 13px;
      backdrop-filter: blur(14px);
    }

    .vision-preview {
      width: 96px;
      height: 54px;
      border-radius: 12px;
      background: #020407;
      object-fit: cover;
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

    .assistant-reply {
      display: grid;
      gap: 6px;
      width: min(760px, calc(100vw - 48px));
      border: 1px solid rgba(69, 247, 255, 0.18);
      border-radius: 18px;
      padding: 10px 14px;
      color: #dbe9ee;
      background: rgba(4, 12, 18, 0.52);
      font-size: 13px;
      backdrop-filter: blur(14px);
    }

    .assistant-reply strong {
      color: #45f7ff;
      font-size: 12px;
    }

    .assistant-reply > div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .assistant-reply button {
      border: 1px solid rgba(69, 247, 255, 0.22);
      border-radius: 999px;
      padding: 5px 10px;
      color: #dffcff;
      background: rgba(69, 247, 255, 0.08);
      font-size: 12px;
    }

    .assistant-reply p {
      display: -webkit-box;
      max-height: 44px;
      margin: 0;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    @media (max-width: 1100px) {
      .desktop-stage {
        grid-template-columns: 92px minmax(0, 1fr);
      }

      .telemetry-panel {
        position: absolute;
        right: 0;
        top: 4%;
        width: min(300px, 42vw);
      }

      .domain-readout {
        display: none;
      }
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

      .desktop-stage {
        grid-template-columns: minmax(0, 1fr);
      }

      .holo-plane {
        inset: 14% 2% 8%;
        border-radius: 22px;
        transform: perspective(900px) rotateX(64deg) rotateZ(-1deg);
      }

      .launcher {
        display: none;
      }

      .telemetry-panel {
        position: absolute;
        top: 2%;
        right: 0;
        width: min(235px, 64vw);
        padding: 12px;
        gap: 10px;
      }

      .telemetry-panel h2,
      .agent-list {
        display: none;
      }

      .status-grid {
        gap: 7px;
      }

      .status-grid span {
        min-height: 46px;
      }

      .core-stage {
        min-height: 430px;
        height: 54vh;
      }

      .core-readout {
        top: calc(45% + 118px);
      }

      .core-status {
        bottom: 0;
        border-radius: 18px;
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
