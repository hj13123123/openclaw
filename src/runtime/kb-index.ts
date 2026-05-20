export type KnowledgeSourceType = "case" | "skill";

export interface KnowledgeIndexItem {
  itemId: string;
  sourceType: KnowledgeSourceType;
  sourcePath: string;
  title: string;
  summary: string;
  tags: string[];
  keywords: string[];
  risk: string;
  status?: string;
  sourceCases?: string[];
  promotedToSkill?: string | null;
  promotedToRule?: string | null;
  createdAt: string;
}

export interface KnowledgeIndex {
  generatedAt: string;
  version: "1.0";
  indexStrategy: "keyword-first";
  totalItems: number;
  sourceCaseCount: number;
  sourceSkillCount: number;
  items: KnowledgeIndexItem[];
  keywords: Record<string, string[]>;
}

export interface KnowledgeIndexInputRecord {
  sourceType: KnowledgeSourceType;
  sourcePath: string;
  fileMtimeIso: string;
  value: Record<string, unknown>;
}

export interface KnowledgeMatchHit {
  query: string;
  type: "keyword-cjk" | "keyword-eng" | "keyword-filename" | "tag-exact" | "title";
  matched: string;
  weight: number;
}

export interface KnowledgeMatchResult {
  item: KnowledgeIndexItem;
  score: number;
  matchHits: KnowledgeMatchHit[];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const single = stringValue(value);
  return single ? [single] : [];
}

function lowerUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function truncate(value: string, maxLength = 200): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

export function extractKnowledgeKeywords(text: string): string[] {
  return lowerUnique(text.split(/[,\s;|/]+/u).map((value) => value.trim()).filter((value) => value.length > 1));
}

function allTags(value: Record<string, unknown>): string[] {
  return lowerUnique([
    ...stringArray(value.distillationTags),
    ...stringArray(value.tags),
    ...stringArray(value.taskTags),
    ...stringArray(value.positionTags),
    ...stringArray(value.keywords),
  ]);
}

function indexableText(value: Record<string, unknown>): string {
  return [
    stringValue(value.title),
    stringValue(value.summary),
    stringValue(value.problem),
    stringValue(value.resolution),
    stringValue(value.description),
    stringValue(value.reusablePattern),
    stringValue(value.trigger),
  ].filter((item): item is string => item !== null).join(" ");
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeKnowledgeIndexItem(record: KnowledgeIndexInputRecord): KnowledgeIndexItem | null {
  const value = record.value;
  const tags = allTags(value);
  const keywords = extractKnowledgeKeywords(indexableText(value));

  if (record.sourceType === "case") {
    const itemId = stringValue(value.caseId) ?? stringValue(value.id);
    if (!itemId) return null;
    return {
      itemId,
      sourceType: "case",
      sourcePath: record.sourcePath,
      title: stringValue(value.title) ?? itemId,
      summary: truncate(stringValue(value.problem) ?? stringValue(value.summary) ?? ""),
      tags,
      keywords,
      risk: stringValue(value.risk) ?? "unknown",
      promotedToSkill: stringValue(value.promotedToSkill),
      promotedToRule: stringValue(value.promotedToRule),
      createdAt: stringValue(value.createdAt) ?? record.fileMtimeIso,
    };
  }

  const itemId = stringValue(value.skillId) ?? stringValue(value.id);
  if (!itemId) return null;
  return {
    itemId,
    sourceType: "skill",
    sourcePath: record.sourcePath,
    title: stringValue(value.title) ?? itemId,
    summary: truncate(stringValue(value.trigger) ?? stringValue(value.summary) ?? ""),
    tags,
    keywords,
    risk: stringValue(value.riskLevel) ?? "unknown",
    status: stringValue(value.status) ?? "unknown",
    sourceCases: stringArray(value.sourceCases),
    createdAt: stringValue(value.createdAt) ?? record.fileMtimeIso,
  };
}

function buildKeywordMap(items: KnowledgeIndexItem[]): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const item of items) {
    for (const keyword of [...item.tags, ...item.keywords]) {
      if (keyword.length < 2) continue;
      const values = map.get(keyword) ?? new Set<string>();
      values.add(item.itemId);
      map.set(keyword, values);
    }
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [
    key,
    [...values],
  ]));
}

