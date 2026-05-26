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

describe("LongmaCockpit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the Chinese Longma OS shell and sends prompt input to the main session", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
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
      }),
    );

    const element = document.createElement("longma-cockpit") as HTMLElement & {
      connected: boolean;
      sendMessage?: (message: string) => Promise<void>;
      updateComplete: Promise<boolean>;
    };
    const sendMessage = vi.fn(async () => {});
    element.connected = true;
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
    expect(text).toContain("语义知识：已完成");

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
  });
});
