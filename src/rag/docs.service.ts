import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMd5,
  type DocChunk,
  loadDocumentationCorpus,
  loadDocumentationCorpusSync,
} from "./doc-loader.js";
import {
  EmbeddingsService,
  type EmbeddingsStore,
  type EmbeddingsProfile,
  FileEmbeddingsStore,
  InMemoryEmbeddingsStore,
  resolveDefaultEmbeddingsPath,
  type SyncEmbeddingsResult,
} from "./embeddings.js";
import {
  type DocSearchResult,
  HybridSearchEngine,
  type HybridSearchOptions,
} from "./hybrid-search.js";
import { RerankerService, type RerankerMode } from "./reranker.js";
import { type CachedDocAnswer, SemanticCache } from "./semantic-cache.js";
import { type StoreConstraintContext } from "./constraint-filter.js";
import type { CitationDetail, CitationPassage } from "./citation-highlighter.js";

export {
  FileEmbeddingsStore,
  InMemoryEmbeddingsStore,
  RerankerService,
  resolveDefaultEmbeddingsPath,
};
export type {
  DocChunk,
  DocSearchResult,
  CachedDocAnswer,
  CitationDetail,
  CitationPassage,
  EmbeddingsStore,
  EmbeddingsProfile,
  RerankerMode,
  StoreConstraintContext,
  SyncEmbeddingsResult,
};

export function resolveDefaultSemanticCachePath(): string {
  const cwdCandidate = path.join(process.cwd(), "data", "cache", "semantic-cache.json");
  if (fsSync.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRootCandidate = path.resolve(__dirname, "..", "..", "data", "cache", "semantic-cache.json");
  if (fsSync.existsSync(pkgRootCandidate)) {
    return pkgRootCandidate;
  }
  const harnessCandidate = path.join(process.cwd(), "khadoom-agent-harness", "data", "cache", "semantic-cache.json");
  if (fsSync.existsSync(harnessCandidate)) {
    return harnessCandidate;
  }
  if (fsSync.existsSync(path.resolve(__dirname, "..", "..", "data"))) {
    return pkgRootCandidate;
  }
  return cwdCandidate;
}

export type SearchDocsOptions = HybridSearchOptions;

export interface DocsServiceConfig {
  docsDir?: string;
  embeddingsStore?: EmbeddingsStore;
  profile?: EmbeddingsProfile;
  embeddingBaseURL?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  reranker?: RerankerService;
  rerankerMode?: RerankerMode;
  similarityThreshold?: number;
  embedder?: (text: string) => Promise<number[]>;
  persistCachePath?: string;
}

export class DocsService {
  private docsDir?: string;
  private chunks: DocChunk[] = [];
  private corpusHash: string;
  private embeddingsService: EmbeddingsService;
  private hybridSearch: HybridSearchEngine;
  private semanticCache: SemanticCache;
  private reranker?: RerankerService;

  constructor(config: DocsServiceConfig = {}) {
    this.docsDir = config.docsDir;
    const loaded = loadDocumentationCorpusSync(this.docsDir);

    if (loaded.chunks.length === 0) {
      throw new Error(
        `No documentation files found in '${this.docsDir || "data/docs"}'. Please ensure Markdown files exist under data/docs.`
      );
    }

    this.chunks = loaded.chunks;
    this.corpusHash = loaded.corpusHash;

    const store =
      config.embeddingsStore ||
      new FileEmbeddingsStore(resolveDefaultEmbeddingsPath(config.profile ?? "commercial"));

    this.embeddingsService = new EmbeddingsService({
      store,
      ...("embeddingBaseURL" in config ? { baseURL: config.embeddingBaseURL } : {}),
      apiKey: config.embeddingApiKey,
      model: config.embeddingModel,
      embedder: config.embedder,
    });

    this.reranker = config.reranker;
    this.hybridSearch = new HybridSearchEngine(
      this.chunks,
      this.embeddingsService,
      this.reranker,
      config.rerankerMode ?? "none"
    );
    this.semanticCache = new SemanticCache(this.embeddingsService, {
      corpusHash: this.corpusHash,
      similarityThreshold: config.similarityThreshold ?? 0.9,
      persistPath: config.persistCachePath ?? resolveDefaultSemanticCachePath(),
    });
  }

  public setReranker(reranker: RerankerService, defaultMode: RerankerMode = "none"): void {
    this.reranker = reranker;
    this.hybridSearch.setReranker(reranker, defaultMode);
  }

  public setRerankerMode(mode: RerankerMode): void {
    this.hybridSearch.setDefaultRerankerMode(mode);
  }

  public getRerankerMode(): RerankerMode {
    return this.hybridSearch.getDefaultRerankerMode();
  }

  public getEmbeddingsService(): EmbeddingsService {
    return this.embeddingsService;
  }

  /**
   * Reloads Markdown corpus from disk, persists updated chunk embeddings to `EmbeddingsStore`,
   * and invalidates semantic cache if the corpus hash changed.
   */
  async syncCorpusAndEmbeddings(docsDir = this.docsDir): Promise<SyncEmbeddingsResult> {
    const loaded = await loadDocumentationCorpus(docsDir);
    if (loaded.chunks.length > 0) {
      this.chunks = loaded.chunks;
      this.corpusHash = loaded.corpusHash;
    }
    const result = await this.embeddingsService.syncCorpusEmbeddings(this.chunks, this.corpusHash);
    this.hybridSearch.updateCorpus(this.chunks);
    this.semanticCache.syncCorpusHash(this.corpusHash);
    return result;
  }

  /**
   * Simulates or applies a corpus hash update (e.g., when a doc file is edited)
   * and flushes stale semantic cache entries.
   */
  updateCorpusHash(newCorpusHash: string): void {
    this.corpusHash = newCorpusHash;
    this.semanticCache.syncCorpusHash(newCorpusHash);
  }

  getCorpusHash(): string {
    return this.corpusHash;
  }

  getChunks(): DocChunk[] {
    return this.chunks;
  }

  /**
   * Hybrid Search (BM25 + Dense Vector RRF + Store Constraint Filtering).
   */
  async searchDocs(query: string, options: SearchDocsOptions = {}): Promise<DocSearchResult[]> {
    return this.hybridSearch.search(query, options);
  }

  /**
   * Alias to searchDocs.
   */
  async searchDocsAsync(
    query: string,
    options: SearchDocsOptions = {}
  ): Promise<DocSearchResult[]> {
    return this.searchDocs(query, options);
  }

  /**
   * Looks up a cached answer in the context-scoped Tier 2 Semantic Cache.
   */
  async getCachedAnswer(
    query: string,
    options?: StoreConstraintContext
  ): Promise<string | undefined> {
    const hit = await this.semanticCache.get(query, options);
    return hit?.answer;
  }

  /**
   * Looks up the full cached answer entry (including citations, similarity, and hitType).
   */
  async getCachedEntry(
    query: string,
    options?: StoreConstraintContext
  ): Promise<CachedDocAnswer | undefined> {
    return this.semanticCache.get(query, options);
  }

  /**
   * Stores an answer in the context-scoped Tier 2 Semantic Cache.
   */
  async setCachedAnswer(
    query: string,
    answer: string,
    citations: string[] = ["Semantic Cache (Mtajir Docs)"],
    options?: StoreConstraintContext,
    citationDetails?: CitationDetail[]
  ): Promise<void> {
    await this.semanticCache.set(query, answer, citations, options, citationDetails);
  }
}
