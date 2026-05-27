import { afterEach, describe, expect, it, vi } from "vitest";
import "./LongmaCockpit.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function inputValue(element: HTMLElement): string {
  return (element.shadowRoot?.querySelector("input") as HTMLInputElement | null)?.value ?? "";
}

const originalMediaDevices = navigator.mediaDevices;
const originalSpeechRecognition = (globalThis as Record<string, unknown>).SpeechRecognition;
const originalSpeechSynthesis = (globalThis as Record<string, unknown>).speechSynthesis;
const originalSpeechSynthesisUtterance = (globalThis as Record<string, unknown>)
  .SpeechSynthesisUtterance;

describe("LongmaCockpit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    (globalThis as Record<string, unknown>).SpeechRecognition = originalSpeechRecognition;
    (globalThis as Record<string, unknown>).speechSynthesis = originalSpeechSynthesis;
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance =
      originalSpeechSynthesisUtterance;
  });

  it("renders the Chinese Longma OS shell and sends prompt input to the main session", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const hudPayload = {
      generatedAt: "2026-05-26T13:46:18.066Z",
      globalStatus: {
        status: "attention_required",
        runningCount: 0,
        pendingReviewCount: 2,
        alertCount: 0,
      },
      agentGroups: [
        { agentId: "main", displayName: "main", role: "orchestrator", status: "completed" },
        {
          agentId: "engineering-executive",
          displayName: "Engineering Executive",
          role: "execution",
          status: "completed",
        },
        {
          agentId: "front-end-executive",
          displayName: "Front-End Executive",
          role: "execution",
          status: "completed",
        },
        { agentId: "patrol", displayName: "Patrol", role: "observability", status: "unknown" },
      ],
      semanticRebuild: {
        stage: "applied",
        executionStatus: "applied",
      },
      promotionCandidates: { candidateCount: 2 },
      longmaV3: {
        status: "attention_required",
        lanes: {
          memoryContinuity: { status: "online", signalCount: 14 },
          skillDistillation: { status: "ready", signalCount: 2 },
          autonomousEvolution: { status: "needs_attention", signalCount: 1 },
          recoveryLoop: { status: "ready", signalCount: 2 },
        },
        nextActions: [
          "review safe promotion candidates before controlled skill-library writes",
          "drain return and recovery queues through dry-run gates",
        ],
      },
      warnings: [{ id: "w1" }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : "";
      if (url.endsWith("/api/promote-gate/dry-run")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          status: "PASS",
          mode: "dry-run",
          promoted: "none",
        });
      }
      if (url.endsWith("/api/kb/semantic-rebuild-plan")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          status: "ready",
          mode: "dry-run",
          constraintsVerified: {
            embeddingCalls: "no",
            vectorIndexWritten: "no",
          },
        });
      }
      if (url.endsWith("/api/auto-evolution/observe")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          status: "PASS",
          mode: "observe-only",
          observeOnly: true,
          autoEvolutionApplied: false,
        });
      }
      return jsonResponse(hudPayload);
    });

    const element = document.createElement("longma-cockpit") as HTMLElement & {
      connected: boolean;
      devices?: unknown;
      messages?: unknown[];
      sendMessage?: (message: string) => Promise<void>;
      updateComplete: Promise<boolean>;
    };
    const sendMessage = vi.fn(async () => {});
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => cameraStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror = null;
      onend = null;
      onstart = null;

      start() {
        this.dispatchEvent(new Event("start"));
        const event = new Event("result") as Event & {
          resultIndex: number;
          results: Array<{ 0: { transcript: string }; isFinal: boolean }>;
        };
        event.resultIndex = 0;
        event.results = [{ 0: { transcript: "打开状态查询" }, isFinal: true }];
        this.dispatchEvent(event);
      }

      stop() {
        this.dispatchEvent(new Event("end"));
      }

      abort() {
        this.stop();
      }
    }
    (globalThis as Record<string, unknown>).SpeechRecognition = FakeSpeechRecognition;
    class FakeSpeechSynthesisUtterance extends EventTarget {
      rate = 1;
      pitch = 1;

      constructor(readonly text: string) {
        super();
      }
    }
    const speak = vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
      utterance.dispatchEvent(new Event("start"));
    });
    const cancel = vi.fn();
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance =
      FakeSpeechSynthesisUtterance;
    (globalThis as Record<string, unknown>).speechSynthesis = {
      cancel,
      speak,
      speaking: false,
    };
    element.connected = true;
    element.devices = {
      pending: [{ deviceId: "rk3588-node" }],
      paired: [{ deviceId: "windows-main" }],
    };
    element.messages = [
      { role: "user", content: "检查 V3 状态" },
      { role: "assistant", content: [{ type: "text", text: "D13 操作舱在线。" }] },
    ];
    element.sendMessage = sendMessage;
    document.body.appendChild(element);
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;

    const text = element.shadowRoot?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("龙马操作系统");
    expect(text).toContain("龙马核心");
    expect(text).toContain("需要关注");
    expect(text).toContain("4 岗位");
    expect(text).toContain("2 待验收");
    expect(text).toContain("1 警告");
    expect(text).toContain("V3 需要关注");
    expect(text).toContain("记忆 在线 14 语义项");
    expect(text).toContain("技能 就绪 2 候选");
    expect(text).toContain("进化 需要关注 1 建议");
    expect(text).toContain("设备 1 已配对 1 待审批");
    expect(text).toContain("drain return and recovery queues through dry-run gates");
    expect(text).toContain("main 已完成");
    expect(text).toContain("语义知识：已完成");
    expect(text).toContain("龙马回复");
    expect(text).toContain("D13 操作舱在线。");

    const statusButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("状态查询"),
    );
    statusButton?.click();
    await element.updateComplete;
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("查询龙马当前状态"));
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("需要关注 · 4 岗位"));

    const voiceButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("语音待命"),
    );
    voiceButton?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("语音已转文字");
    expect(inputValue(element)).toBe("打开状态查询");

    const cameraButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("摄像头待接入"),
    );
    cameraButton?.click();
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(element.shadowRoot?.textContent).toContain("摄像头已接入");
    expect(element.shadowRoot?.querySelector("video")).not.toBeNull();

    const readReplyButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("朗读回复"),
    );
    readReplyButton?.click();
    await element.updateComplete;
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: "D13 操作舱在线。" }));
    expect(element.shadowRoot?.textContent).toContain("正在朗读回复");

    const distillButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("技能沉淀预检待命"),
    );
    distillButton?.click();
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledWith("/api/promote-gate/dry-run", { method: "POST" });
    expect(element.shadowRoot?.textContent).toContain("技能沉淀预检完成");
    expect(element.shadowRoot?.textContent).toContain("只读 dry-run，未写入技能库");

    const memoryButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("记忆连续预检待命"),
    );
    memoryButton?.click();
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/semantic-rebuild-plan", { method: "POST" });
    expect(element.shadowRoot?.textContent).toContain("记忆连续预检完成");
    expect(element.shadowRoot?.textContent).toContain("未写入向量索引");

    const evolutionButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("自进化观察待命"),
    );
    evolutionButton?.click();
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledWith("/api/auto-evolution/observe", { method: "POST" });
    expect(element.shadowRoot?.textContent).toContain("自进化观察完成");
    expect(element.shadowRoot?.textContent).toContain("未执行自动应用");

    sendMessage.mockClear();
    const input = element.shadowRoot?.querySelector("input") as HTMLInputElement | null;
    input!.value = "检查 V3 状态";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    await element.updateComplete;
    element.shadowRoot
      ?.querySelector("form")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await element.updateComplete;
    await nextFrame();

    expect(sendMessage).toHaveBeenCalledWith("检查 V3 状态");
    expect(element.shadowRoot?.textContent).toContain("已发送到主会话");

    const developerButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("开发者"),
    );
    developerButton?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("返回龙马 OS");
  });
});
