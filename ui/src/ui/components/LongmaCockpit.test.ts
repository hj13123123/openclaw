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

  it("opens a HUD-driven cockpit with telemetry and chat", async () => {
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
        positionConfigAudit: {
          configuredOnlyPositions: ["evolution-curator"],
        },
        positionConfigCleanupGate: {
          status: "ready",
          applyBlockedReason: "frozen",
        },
        returnRepairDryRun: {
          candidateCount: 2,
          repairableCount: 2,
          packagePreviewAvailableCount: 2,
        },
        returnReconciliationApplyPlan: {
          status: "blocked",
          readyStepCount: 4,
          stepCount: 5,
        },
        semanticRebuild: {
          stage: "applied",
          executionStatus: "applied",
        },
        controlSignals: {
          status: "frozen",
          frozen: true,
        },
        mirrorObserve: {
          status: "observe-only",
        },
        autoEvolutionObserve: {
          status: "observe-only",
        },
      }),
    );

    const element = document.createElement("longma-cockpit") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.appendChild(element);
    await element.updateComplete;
    await nextFrame();

    element.shadowRoot?.querySelector("button")?.dispatchEvent(new MouseEvent("click"));
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;

    const text = element.shadowRoot?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("龙马操作舱");
    expect(text).toContain("LONGMA OS");
    expect(text).toContain("岗位 4");
    expect(text).toContain("待验收 2");
    expect(text).toContain("RETURN 2/2");
    expect(text).toContain("preview 2");
    expect(text).toContain("SEMANTIC applied");
    expect(text).toContain("D13");

    const chatButton = Array.from(element.shadowRoot?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.includes("对话"),
    ) as HTMLButtonElement | undefined;
    chatButton?.click();
    await element.updateComplete;

    expect(element.shadowRoot?.textContent).toContain("实时对话");
  });
});
