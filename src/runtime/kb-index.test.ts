import { describe, expect, it } from "vitest";
import {
  buildKnowledgeIndex,
  extractKnowledgeKeywords,
  searchKnowledgeIndex,
  splitKnowledgeBoundary,
  type KnowledgeIndexInputRecord,
} from "./kb-index.js";

const generatedAt = "2026-05-20T00:00:00.000Z";

function record(sourceType: "case" | "skill", value: Record<string, unknown>): KnowledgeIndexInputRecord {
  return {
    sourceType,
    sourcePath: `system/${sourceType}-library/${value.caseId ?? value.skillId}.json`,
    fileMtimeIso: generatedAt,
    value,
  };
}

describe("KB keyword index", () => {
  it("extracts normalized keywords from indexable text", () => {
    expect(extractKnowledgeKeywords("Runtime DAG; task/graph, runtime")).toEqual(["runtime", "dag", "task", "graph"]);
  });

  it("builds keyword-first index from case and skill records", () => {
    const index = buildKnowledgeIndex([
      record("case", {
        caseId: "case-d7",
        title: "D7 lifecycle taskId signal match",
        problem: "pause signal matched role instead of taskId",
        tags: ["D7", "lifecycle"],
        risk: "medium",
      }),
      record("skill", {
        skillId: "skill-kb",
        title: "KB refresh skill",
        trigger: "refresh keyword index",
        keywords: ["refresh-kb-index.ps1"],
        riskLevel: "low",
        status: "draft",
        sourceCases: ["case-d7"],
      }),
    ], generatedAt);

    expect(index).toMatchObject({
      generatedAt,
      version: "1.0",
      indexStrategy: "keyword-first",
      totalItems: 2,
      sourceCaseCount: 1,
      sourceSkillCount: 1,
    });
    expect(index.keywords.d7).toEqual(["case-d7"]);
    expect(index.keywords.lifecycle).toEqual(["case-d7"]);
    expect(index.keywords["refresh-kb-index.ps1"]).toEqual(["skill-kb"]);
  });

  it("uses boundary-aware English token matching and filename penalty", () => {
    const index = buildKnowledgeIndex([
      record("skill", {
        skillId: "skill-file",
        title: "File helper",
        trigger: "refresh-kb-index.ps1",
        keywords: ["refresh-kb-index.ps1"],
      }),
      record("case", {
        caseId: "case-runtime",
        title: "Runtime TaskGraph",
        problem: "TaskGraph resolver handles dependencies",
      }),
    ], generatedAt);

    expect(splitKnowledgeBoundary("TaskGraphResolver")).toEqual(["task", "graph", "resolver"]);
    const results = searchKnowledgeIndex(index, "graph refresh", { limit: 10 });

    expect(results.map((result) => [result.item.itemId, result.score])).toEqual([
      ["case-runtime", 1],
      ["skill-file", 0.5],
    ]);
    expect(results[1]?.matchHits[0]).toMatchObject({ type: "keyword-filename", weight: 0.5 });
  });

  it("matches CJK query tokens by substring and tags by exact match", () => {
    const index = buildKnowledgeIndex([
      record("case", {
        caseId: "case-cn",
        title: "生命周期控制",
        problem: "暂停 信号 必须 精确 匹配 taskId",
        tags: ["控制"],
      }),
    ], generatedAt);

    const results = searchKnowledgeIndex(index, "生命 控制", { matchMode: "All" });

    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(6);
    expect(results[0]?.matchHits.map((hit) => hit.type)).toEqual([
      "keyword-cjk",
      "title",
      "keyword-cjk",
      "tag-exact",
      "title",
    ]);
  });

  it("returns no result in All mode when one query token is missing", () => {
    const index = buildKnowledgeIndex([
      record("case", {
        caseId: "case-dag",
        title: "DAG resolver",
        problem: "ready node resolver",
      }),
    ], generatedAt);

    expect(searchKnowledgeIndex(index, "DAG missing", { matchMode: "All" })).toEqual([]);
  });
});
