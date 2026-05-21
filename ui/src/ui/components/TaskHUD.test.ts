import { afterEach, describe, expect, it, vi } from "vitest";
import "./TaskHUD.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("TaskHUD task graph validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("fetches task graph validation and renders validation detail in the task graph section", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/hud/state") {
        return Promise.resolve(jsonResponse({
          generatedAt: "2026-05-21T00:00:00.000Z",
          globalStatus: { status: "healthy" },
          agentGroups: [],
          activeTasks: [],
          attentionQueue: [],
          returnInbox: { pendingItems: [] },
          taskGraphs: {
            items: [
              {
                graphId: "graph-a",
                title: "Graph A",
                aggregateStatus: "running",
                nodeSummary: { total: 2, completed: 1, blocked: 0 },
                lastValidatedAt: "2026-05-21T00:00:00.000Z",
                validationSeverity: "warning",
              },
            ],
          },
          warnings: [],
        }));
      }
      if (url === "/api/task-graph/validation") {
        return Promise.resolve(jsonResponse({
          available: true,
          total: 1,
          valid: false,
          bySeverity: { pass: 0, warning: 1, error: 0 },
          reports: [
            {
              graphId: "graph-a",
              checkedAt: "2026-05-21T00:00:00.000Z",
              severity: "warning",
              errors: [],
              warnings: [{ check: "role_enum", field: "nodes[0].role", message: "unknown role" }],
            },
          ],
        }));
      }
      if (url === "/api/hud/scheduler-events?limit=8") return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    const element = document.createElement("task-hud") as HTMLElement & { updateComplete: Promise<boolean>; panelOpen: boolean };
    document.body.appendChild(element);
    element.panelOpen = true;
    await element.updateComplete;
    await nextFrame();
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? "";
    expect(fetchMock).toHaveBeenCalledWith("/api/task-graph/validation");
    expect(text).toContain("任务图验真");
    expect(text).toContain("错误 0");
    expect(text).toContain("警告 1");
    expect(text).toContain("验真 警告");
    expect(text).toContain("问题 1");
    expect(text).toContain("查看验真明细");
    expect(text).toContain("role_enum");
    expect(text).toContain("nodes[0].role");
    expect(text).toContain("unknown role");
  });
});
