import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { DocChunk } from "./doc-loader.js";

export function resolveDefaultEmbeddingsPath(): string {
  const cwdCandidate = path.join(process.cwd(), "data", "embeddings", "doc-embeddings.json");
  if (fsSync.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRootCandidate = path.resolve(__dirname, "..", "..", "data", "embeddings", "doc-embeddings.json");
  if (fsSync.existsSync(pkgRootCandidate)) {
    return pkgRootCandidate;
  }
  const harnessCandidate = path.join(process.cwd(), "khadoom-agent-harness", "data", "embeddings", "doc-embeddings.json");
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
}

export interface PersistedEmbeddingsPayload {
  corpusHash: string;
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
  saveEmbeddings(embeddings: Map<string, ChunkEmbedding>, corpusHash: string): Promise<void>;
  getCorpusHash(): Promise<string | null>;
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
    corpusHash: string
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedEmbeddingsPayload = {
      corpusHash,
      updatedAt: new Date().toISOString(),
      items: Array.from(embeddings.values()),
    };
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  async getCorpusHash(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: PersistedEmbeddingsPayload = JSON.parse(raw);
      return parsed.corpusHash || null;
    } catch {
      return null;
    }
  }
}

export class InMemoryEmbeddingsStore implements EmbeddingsStore {
  private map = new Map<string, ChunkEmbedding>();
  private corpusHash: string | null = null;

  async loadEmbeddings(): Promise<Map<string, ChunkEmbedding>> {
    return new Map(this.map);
  }

  async saveEmbeddings(
    embeddings: Map<string, ChunkEmbedding>,
    corpusHash: string
  ): Promise<void> {
    this.map = new Map(embeddings);
    this.corpusHash = corpusHash;
  }

  async getCorpusHash(): Promise<string | null> {
    return this.corpusHash;
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

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecB.length === 0) return 0;
  const len = Math.min(vecA.length, vecB.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
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

  constructor(options: EmbeddingsServiceOptions = {}) {
    this.store = options.store || new FileEmbeddingsStore();
    this.model = options.model || "text-embedding-3-small";
    this.customEmbedder = options.embedder;

    const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "dummy_key_for_mock";
    this.openai = new OpenAI({ apiKey });
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

  async syncCorpusEmbeddings(
    chunks: DocChunk[],
    corpusHash: string
  ): Promise<SyncEmbeddingsResult> {
    const persisted = await this.store.loadEmbeddings();
    const updatedMap = new Map<string, ChunkEmbedding>();
    let changed = false;
    let cachedChunks = 0;
    let newChunks = 0;

    for (const chunk of chunks) {
      const existing = persisted.get(chunk.chunkId) || this.memoryCache.get(chunk.chunkId);
      if (existing && existing.hash === chunk.hash && existing.vector.length > 0) {
        updatedMap.set(chunk.chunkId, existing);
        cachedChunks++;
      } else {
        const inputText = this.buildChunkEmbeddingInput(chunk);
        const vector = await this.embedText(inputText);
        updatedMap.set(chunk.chunkId, {
          chunkId: chunk.chunkId,
          hash: chunk.hash,
          vector,
        });
        newChunks++;
        changed = true;
      }
    }

    const storedCorpusHash = await this.store.getCorpusHash();
    if (changed || storedCorpusHash !== corpusHash) {
      await this.store.saveEmbeddings(updatedMap, corpusHash);
    }

    this.memoryCache = updatedMap;
    return {
      embeddings: updatedMap,
      totalChunks: chunks.length,
      cachedChunks,
      newChunks,
      corpusHash,
    };
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
