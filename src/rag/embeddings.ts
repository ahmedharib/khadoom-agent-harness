import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { DocChunk } from "./doc-loader.js";
import type { StoreConstraintContext } from "./constraint-filter.js";

export type EmbeddingsProfile = "commercial" | "local";

export function resolveDefaultEmbeddingsPath(profile: EmbeddingsProfile = "commercial"): string {
  const filename = profile === "local" ? "doc-embeddings-qwen.json" : "doc-embeddings.json";
  const cwdCandidate = path.join(process.cwd(), "data", "embeddings", filename);
  if (fsSync.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRootCandidate = path.resolve(__dirname, "..", "..", "data", "embeddings", filename);
  if (fsSync.existsSync(pkgRootCandidate)) {
    return pkgRootCandidate;
  }
  const harnessCandidate = path.join(process.cwd(), "khadoom-agent-harness", "data", "embeddings", filename);
  if (fsSync.existsSync(harnessCandidate)) {
    return harnessCandidate;
  }
  if (fsSync.existsSync(path.resolve(__dirname, "..", "..", "data"))) {
    return pkgRootCandidate;
  }
  return cwdCandidate;
}

export interface ChunkEmbedding {
  chunkId: string;
  hash: string;
  vector: number[];
  model?: string;
}

export interface EmbeddingsMetadata {
  corpusHash?: string;
  model?: string;
  dimensions?: number;
}

export interface PersistedEmbeddingsPayload {
  corpusHash: string;
  model?: string;
  dimensions?: number;
  updatedAt: string;
  items: ChunkEmbedding[];
}

/**
 * Abstract repository interface for chunk embeddings.
 * Can be backed by a local JSON file (`FileEmbeddingsStore`) in CLI mode
 * or swapped with `pgvector`, `sqlite-vec`, or `Qdrant` in a shared cloud RAG service.
 */
export interface EmbeddingsStore {
  loadEmbeddings(): Promise<Map<string, ChunkEmbedding>>;
  saveEmbeddings(
    embeddings: Map<string, ChunkEmbedding>,
    corpusHash: string,
    metadata?: { model?: string; dimensions?: number },
    chunks?: DocChunk[]
  ): Promise<void>;
  getCorpusHash(): Promise<string | null>;
  getMetadata?(): Promise<EmbeddingsMetadata | null>;
  querySimilar?(
    queryVector: number[],
    options: StoreConstraintContext & { limit: number; minScore?: number }
  ): Promise<Array<{ chunkId: string; similarity: number }>>;
}

export class FileEmbeddingsStore implements EmbeddingsStore {
  private filePath: string;

  constructor(filePath = resolveDefaultEmbeddingsPath()) {
    this.filePath = filePath;
  }

  async loadEmbeddings(): Promise<Map<string, ChunkEmbedding>> {
    const map = new Map<string, ChunkEmbedding>();
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: PersistedEmbeddingsPayload = JSON.parse(raw);
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          map.set(item.chunkId, item);
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    return map;
  }

  async saveEmbeddings(
    embeddings: Map<string, ChunkEmbedding>,
    corpusHash: string,
    metadata?: { model?: string; dimensions?: number }
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const firstItem = embeddings.values().next().value as ChunkEmbedding | undefined;
    const payload: PersistedEmbeddingsPayload = {
      corpusHash,
      model: metadata?.model ?? firstItem?.model,
      dimensions: metadata?.dimensions ?? firstItem?.vector?.length,
      updatedAt: new Date().toISOString(),
      items: Array.from(embeddings.values()),
    };
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  async getMetadata(): Promise<EmbeddingsMetadata | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: PersistedEmbeddingsPayload = JSON.parse(raw);
      return {
        corpusHash: parsed.corpusHash,
        model: parsed.model,
        dimensions: parsed.dimensions,
      };
    } catch {
      return null;
    }
  }

  async getCorpusHash(): Promise<string | null> {
    const meta = await this.getMetadata();
    return meta?.corpusHash || null;
  }
}

export class InMemoryEmbeddingsStore implements EmbeddingsStore {
  private map = new Map<string, ChunkEmbedding>();
  private metadata: EmbeddingsMetadata = {};

  async loadEmbeddings(): Promise<Map<string, ChunkEmbedding>> {
    return new Map(this.map);
  }

  async saveEmbeddings(
    embeddings: Map<string, ChunkEmbedding>,
    corpusHash: string,
    metadata?: { model?: string; dimensions?: number }
  ): Promise<void> {
    const firstItem = embeddings.values().next().value as ChunkEmbedding | undefined;
    this.map = new Map(embeddings);
    this.metadata = {
      corpusHash,
      model: metadata?.model ?? firstItem?.model,
      dimensions: metadata?.dimensions ?? firstItem?.vector?.length,
    };
  }

  async getMetadata(): Promise<EmbeddingsMetadata | null> {
    return this.metadata.corpusHash ? { ...this.metadata } : null;
  }

  async getCorpusHash(): Promise<string | null> {
    return this.metadata.corpusHash || null;
  }
}

