import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildKnowledgeIndex,
  type KnowledgeIndex,
  type KnowledgeIndexInputRecord,
  type KnowledgeIndexItem,
  type KnowledgeSourceType,
} from "./kb-index.js";

export const KB_INDEX_DIR_RELATIVE_PATH = "system/kb-index";
export const KB_INDEX_FILE_RELATIVE_PATH = "system/kb-index/index.json";
export const KB_KEYWORDS_FILE_RELATIVE_PATH = "system/kb-index/keywords.json";
export const KB_SOURCES_FILE_RELATIVE_PATH = "system/kb-index/sources.json";

interface KbSourceSummary {
  file: string;
  fileSize: number;
  title: string;
}

interface KbCaseSourceSummary extends KbSourceSummary {
  caseId: string;
  risk: string;
}

interface KbSkillSourceSummary extends KbSourceSummary {
  skillId: string;
  status: string;
  riskLevel: string;
  sourceCases: string[];
}

export interface KbIndexSources {
  generatedAt: string;
  caseCount: number;
  skillCount: number;
  cases: KbCaseSourceSummary[];
  skills: KbSkillSourceSummary[];
  warnings: string[];
}

export interface KbIndexRefreshResult {
  refreshed: true;
  generatedAt: string;
  indexPath: string;
  keywordsPath: string;
  sourcesPath: string;
  totalItems: number;
  sourceCaseCount: number;
  sourceSkillCount: number;
  keywordCount: number;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const single = stringValue(value);
  return single ? [single] : [];
}

function listJsonFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function readInputRecords(
  workspaceRoot: string,
  sourceType: KnowledgeSourceType,
  relativeDir: string,
  warnings: string[],
): KnowledgeIndexInputRecord[] {
  const dirPath = path.join(workspaceRoot, relativeDir);
  if (!existsSync(dirPath)) {
    warnings.push(`${relativeDir} directory missing`);
    return [];
  }

  const records: KnowledgeIndexInputRecord[] = [];
  for (const filePath of listJsonFiles(dirPath)) {
    const sourcePath = path.relative(workspaceRoot, filePath).replace(/\\/gu, "/");
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")) as unknown;
      if (!isRecord(parsed)) {
        warnings.push(`Failed to parse ${sourcePath}: JSON root is not an object`);
        continue;
      }
      records.push({
        sourceType,
        sourcePath,
        fileMtimeIso: statSync(filePath).mtime.toISOString(),
        value: parsed,
      });
    } catch (error) {
      warnings.push(`Failed to parse ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

function sourceSummaries(items: KnowledgeIndexItem[], workspaceRoot: string): Pick<KbIndexSources, "cases" | "skills"> {
  const cases: KbCaseSourceSummary[] = [];
  const skills: KbSkillSourceSummary[] = [];
  for (const item of items) {
    const filePath = path.join(workspaceRoot, item.sourcePath);
    const fileSize = existsSync(filePath) ? statSync(filePath).size : 0;
    if (item.sourceType === "case") {
      cases.push({
        file: item.sourcePath,
        caseId: item.itemId,
        title: item.title,
        risk: item.risk,
        fileSize,
      });
    } else {
      skills.push({
        file: item.sourcePath,
        skillId: item.itemId,
        title: item.title,
        status: item.status ?? "unknown",
        riskLevel: item.risk,
        sourceCases: item.sourceCases ?? [],
        fileSize,
      });
    }
  }
  return { cases, skills };
}

export function buildKnowledgeIndexFromWorkspace(
  workspaceRoot: string,
  generatedAt = new Date().toISOString(),
): { index: KnowledgeIndex; sources: KbIndexSources } {
  const warnings: string[] = [];
  const records = [
    ...readInputRecords(workspaceRoot, "case", "system/case-library", warnings),
    ...readInputRecords(workspaceRoot, "skill", "system/skill-library", warnings),
  ];
  const index = buildKnowledgeIndex(records, generatedAt);
  const { cases, skills } = sourceSummaries(index.items, workspaceRoot);
  return {
    index,
    sources: {
      generatedAt,
      caseCount: cases.length,
      skillCount: skills.length,
      cases,
      skills,
      warnings,
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeKnowledgeIndexSnapshot(
  workspaceRoot: string,
  generatedAt = new Date().toISOString(),
): KbIndexRefreshResult {
  const { index, sources } = buildKnowledgeIndexFromWorkspace(workspaceRoot, generatedAt);
  const indexPath = path.join(workspaceRoot, KB_INDEX_FILE_RELATIVE_PATH);
  const keywordsPath = path.join(workspaceRoot, KB_KEYWORDS_FILE_RELATIVE_PATH);
  const sourcesPath = path.join(workspaceRoot, KB_SOURCES_FILE_RELATIVE_PATH);

  writeJson(indexPath, index);
  writeJson(keywordsPath, {
    generatedAt,
    keywords: index.keywords,
    warnings: sources.warnings,
  });
  writeJson(sourcesPath, sources);

  return {
    refreshed: true,
    generatedAt,
    indexPath: KB_INDEX_FILE_RELATIVE_PATH,
    keywordsPath: KB_KEYWORDS_FILE_RELATIVE_PATH,
    sourcesPath: KB_SOURCES_FILE_RELATIVE_PATH,
    totalItems: index.totalItems,
    sourceCaseCount: index.sourceCaseCount,
    sourceSkillCount: index.sourceSkillCount,
    keywordCount: Object.keys(index.keywords).length,
    warnings: sources.warnings,
  };
}
