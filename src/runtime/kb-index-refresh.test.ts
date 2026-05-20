import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeIndexFromWorkspace,
  KB_INDEX_FILE_RELATIVE_PATH,
  KB_KEYWORDS_FILE_RELATIVE_PATH,
  KB_SOURCES_FILE_RELATIVE_PATH,
  writeKnowledgeIndexSnapshot,
} from "./kb-index-refresh.js";

function withTempRoot<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-kb-refresh-"));
  try {
    return fn(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeJson(workspaceRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(workspaceRoot: string, relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(workspaceRoot, relativePath), "utf8")) as Record<string, unknown>;
}

describe("KB index refresh", () => {
  it("builds an index and sources summary from workspace case and skill libraries", () => withTempRoot((workspaceRoot) => {
    writeJson(workspaceRoot, "system/case-library/case-a.json", {
      caseId: "case-a",
      title: "D7 lifecycle control",
      problem: "taskId exact matching for pause signal",
      tags: ["D7", "control"],
      risk: "medium",
    });
    writeJson(workspaceRoot, "system/skill-library/skill-a.json", {
      skillId: "skill-a",
      title: "KB refresh",
      trigger: "refresh keyword index",
      keywords: ["refresh-kb-index.ps1"],
      riskLevel: "low",
      status: "draft",
      sourceCases: ["case-a"],
    });

    const { index, sources } = buildKnowledgeIndexFromWorkspace(workspaceRoot, "2026-05-20T00:00:00.000Z");

    expect(index).toMatchObject({
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
    });
    expect(index.keywords.d7).toEqual(["case-a"]);
    expect(sources).toMatchObject({
      caseCount: 1,
      skillCount: 1,
      warnings: [],
    });
    expect(sources.cases[0]).toMatchObject({
      file: "system/case-library/case-a.json",
      caseId: "case-a",
      risk: "medium",
    });
    expect(sources.skills[0]).toMatchObject({
      file: "system/skill-library/skill-a.json",
      skillId: "skill-a",
      status: "draft",
      sourceCases: ["case-a"],
    });
  }));

  it("writes index, keywords, and sources snapshots", () => withTempRoot((workspaceRoot) => {
    writeJson(workspaceRoot, "system/case-library/case-a.json", {
      caseId: "case-a",
      title: "Runtime DAG",
      problem: "ready node resolver",
    });
    writeJson(workspaceRoot, "system/skill-library/skill-a.json", {
      skillId: "skill-a",
      title: "Dispatch planner",
      trigger: "queued task dispatch",
    });

    const result = writeKnowledgeIndexSnapshot(workspaceRoot, "2026-05-20T00:01:00.000Z");

    expect(result).toMatchObject({
      refreshed: true,
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
      indexPath: KB_INDEX_FILE_RELATIVE_PATH,
      keywordsPath: KB_KEYWORDS_FILE_RELATIVE_PATH,
      sourcesPath: KB_SOURCES_FILE_RELATIVE_PATH,
    });
    expect(existsSync(path.join(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH))).toBe(true);
    expect(existsSync(path.join(workspaceRoot, KB_KEYWORDS_FILE_RELATIVE_PATH))).toBe(true);
    expect(existsSync(path.join(workspaceRoot, KB_SOURCES_FILE_RELATIVE_PATH))).toBe(true);
    expect(readJson(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH).totalItems).toBe(2);
    expect(readJson(workspaceRoot, KB_SOURCES_FILE_RELATIVE_PATH).caseCount).toBe(1);
  }));

  it("records parse warnings and skips invalid JSON", () => withTempRoot((workspaceRoot) => {
    mkdirSync(path.join(workspaceRoot, "system/case-library"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "system/case-library/bad.json"), "{bad", "utf8");

    const result = writeKnowledgeIndexSnapshot(workspaceRoot, "2026-05-20T00:02:00.000Z");

    expect(result.totalItems).toBe(0);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Failed to parse system/case-library/bad.json"),
      "system/skill-library directory missing",
    ]));
  }));
});
