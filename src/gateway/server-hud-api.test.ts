import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleHudStateHttpRequest,
  summarizeRuntimeLoopFreshness,
} from "./server-hud-api.js";

function makeResponse() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      if (typeof body === "string") chunks.push(body);
    }),
  } as unknown as ServerResponse;
  return {
    res,
    json: () => JSON.parse(chunks.join("")) as Record<string, unknown>,
    text: () => chunks.join(""),
  };
}

function makeReq(url: string, method: string): IncomingMessage {
  return { url, method } as IncomingMessage;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("server HUD API runtime loop freshness", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-hud-api-"));
    roots.push(root);
    return root;
  }

  it("classifies runtime loop freshness from tick timestamps", () => {
    expect(summarizeRuntimeLoopFreshness(
      { tick_at: "2026-05-22T08:00:00.000Z" },
      Date.parse("2026-05-22T08:05:00.000Z"),
    )).toEqual({
      status: "fresh",
      ageMs: 300_000,
      staleAfterMs: 900_000,
    });
    expect(summarizeRuntimeLoopFreshness(
      { tick_at: "2026-05-22T08:00:00.000Z" },
      Date.parse("2026-05-22T08:16:00.000Z"),
    )).toEqual(expect.objectContaining({
      status: "stale",
      ageMs: 960_000,
    }));
    expect(summarizeRuntimeLoopFreshness({})).toEqual(expect.objectContaining({
      status: "missing",
      ageMs: null,
    }));
    expect(summarizeRuntimeLoopFreshness({ tick_at: "not-a-date" })).toEqual(expect.objectContaining({
      status: "invalid",
      ageMs: null,
    }));
  });

  it("surfaces stale runtime loop snapshots without modifying state", async () => {
    const workspaceRoot = makeWorkspace();
    writeJson(path.join(workspaceRoot, "runtime", "main", "tmp", "runtime-loop-state.json"), {
      tickId: "tick-old",
      tick_at: "2026-05-22T08:00:00.000Z",
      mode: "observe",
      scheduler: { intervalMs: 60_000 },
      tasks: { total: 1, queued: 0 },
      dispatch_plan: [],
      return_processor: { inbox_count: 2 },
      warnings: ["observe only"],
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T08:20:00.000Z"));

    const response = makeResponse();
    const handled = await handleHudStateHttpRequest(
      makeReq("/api/hud/runtime-loop", "GET"),
      response.res,
      workspaceRoot,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        latest_tick_id: "tick-old",
        latest_tick_at: "2026-05-22T08:00:00.000Z",
        freshness: {
          status: "stale",
          ageMs: 1_200_000,
          staleAfterMs: 900_000,
        },
        mode: "observe",
        task_summary: { total: 1, queued: 0 },
        dispatch_plan_count: 0,
        inbox_count: 2,
        warnings: [
          "observe only",
          "runtime loop snapshot is stale (20 minutes old)",
        ],
      },
    });
  });
});
