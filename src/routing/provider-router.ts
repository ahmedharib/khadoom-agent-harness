import { KhadoomAgent } from "../agent/khadoom.agent.js";
import { loadDocumentationCorpusSync } from "../rag/doc-loader.js";
import {
  DocsService,
  FileEmbeddingsStore,
  RerankerService,
  resolveDefaultEmbeddingsPath,
  type EmbeddingsProfile,
  type RerankerMode,
} from "../rag/docs.service.js";
import { QdrantEmbeddingsStore } from "../rag/qdrant-store.js";
import { StagingService } from "../staging/staging.service.js";
import { StoreRepository } from "../storage/store.repository.js";
import { QueryLoggerService } from "../telemetry/query-logger.js";

export type ModelPairId = "commercial" | "local";

export interface RouterOptionStatus<T extends string = string> {
  id: T;
  label: string;
  subtitle: string;
  active: boolean;
  reason?: string;
}

export interface RouterState {
  selectedPair: ModelPairId;
  selectedReranker: RerankerMode;
  vectorDb: {
    mode: "qdrant" | "file";
    url?: string;
    activeCollection: string;
  };
  modelPairs: RouterOptionStatus<ModelPairId>[];
  rerankers: RouterOptionStatus<RerankerMode>[];
}

function isUsableApiKey(val?: string): boolean {
  const trimmed = val?.trim();
  return Boolean(trimmed && !trimmed.startsWith("your_") && trimmed !== "dummy_key_for_mock");
}

