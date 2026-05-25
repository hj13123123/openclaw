import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

type BuiltinMemoryEmbeddingProviderId =
  | "local"
  | "openai"
  | "gemini"
  | "voyage"
  | "mistral"
  | "ollama"
  | "lmstudio";

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err ?? "");
}

function isMissingApiKeyError(err: unknown): boolean {
  return formatErrorMessage(err).includes("No API key found for provider");
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 24 (recommended for installs/updates; Node 22 LTS, currently 22.14+, remains supported)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    ...["openai", "gemini", "voyage", "mistral"].map(
      (provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function supportsGeminiMultimodalEmbeddings(params: { model: string }): boolean {
  const normalized = params.model
    .trim()
    .replace(/^models\//, "")
    .replace(/^(gemini|google)\//, "");
  return normalized === "gemini-embedding-2-preview";
}

async function loadBuiltinMemoryEmbeddingProviderAdapter(
  id: BuiltinMemoryEmbeddingProviderId,
): Promise<MemoryEmbeddingProviderAdapter> {
  const { getBuiltinMemoryEmbeddingProviderAdapter } = await import("./provider-adapters.js");
  const adapter = getBuiltinMemoryEmbeddingProviderAdapter(id);
  if (!adapter) {
    throw new Error(`unknown built-in memory embedding provider: ${id}`);
  }
  return adapter;
}

function createLazyBuiltinMemoryEmbeddingProviderAdapter(
  adapter: Omit<MemoryEmbeddingProviderAdapter, "create"> & {
    id: BuiltinMemoryEmbeddingProviderId;
  },
): MemoryEmbeddingProviderAdapter {
  return {
    ...adapter,
    create: async (options) =>
      await (await loadBuiltinMemoryEmbeddingProviderAdapter(adapter.id)).create(options),
  };
}

const lazyBuiltinMemoryEmbeddingProviderAdapters: readonly MemoryEmbeddingProviderAdapter[] = [
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "local",
    defaultModel: DEFAULT_LOCAL_MODEL,
    transport: "local",
    autoSelectPriority: 10,
    formatSetupError: formatLocalSetupError,
    shouldContinueAutoSelection: () => true,
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "openai",
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    shouldContinueAutoSelection: isMissingApiKeyError,
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "gemini",
    defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    transport: "remote",
    autoSelectPriority: 30,
    allowExplicitWhenConfiguredAuto: true,
    supportsMultimodalEmbeddings: supportsGeminiMultimodalEmbeddings,
    shouldContinueAutoSelection: isMissingApiKeyError,
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "voyage",
    defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
    transport: "remote",
    autoSelectPriority: 40,
    allowExplicitWhenConfiguredAuto: true,
    shouldContinueAutoSelection: isMissingApiKeyError,
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "mistral",
    defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
    transport: "remote",
    autoSelectPriority: 50,
    allowExplicitWhenConfiguredAuto: true,
    shouldContinueAutoSelection: isMissingApiKeyError,
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "ollama",
    defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    transport: "remote",
  }),
  createLazyBuiltinMemoryEmbeddingProviderAdapter({
    id: "lmstudio",
    defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
    transport: "remote",
  }),
];

export function registerBuiltInMemoryEmbeddingProviders(register: {
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
}): void {
  for (const adapter of lazyBuiltinMemoryEmbeddingProviderAdapters) {
    register.registerMemoryEmbeddingProvider(adapter);
  }
}
