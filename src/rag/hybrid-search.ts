import { DocChunk } from "./doc-loader.js";
import { BM25SearchEngine, BM25ScoredChunk } from "./bm25-search.js";
import { EmbeddingsService, VectorScoredChunk } from "./embeddings.js";
import { filterChunksByConstraints, StoreConstraintContext } from "./constraint-filter.js";
import { RerankerService, type RerankerMode } from "./reranker.js";

export interface DocSearchResult {
  id: string; // Alias for docId
  docId: string;
  chunkId: string;
  title: string;
  category: string;
  sectionHeader: string;
  content: string;
  tags: string[];
  rrfScore: number;
  bm25Rank?: number;
  bm25Score?: number;
  vectorRank?: number;
  vectorSimilarity?: number;
  rerankScore?: number;
  rerankRank?: number;
  metadata: DocChunk["metadata"];
}

export interface HybridSearchOptions extends StoreConstraintContext {
  limit?: number;
  rrfK?: number;
  minVectorSimilarity?: number;
  rerankerMode?: RerankerMode;
  retrievalMode?: "hybrid" | "bm25_only" | "vector_only";
}

/**
 * Merges BM25 lexical rankings and Dense Vector rankings using Reciprocal Rank Fusion (RRF):
 * RRF_Score(d) = 1 / (k + rank_bm25(d)) + 1 / (k + rank_vector(d))
 */
export function computeReciprocalRankFusion(
  bm25Results: BM25ScoredChunk[],
  vectorResults: VectorScoredChunk[],
  k = 60,
  limit = 5
): DocSearchResult[] {
  const fusedMap = new Map<
    string,
    {
      chunk: DocChunk;
      rrfScore: number;
      bm25Rank?: number;
      bm25Score?: number;
      vectorRank?: number;
      vectorSimilarity?: number;
    }
  >();

  for (const item of bm25Results) {
    const rrfContribution = 1 / (k + item.rank);
    fusedMap.set(item.chunk.chunkId, {
      chunk: item.chunk,
      rrfScore: rrfContribution,
      bm25Rank: item.rank,
      bm25Score: item.score,
    });
  }

  for (const item of vectorResults) {
    const rrfContribution = 1 / (k + item.rank);
    const existing = fusedMap.get(item.chunk.chunkId);
    if (existing) {
      existing.rrfScore += rrfContribution;
      existing.vectorRank = item.rank;
      existing.vectorSimilarity = item.similarity;
    } else {
      fusedMap.set(item.chunk.chunkId, {
        chunk: item.chunk,
        rrfScore: rrfContribution,
        vectorRank: item.rank,
        vectorSimilarity: item.similarity,
      });
    }
  }

  const merged = Array.from(fusedMap.values()).sort((a, b) => {
    if (Math.abs(b.rrfScore - a.rrfScore) > 1e-9) {
      return b.rrfScore - a.rrfScore;
    }
    const bm25Diff = (b.bm25Score ?? 0) - (a.bm25Score ?? 0);
    if (Math.abs(bm25Diff) > 1e-9) return bm25Diff;
    return (b.vectorSimilarity ?? 0) - (a.vectorSimilarity ?? 0);
  });

  return merged.slice(0, limit).map((entry) => ({
    id: entry.chunk.docId,
    docId: entry.chunk.docId,
    chunkId: entry.chunk.chunkId,
    title: entry.chunk.title,
    category: entry.chunk.category,
    sectionHeader: entry.chunk.sectionHeader,
    content: entry.chunk.content,
    tags: entry.chunk.metadata.tags,
    rrfScore: Number(entry.rrfScore.toFixed(6)),
    bm25Rank: entry.bm25Rank,
    bm25Score: entry.bm25Score,
    vectorRank: entry.vectorRank,
    vectorSimilarity: entry.vectorSimilarity,
    metadata: entry.chunk.metadata,
  }));
}

export class HybridSearchEngine {
  private chunks: DocChunk[];
  private bm25: BM25SearchEngine;
  private embeddingsService: EmbeddingsService;
  private reranker?: RerankerService;
  private defaultRerankerMode: RerankerMode = "none";