async function probeOpenAICompatEndpoint(
  baseURL: string,
  apiKey?: string,
  timeoutMs = 2000
): Promise<boolean> {
  const clean = baseURL.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  for (const candidate of [`${clean}/models`, `${clean.replace(/\/v1$/, "")}/health`]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(candidate, { method: "GET", headers, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}

export interface ProviderRouterOptions {
  repository: StoreRepository;
  stagingService: StagingService;
  queryLogger: QueryLoggerService;
  qdrantUrl?: string;
}

/**
 * Routes chat and retrieval requests across:
 * 1) Commercial Pair (OpenAI GPT-4o-mini + text-embedding-3-small)
 * 2) Local / Open-Weight Pair (Qwen3 via vLLM/Ollama + Qwen3-Embedding-0.6B)
 * while allowing either pair to independently choose None, Local, or Commercial Reranker.
 */
export class ProviderRouter {
  private repository: StoreRepository;
  private stagingService: StagingService;
  private queryLogger: QueryLoggerService;
  private reranker: RerankerService;
  private qdrantUrl: string;

  private docsServices: Partial<Record<ModelPairId, DocsService>> = {};
  private agents: Partial<Record<ModelPairId, KhadoomAgent>> = {};
  private vectorDbMode: "qdrant" | "file" = "file";

  private selectedPair: ModelPairId = "commercial";
  private selectedReranker: RerankerMode = "none";

  private pairStatuses: RouterOptionStatus<ModelPairId>[] = [];
  private rerankerStatuses: RouterOptionStatus<RerankerMode>[] = [];

  constructor(options: ProviderRouterOptions) {
    this.repository = options.repository;
    this.stagingService = options.stagingService;
    this.queryLogger = options.queryLogger;
    this.qdrantUrl = (options.qdrantUrl || process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(
      /\/+$/,
      ""
    );
    this.reranker = new RerankerService();
  }

  private getCollectionName(pair: ModelPairId): string {
    return pair === "local" ? "khadoom_docs_qwen" : "khadoom_docs_openai";
  }

  private async createDocsServiceForPair(
    pair: ModelPairId,
    useQdrant: boolean
  ): Promise<DocsService> {
    const profile: EmbeddingsProfile = pair;
    const fileStore = new FileEmbeddingsStore(resolveDefaultEmbeddingsPath(profile));

    const embeddingModel =
      pair === "local"
        ? process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-0.6B"
        : process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

    const embeddingBaseURL = pair === "local" ? process.env.EMBEDDING_BASE_URL : undefined;
    const embeddingApiKey =
      pair === "local"
        ? process.env.EMBEDDING_API_KEY || "not-needed"
        : process.env.OPENAI_API_KEY || "dummy_key_for_mock";

    let store: FileEmbeddingsStore | QdrantEmbeddingsStore = fileStore;
    if (useQdrant) {
      const qdrantStore = new QdrantEmbeddingsStore({
        url: this.qdrantUrl,
        collectionName: this.getCollectionName(pair),
      });
      const loadedCorpus = loadDocumentationCorpusSync();
      qdrantStore.setChunks(loadedCorpus.chunks);

      // Zero-cost migration: if file store already has vectors for this profile and Qdrant is empty,
      // push the persisted vectors directly into Qdrant without calling the embedding API!
      const qdrantMeta = await qdrantStore.getMetadata();
      if (!qdrantMeta || qdrantMeta.corpusHash !== loadedCorpus.corpusHash) {
        const diskEmbeddings = await fileStore.loadEmbeddings();
        const diskMeta = await fileStore.getMetadata();
        if (
          diskEmbeddings.size > 0 &&
          diskMeta?.corpusHash === loadedCorpus.corpusHash &&
          (!diskMeta.model || diskMeta.model === embeddingModel)
        ) {
          await qdrantStore.saveEmbeddings(
            diskEmbeddings,
            loadedCorpus.corpusHash,
            {
              model: embeddingModel,
              dimensions: diskMeta.dimensions,
            },
            loadedCorpus.chunks
          );
        }
      }
      store = qdrantStore;
    }

    return new DocsService({
      embeddingsStore: store,
      profile,
      embeddingBaseURL,
      embeddingApiKey,
      embeddingModel,
      reranker: this.reranker,
      rerankerMode: this.selectedReranker,
    });
  }

  private createAgentForPair(pair: ModelPairId, docsService: DocsService): KhadoomAgent {
    if (pair === "commercial") {
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
      return new KhadoomAgent(
        this.repository,
        this.stagingService,
        docsService,
        this.queryLogger,
        process.env.OPENAI_API_KEY,
        model,
        {
          baseURL: undefined,
          apiKey: process.env.OPENAI_API_KEY || "dummy_key_for_mock",
          model,
          disableThinking: false,
        }
      );
    }

    const localModel = process.env.LLM_MODEL || "Qwen/Qwen3-8B-FP8";
    return new KhadoomAgent(
      this.repository,
      this.stagingService,
      docsService,
      this.queryLogger,
      process.env.LLM_API_KEY || "not-needed",
      localModel,
      {
        baseURL: process.env.LLM_BASE_URL,
        apiKey: process.env.LLM_API_KEY || "not-needed",
        model: localModel,
        disableThinking:
          process.env.LLM_DISABLE_THINKING !== "false" && /^qwen/i.test(localModel),
      }
    );
  }

  public async initialize(): Promise<RouterState> {
    await this.refreshStatus();

    const activePair = this.pairStatuses.find((p) => p.active);
    if (activePair) {
      // Prefer local if local is active & OpenAI key isn't set, otherwise keep active default
      const commercialActive = this.pairStatuses.find((p) => p.id === "commercial")?.active;
      const localActive = this.pairStatuses.find((p) => p.id === "local")?.active;
      if (localActive && !commercialActive) {
        this.selectedPair = "local";
      } else if (commercialActive && !localActive) {
        this.selectedPair = "commercial";
      } else {
        this.selectedPair = activePair.id;
      }
    }

    // Sync active pair embeddings if Qdrant/disk already ready
    const activeDocs = this.getActiveDocsService();
    try {
      const pairStatus = this.pairStatuses.find((p) => p.id === this.selectedPair);
      if (pairStatus?.active) {
        await activeDocs.syncCorpusAndEmbeddings();
      }
    } catch (err: any) {
      console.warn(`[Router] Non-fatal corpus sync warning for '${this.selectedPair}':`, err?.message);
    }

    return this.getRouterState();
  }

  public async refreshStatus(): Promise<RouterState> {
    const qdrantReachable = await QdrantEmbeddingsStore.isReachable(this.qdrantUrl);
    this.vectorDbMode = qdrantReachable ? "qdrant" : "file";

    // Rebuild or reuse DocsServices and Agents for both pairs
    for (const pair of ["commercial", "local"] as ModelPairId[]) {
      const docs = await this.createDocsServiceForPair(pair, qdrantReachable);
      docs.setRerankerMode(this.selectedReranker);
      this.docsServices[pair] = docs;
      this.agents[pair] = this.createAgentForPair(pair, docs);
    }

    // 1. Evaluate Commercial Pair
    const hasOpenAI = isUsableApiKey(process.env.OPENAI_API_KEY);
    const commercialModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const commercialEmbedModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

    // 2. Evaluate Local Pair
    const localBaseUrl = process.env.LLM_BASE_URL?.trim();
    const localEmbedBaseUrl = process.env.EMBEDDING_BASE_URL?.trim();
    const localModel = process.env.LLM_MODEL || "Qwen/Qwen3-8B-FP8";
    const localEmbedModel = process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-0.6B";

    let localLlmReachable = false;
    let localEmbedReachable = false;
    const [llmOk, embedOk, rerankProbe] = await Promise.all([
      localBaseUrl
        ? probeOpenAICompatEndpoint(localBaseUrl, process.env.LLM_API_KEY)
        : Promise.resolve(false),
      localEmbedBaseUrl
        ? probeOpenAICompatEndpoint(localEmbedBaseUrl, process.env.EMBEDDING_API_KEY)
        : Promise.resolve(false),
      this.reranker.probeLocalHealth(),
    ]);
    localLlmReachable = llmOk;
    localEmbedReachable = embedOk;

    // Check if local Qwen embeddings already exist on disk/Qdrant even if sidecar wasn't specified
    const localStoredEmbeddings = await this.docsServices.local!.getEmbeddingsService().getStore().loadEmbeddings();
    const hasLocalVectors = localStoredEmbeddings.size > 0;

    let localActive = false;
    let localReason: string | undefined;
    if (!localBaseUrl) {
      localReason = "LLM_BASE_URL not set in .env";
    } else if (!localLlmReachable) {
      localReason = "Local LLM endpoint offline";
    } else if (!localEmbedBaseUrl && !hasLocalVectors) {
      localReason = "EMBEDDING_BASE_URL not set & no Qwen embeddings found";
    } else if (localEmbedBaseUrl && !localEmbedReachable && !hasLocalVectors) {
      localReason = "Local embeddings endpoint offline";
    } else {
      localActive = true;
    }

    this.pairStatuses = [
      {
        id: "commercial",
        label: "Commercial (OpenAI)",
        subtitle: `${commercialModel} + ${commercialEmbedModel}`,
        active: hasOpenAI,
        ...(hasOpenAI ? {} : { reason: "OPENAI_API_KEY not set in .env" }),
      },
      {
        id: "local",
        label: "Local / Open-Weight (Qwen 3)",
        subtitle: `${localModel.split("/").pop()} + ${localEmbedModel.split("/").pop()}`,
        active: localActive,
        ...(localActive ? {} : { reason: localReason }),
      },
    ];

    const rerankerMeta = this.reranker.getModelsInfo();
    const commercialRerankActive = this.reranker.isCommercialConfigured();

    this.rerankerStatuses = [
      {
        id: "none",
        label: "Off (Hybrid RRF Only)",
        subtitle: "BM25 + VectorDB RRF fusion",
        active: true,
      },
      {
        id: "local",
        label: "Local Reranker (BGE-M3)",
        subtitle: rerankerMeta.localModel,
        active: rerankProbe.ok,
        ...(rerankProbe.ok ? {} : { reason: rerankProbe.reason || "Offline" }),
      },
      {
        id: "commercial",
        label: "Commercial Reranker (Cohere)",
        subtitle: rerankerMeta.commercialModel,
        active: commercialRerankActive,
        ...(commercialRerankActive ? {} : { reason: "COHERE_API_KEY not set in .env" }),
      },
    ];

    // If current selection became inactive, fall back gracefully
    const curPair = this.pairStatuses.find((p) => p.id === this.selectedPair);
    if (!curPair?.active) {
      const firstActive = this.pairStatuses.find((p) => p.active);
      if (firstActive) this.selectedPair = firstActive.id;
    }

    const curReranker = this.rerankerStatuses.find((r) => r.id === this.selectedReranker);
    if (!curReranker?.active) {
      this.selectedReranker = "none";
      this.docsServices.commercial?.setRerankerMode("none");
      this.docsServices.local?.setRerankerMode("none");
    }

    return this.getRouterState();
  }

  public async setSelection(selection: {
    modelPair?: ModelPairId;
    reranker?: RerankerMode;
  }): Promise<RouterState> {
    if (selection.modelPair) {
      const target = this.pairStatuses.find((p) => p.id === selection.modelPair);
      if (!target) {
        throw new Error(`Unknown model pair '${selection.modelPair}'.`);
      }
      if (!target.active) {
        throw new Error(
          `Model pair '${target.label}' is inactive: ${target.reason || "unavailable"}.`
        );
      }
      this.selectedPair = selection.modelPair;
    }

    if (selection.reranker) {
      const target = this.rerankerStatuses.find((r) => r.id === selection.reranker);
      if (!target) {
        throw new Error(`Unknown reranker mode '${selection.reranker}'.`);
      }
      if (!target.active) {
        throw new Error(
          `Reranker '${target.label}' is inactive: ${target.reason || "unavailable"}.`
        );
      }
      this.selectedReranker = selection.reranker;
      this.docsServices.commercial?.setRerankerMode(this.selectedReranker);
      this.docsServices.local?.setRerankerMode(this.selectedReranker);
    }

    // Ensure selected pair's embeddings are hydrated/synced
    const docs = this.getActiveDocsService();
    try {
      await docs.syncCorpusAndEmbeddings();
    } catch {
      // Non-fatal if already hydrated or offline
    }

    return this.getRouterState();
  }

  public getRouterState(): RouterState {
    return {
      selectedPair: this.selectedPair,
      selectedReranker: this.selectedReranker,
      vectorDb: {
        mode: this.vectorDbMode,
        ...(this.vectorDbMode === "qdrant" ? { url: this.qdrantUrl } : {}),
        activeCollection: this.getCollectionName(this.selectedPair),
      },
      modelPairs: this.pairStatuses,
      rerankers: this.rerankerStatuses,
    };
  }

  public getActivePair(): ModelPairId {
    return this.selectedPair;
  }

  public getActiveRerankerMode(): RerankerMode {
    return this.selectedReranker;
  }

  public getActiveDocsService(): DocsService {
    return this.docsServices[this.selectedPair]!;
  }

  public getActiveAgent(): KhadoomAgent {
    return this.agents[this.selectedPair]!;
  }
}
