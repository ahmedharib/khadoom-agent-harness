import { DocChunk } from "./doc-loader.js";
import { BM25SearchEngine, BM25ScoredChunk } from "./bm25-search.js";
import { EmbeddingsService, VectorScoredChunk } from "./embeddings.js";
import { filterChunksByConstraints, StoreConstraintContext } from "./constraint-filter.js";

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
  metadata: DocChunk["metadata"];
}

export interface HybridSearchOptions extends StoreConstraintContext {
  limit?: number;
  rrfK?: number;
  minVectorSimilarity?: number;
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

  constructor(chunks: DocChunk[], embeddingsService: EmbeddingsService) {
    this.chunks = chunks;
    this.bm25 = new BM25SearchEngine(chunks);
    this.embeddingsService = embeddingsService;
  }

  updateCorpus(chunks: DocChunk[]): void {
    this.chunks = chunks;
    this.bm25.indexChunks(chunks);
  }

  async search(query: string, options: HybridSearchOptions = {}): Promise<DocSearchResult[]> {
    const limit = options.limit ?? 5;
    const rrfK = options.rrfK ?? 60;
    const minSim = options.minVectorSimilarity ?? 0.15;

    const { allowedChunkIds } = filterChunksByConstraints(this.chunks, options);
    if (allowedChunkIds.size === 0) return [];

    const bm25Results = this.bm25.search(query, allowedChunkIds, limit * 3);
    const queryVector = await this.embeddingsService.embedText(query);
    const rawVectorResults = this.embeddingsService.searchVectors(
      queryVector,
      this.chunks,
      allowedChunkIds,
      limit * 3
    );
    const vectorResults = rawVectorResults.filter((r) => r.similarity >= minSim);

    return computeReciprocalRankFusion(bm25Results, vectorResults, rrfK, limit);
  }

  async searchAsync(query: string, options: HybridSearchOptions = {}): Promise<DocSearchResult[]> {
    return this.search(query, options);
  }
}