export function normalizeVector(vec: number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "Qwen/Qwen3-Embedding-0.6B": 1024,
  "qwen3-embedding:0.6b": 1024,
  "BAAI/bge-m3": 1024,
};

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface VectorScoredChunk {
  chunk: DocChunk;
  similarity: number;
  rank: number;
}

export interface EmbeddingsServiceOptions {
  store?: EmbeddingsStore;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  embedder?: (text: string) => Promise<number[]>;
}

export interface SyncEmbeddingsResult {
  embeddings: Map<string, ChunkEmbedding>;
  totalChunks: number;
  cachedChunks: number;
  newChunks: number;
  corpusHash: string;
}

export class EmbeddingsService {
  private store: EmbeddingsStore;
  private openai: OpenAI;
  private model: string;
  private customEmbedder?: (text: string) => Promise<number[]>;
  private memoryCache: Map<string, ChunkEmbedding> = new Map();
  private isHydrated = false;
  private hydrationPromise: Promise<void> | null = null;

  constructor(options: EmbeddingsServiceOptions = {}) {
    this.store = options.store || new FileEmbeddingsStore();
    this.model = options.model || process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    this.customEmbedder = options.embedder;

    const baseURL =
      options.baseURL ?? (process.env.EMBEDDING_BASE_URL || undefined);
    const apiKey =
      options.apiKey ||
      process.env.EMBEDDING_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "dummy_key_for_mock";
    this.openai = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      timeout: 60_000,
    });
  }

  async embedText(text: string): Promise<number[]> {
    if (this.customEmbedder) {
      return this.customEmbedder(text);
    }
    const res = await this.openai.embeddings.create({
      model: this.model,
      input: text,
    });
    const vec = res.data[0]?.embedding;
    if (!vec || vec.length === 0) {
      throw new Error("OpenAI embedding API returned empty vector.");
    }
    return normalizeVector(vec);
  }

  private buildChunkEmbeddingInput(chunk: DocChunk): string {
    return [
      chunk.title,
      chunk.category,
      chunk.sectionHeader,
      (chunk.metadata.entities || []).join(" "),
      (chunk.metadata.tags || []).join(" "),
      chunk.content,
    ].join(" \n ");
  }

  public getEffectiveModelId(): string {
    return this.customEmbedder ? `custom:${this.model}` : this.model;
  }

  public getExpectedDimensions(): number | undefined {
    return this.customEmbedder ? undefined : KNOWN_MODEL_DIMENSIONS[this.model];
  }

  async syncCorpusEmbeddings(
    chunks: DocChunk[],
    corpusHash: string
  ): Promise<SyncEmbeddingsResult> {
    const persisted = await this.store.loadEmbeddings();
    const storeMeta = (await this.store.getMetadata?.()) ?? null;
    const expectedModel = this.getEffectiveModelId();
    let expectedDim = this.getExpectedDimensions();

    // Only treat persisted embeddings as valid for the current model if metadata matches.
    // Untyped legacy files (model === undefined) or model switches trigger re-embedding.
    const persistedModelMatches = storeMeta?.model === expectedModel;
    if (!expectedDim && persistedModelMatches && storeMeta?.dimensions && storeMeta.dimensions > 0) {
      expectedDim = storeMeta.dimensions;
    }

    const updatedMap = new Map<string, ChunkEmbedding>();
    let changed = persisted.size !== chunks.length || !persistedModelMatches;
    let cachedChunks = 0;
    let newChunks = 0;

    for (const chunk of chunks) {
      const memCandidate = this.memoryCache.get(chunk.chunkId);
      const diskCandidate = persistedModelMatches ? persisted.get(chunk.chunkId) : undefined;
      const existing = memCandidate ?? diskCandidate;

      const isDimensionValid =
        existing !== undefined &&
        existing.vector.length > 0 &&
        (expectedDim === undefined || existing.vector.length === expectedDim);
      const isModelValid =
        existing !== undefined && (!existing.model || existing.model === expectedModel);

      if (existing && existing.hash === chunk.hash && isDimensionValid && isModelValid) {
        if (expectedDim === undefined) {
          expectedDim = existing.vector.length;
        }
        updatedMap.set(chunk.chunkId, {
          chunkId: existing.chunkId,
          hash: existing.hash,
          vector: existing.vector,
          model: existing.model ?? expectedModel,
        });
        cachedChunks++;
      } else {
        const inputText = this.buildChunkEmbeddingInput(chunk);
        const vector = await this.embedText(inputText);
        if (expectedDim === undefined) {
          expectedDim = vector.length;
        } else if (vector.length !== expectedDim) {
          throw new Error(
            `Embedder returned inconsistent vector dimensions (${vector.length} vs expected ${expectedDim}).`
          );
        }
        updatedMap.set(chunk.chunkId, {
          chunkId: chunk.chunkId,
          hash: chunk.hash,
          vector,
          model: expectedModel,
        });
        newChunks++;
        changed = true;
      }
    }

    // Reconcile dimensionality across any chunks cached before expectedDim was learned
    if (expectedDim !== undefined) {
      for (const [chunkId, item] of updatedMap.entries()) {
        if (item.vector.length !== expectedDim) {
          const chunk = chunks.find((c) => c.chunkId === chunkId)!;
          const vector = await this.embedText(this.buildChunkEmbeddingInput(chunk));
          updatedMap.set(chunkId, {
            chunkId,
            hash: chunk.hash,
            vector,
            model: expectedModel,
          });
          cachedChunks--;
          newChunks++;
          changed = true;
        }
      }
    }

    const storedCorpusHash = await this.store.getCorpusHash();
    if (
      changed ||
      storedCorpusHash !== corpusHash ||
      storeMeta?.model !== expectedModel ||
      storeMeta?.dimensions !== expectedDim
    ) {
      await this.store.saveEmbeddings(
        updatedMap,
        corpusHash,
        {
          model: expectedModel,
          dimensions: expectedDim,
        },
        chunks
      );
    }

    this.memoryCache = updatedMap;
    this.isHydrated = true;
    return {
      embeddings: updatedMap,
      totalChunks: chunks.length,
      cachedChunks,
      newChunks,
      corpusHash,
    };
  }

  /**
   * Lazily hydrates `memoryCache` from persisted store on first read so callers using
   * `searchDocs()` without calling `syncCorpusAndEmbeddings()` still perform dense vector search.
   */
  async ensureLoaded(): Promise<void> {
    if (this.isHydrated || this.memoryCache.size > 0) {
      this.isHydrated = true;
      return;
    }
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }

    this.hydrationPromise = (async () => {
      try {
        const persisted = await this.store.loadEmbeddings();
        if (persisted.size === 0) return;

        const storeMeta = (await this.store.getMetadata?.()) ?? null;
        const expectedModel = this.getEffectiveModelId();
        if (storeMeta?.model !== expectedModel) {
          return;
        }

        const expectedDim = this.getExpectedDimensions() ?? storeMeta?.dimensions;
        const hydrated = new Map<string, ChunkEmbedding>();
        let discoveredDim = expectedDim;

        for (const [chunkId, item] of persisted.entries()) {
          if (!item.vector || item.vector.length === 0) continue;
          if (discoveredDim === undefined) {
            discoveredDim = item.vector.length;
          }
          if (item.vector.length !== discoveredDim) continue;
          if (item.model && item.model !== expectedModel) continue;
          hydrated.set(chunkId, item);
        }

        this.memoryCache = hydrated;
      } finally {
        this.isHydrated = true;
        this.hydrationPromise = null;
      }
    })();

    return this.hydrationPromise;
  }

  public getCachedVectorCount(): number {
    return this.memoryCache.size;
  }

  public getStore(): EmbeddingsStore {
    return this.store;
  }

  public hasNativeVectorQuery(): boolean {
    return typeof this.store.querySimilar === "function";
  }

  /**
   * Queries either the native VectorDB store (e.g. Qdrant ANN + payload filtering) when available,
   * or falls back to in-memory cosine similarity across hydrated vectors.
   */
  async queryVectors(
    queryVector: number[],
    chunks: DocChunk[],
    allowedChunkIds?: Set<string>,
    options: StoreConstraintContext & { limit?: number; minScore?: number } = {}
  ): Promise<VectorScoredChunk[]> {
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 0;

    if (typeof this.store.querySimilar === "function") {
      const nativeHits = await this.store.querySimilar(queryVector, {
        limit,
        currency: options.currency,
        country: options.country,
        minScore,
      });
      const chunkMap = new Map(chunks.map((c) => [c.chunkId, c]));
      const filtered = nativeHits
        .filter((h) => !allowedChunkIds || allowedChunkIds.has(h.chunkId))
        .map((h) => ({ chunk: chunkMap.get(h.chunkId), similarity: h.similarity }))
        .filter((x): x is { chunk: DocChunk; similarity: number } => Boolean(x.chunk));

      return filtered.slice(0, limit).map((item, idx) => ({
        chunk: item.chunk,
        similarity: Number(item.similarity.toFixed(6)),
        rank: idx + 1,
      }));
    }

    return this.searchVectors(queryVector, chunks, allowedChunkIds, limit).filter(
      (r) => r.similarity >= minScore
    );
  }

  searchVectors(
    queryVector: number[],
    chunks: DocChunk[],
    allowedChunkIds?: Set<string>,
    limit = 10
  ): VectorScoredChunk[] {
    const scored: { chunk: DocChunk; similarity: number }[] = [];

    for (const chunk of chunks) {
      if (allowedChunkIds && !allowedChunkIds.has(chunk.chunkId)) {
        continue;
      }
      const emb = this.memoryCache.get(chunk.chunkId);
      if (!emb) continue;

      const sim = cosineSimilarity(queryVector, emb.vector);
      if (sim > 0) {
        scored.push({ chunk, similarity: sim });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit).map((item, idx) => ({
      chunk: item.chunk,
      similarity: Number(item.similarity.toFixed(6)),
      rank: idx + 1,
    }));
  }
}
