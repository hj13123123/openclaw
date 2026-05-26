import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanReturnInbox } from "./return-inbox.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-return-inbox-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): string {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeText(workspaceRoot: string, relativePath: string, value: string): string {
  const filePath = path.join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
  return filePath;
}

describe("return inbox scanner", () => {
  it("scans pending returns without consuming or mutating inbox files", () =>
    withTempRoot((workspaceRoot) => {
      const completePath = writeJson(workspaceRoot, "system/returns/inbox/return-a.json", {
        routing: {
          taskId: "TASK-A",
          sourceRole: "engineering-executive",
          action: "complete",
        },
        outcome: {
          summary: "return summary",
        },
      });
      const incompletePath = writeJson(workspaceRoot, "system/returns/inbox/return-b.json", {
        routing: {
          taskId: "TASK-B",
          sourceRole: "front-end-executive",
        },
      });
      const v2ShapePath = writeJson(workspaceRoot, "system/returns/inbox/return-v2-shape.json", {
        task: {
          taskId: "TASK-V2-SHAPE",
        },
      });
      writeJson(workspaceRoot, "system/returns/inbox/return.mock.skip.json", {
        taskId: "MOCK",
      });
      const malformedPath = writeText(
        workspaceRoot,
        "system/returns/inbox/return-malformed.json",
        "{",
      );
      const before = new Map([
        [completePath, readFileSync(completePath, "utf8")],
        [incompletePath, readFileSync(incompletePath, "utf8")],
        [v2ShapePath, readFileSync(v2ShapePath, "utf8")],
        [malformedPath, readFileSync(malformedPath, "utf8")],
      ]);

      const result = scanReturnInbox(workspaceRoot, { scannedAt: "2026-05-22T09:00:00.000Z" });

      expect(result).toEqual(
        expect.objectContaining({
          mode: "observe-only",
          scannedAt: "2026-05-22T09:00:00.000Z",
          inboxPath: "system/returns/inbox",
          pendingCount: 4,
          completeCount: 1,
          incompleteCount: 3,
          malformedCount: 1,
          skippedMockCount: 1,
          constraintsVerified: {
            consumed: "no",
            archived: "no",
            receiptWritten: "no",
            taskGraphMutated: "no",
            applied: "no",
          },
        }),
      );
      expect(result.pendingItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            returnId: "return-a.json",
            relativePath: "system/returns/inbox/return-a.json",
            taskId: "TASK-A",
            sourceRole: "engineering-executive",
            action: "complete",
            summary: "return summary",
            complete: true,
            malformed: false,
          }),
          expect.objectContaining({
            returnId: "return-b.json",
            taskId: "TASK-B",
            sourceRole: "front-end-executive",
            summary: "[incomplete return]",
            complete: false,
            malformed: false,
          }),
          expect.objectContaining({
            returnId: "return-v2-shape.json",
            taskId: "TASK-V2-SHAPE",
            summary: "[incomplete return]",
            complete: false,
            malformed: false,
          }),
          expect.objectContaining({
            returnId: "return-malformed.json",
            taskId: null,
            summary: "[incomplete return]",
            complete: false,
            malformed: true,
          }),
        ]),
      );
      expect(result.pendingItems.some((item) => item.returnId === "return.mock.skip.json")).toBe(
        false,
      );
      expect(result.warnings).toEqual(["Failed to parse return: return-malformed.json"]);
      for (const [filePath, contents] of before) {
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe(contents);
      }
    }));

  it("reports missing inbox as an observe-only empty scan", () =>
    withTempRoot((workspaceRoot) => {
      expect(scanReturnInbox(workspaceRoot, { scannedAt: "2026-05-22T09:01:00.000Z" })).toEqual({
        mode: "observe-only",
        scannedAt: "2026-05-22T09:01:00.000Z",
        inboxPath: "system/returns/inbox",
        pendingCount: 0,
        completeCount: 0,
        incompleteCount: 0,
        malformedCount: 0,
        skippedMockCount: 0,
        pendingItems: [],
        warnings: ["return inbox directory missing"],
        constraintsVerified: {
          consumed: "no",
          archived: "no",
          receiptWritten: "no",
          taskGraphMutated: "no",
          applied: "no",
        },
      });
    }));
});