export function buildKnowledgeIndex(records: KnowledgeIndexInputRecord[], generatedAt: string): KnowledgeIndex {
  const items = records
    .map(normalizeKnowledgeIndexItem)
    .filter((item): item is KnowledgeIndexItem => item !== null);
  return {
    generatedAt,
    version: "1.0",
    indexStrategy: "keyword-first",
    totalItems: items.length,
    sourceCaseCount: items.filter((item) => item.sourceType === "case").length,
    sourceSkillCount: items.filter((item) => item.sourceType === "skill").length,
    items,
    keywords: buildKeywordMap(items),
  };
}

export function splitKnowledgeBoundary(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/\W+/u)
    .filter(Boolean)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/u))
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function isCjk(text: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text);
}

function isFilename(text: string): boolean {
  return /\.(ps1|mjs|ts|js|json|md|tsx|jsx|yaml|yml|css|html)$/iu.test(text);
}

function scoreKnowledgeItem(item: KnowledgeIndexItem, queryTokens: string[], matchMode: "Any" | "All"): KnowledgeMatchResult | null {
  let score = 0;
  let anyMatched = false;
  let allMatched = true;
  const matchHits: KnowledgeMatchHit[] = [];
  const englishTokenMap = new Map<string, string[]>();
  const cjkStrings: string[] = [];
  const filenameSet = new Set<string>();

  for (const keyword of item.keywords) {
    const keywordLower = keyword.toLowerCase();
    if (isFilename(keyword)) filenameSet.add(keywordLower);
    if (isCjk(keyword)) cjkStrings.push(keywordLower);
    for (const token of splitKnowledgeBoundary(keyword)) {
      englishTokenMap.set(token, [...(englishTokenMap.get(token) ?? []), keywordLower]);
    }
  }

  for (const queryToken of queryTokens) {
    const token = queryToken.toLowerCase();
    let termMatched = false;

    if (isCjk(token)) {
      const matched = cjkStrings.find((candidate) => candidate.includes(token));
      if (matched) {
        score += 1;
        termMatched = true;
        matchHits.push({ query: token, type: "keyword-cjk", matched, weight: 1 });
      } else if (englishTokenMap.has(token)) {
        score += 1;
        termMatched = true;
        matchHits.push({ query: token, type: "keyword-eng", matched: token, weight: 1 });
      }
    } else {
      const sourceKeywords = englishTokenMap.get(token);
      if (sourceKeywords) {
        const hasFilename = sourceKeywords.some((keyword) => filenameSet.has(keyword));
        const weight = hasFilename ? 0.5 : 1;
        score += weight;
        termMatched = true;
        matchHits.push({
          query: token,
          type: hasFilename ? "keyword-filename" : "keyword-eng",
          matched: sourceKeywords.join(","),
          weight,
        });
      }
    }

    if (item.tags.includes(token)) {
      score += 2;
      termMatched = true;
      matchHits.push({ query: token, type: "tag-exact", matched: token, weight: 2 });
    }

    if (item.title.toLowerCase().includes(token)) {
      score += 1;
      termMatched = true;
      matchHits.push({ query: token, type: "title", matched: "(title)", weight: 1 });
    }

    if (termMatched) anyMatched = true;
    else allMatched = false;
  }

  if (matchMode === "All" && !allMatched) return null;
  if (!anyMatched) return null;
  return { item, score, matchHits };
}

export function searchKnowledgeIndex(
  index: Pick<KnowledgeIndex, "items">,
  query: string,
  options: { limit?: number; matchMode?: "Any" | "All" } = {},
): KnowledgeMatchResult[] {
  const queryTokens = extractKnowledgeKeywords(query);
  if (queryTokens.length === 0) return [];
  const matchMode = options.matchMode ?? "Any";
  const limit = Math.max(0, Math.floor(options.limit ?? 10));
  return index.items
    .map((item) => scoreKnowledgeItem(item, queryTokens, matchMode))
    .filter((item): item is KnowledgeMatchResult => item !== null)
    .sort((a, b) => b.score - a.score || a.item.itemId.localeCompare(b.item.itemId))
    .slice(0, limit);
}

export function extractTaskRecallText(value: Record<string, unknown>): string {
  return [
    stringValue(value.taskId),
    stringValue(value.title),
    stringValue(value.summary),
    stringValue(value.description),
    stringValue(nestedRecord(value.metadata)?.summary),
  ].filter((item): item is string => item !== null).join(" ");
}