  constructor(
    chunks: DocChunk[],
    embeddingsService: EmbeddingsService,
    reranker?: RerankerService,
    defaultRerankerMode: RerankerMode = "none"
  ) {
    this.chunks = chunks;
    this.bm25 = new BM25SearchEngine(chunks);
    this.embeddingsService = embeddingsService;
    this.reranker = reranker;
    this.defaultRerankerMode = defaultRerankerMode;
  }

  setReranker(reranker: RerankerService | undefined, defaultMode: RerankerMode = "none"): void {
    this.reranker = reranker;
    this.defaultRerankerMode = defaultMode;
  }

  setDefaultRerankerMode(mode: RerankerMode): void {
    this.defaultRerankerMode = mode;
  }

  getDefaultRerankerMode(): RerankerMode {
    return this.defaultRerankerMode;
  }

  updateCorpus(chunks: DocChunk[]): void {
    this.chunks = chunks;
    this.bm25.indexChunks(chunks);
  }

  async search(query: string, options: HybridSearchOptions = {}): Promise<DocSearchResult[]> {
    const limit = options.limit ?? 5;
    const rrfK = options.rrfK ?? 60;
    const minSim = options.minVectorSimilarity ?? 0.15;
    const retrievalMode = options.retrievalMode ?? "hybrid";
    const rerankerMode = options.rerankerMode ?? this.defaultRerankerMode;
    const willRerank = Boolean(this.reranker && rerankerMode !== "none");
    const candidateLimit = willRerank ? Math.max(limit * 3, 12) : limit;

    const { allowedChunkIds } = filterChunksByConstraints(this.chunks, options);
    if (allowedChunkIds.size === 0) return [];

    const bm25Results =
      retrievalMode === "vector_only"
        ? []
        : this.bm25.search(query, allowedChunkIds, Math.max(limit * 3, 15));

    let vectorResults: VectorScoredChunk[] = [];
    if (retrievalMode !== "bm25_only") {
      if (!this.embeddingsService.hasNativeVectorQuery()) {
        await this.embeddingsService.ensureLoaded();
      }
      if (
        this.embeddingsService.hasNativeVectorQuery() ||
        this.embeddingsService.getCachedVectorCount() > 0
      ) {
        try {
          const queryVector = await this.embeddingsService.embedText(query);
          vectorResults = await this.embeddingsService.queryVectors(
            queryVector,
            this.chunks,
            allowedChunkIds,
            {
              limit: Math.max(limit * 3, 15),
              minScore: minSim,
              currency: options.currency,
              country: options.country,
            }
          );
        } catch (err: any) {
          // Graceful fallback to BM25 if embedding endpoint is temporarily unavailable
          if (bm25Results.length === 0) throw err;
        }
      }
    }

    const rrfCandidates = computeReciprocalRankFusion(
      bm25Results,
      vectorResults,
      rrfK,
      candidateLimit
    );

    if (!willRerank || !this.reranker || rrfCandidates.length <= 1) {
      return rrfCandidates.slice(0, limit);
    }

    try {
      const reranked = await this.reranker.rerank(
        query,
        rrfCandidates.map((c) => ({
          chunkId: c.chunkId,
          text: `${c.title} — ${c.sectionHeader}\n${c.content}`,
        })),
        limit,
        rerankerMode
      );

      const byChunkId = new Map(rrfCandidates.map((c) => [c.chunkId, c]));
      const ordered: DocSearchResult[] = [];
      for (const hit of reranked) {
        const doc = byChunkId.get(hit.chunkId);
        if (doc) {
          ordered.push({
            ...doc,
            rerankScore: hit.score,
            rerankRank: hit.rank,
          });
        }
      }
      return ordered.length > 0 ? ordered : rrfCandidates.slice(0, limit);
    } catch {
      // Graceful fallback to RRF order if reranker endpoint fails
      return rrfCandidates.slice(0, limit);
    }
  }

  async searchAsync(query: string, options: HybridSearchOptions = {}): Promise<DocSearchResult[]> {
    return this.search(query, options);
  }
}
