import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { DocChunk } from "./doc-loader.js";
import type { StoreConstraintContext } from "./constraint-filter.js";
import type {
  ChunkEmbedding,
  EmbeddingsMetadata,
  EmbeddingsStore,
} from "./embeddings.js";

/**
 * Converts an arbitrary chunkId string into a deterministic UUID formatted for Qdrant point IDs.
 */
export function chunkIdToUuid(chunkId: string): string {
  const hex = createHash("md5").update(chunkId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface QdrantStoreConfig {
  url?: string;
  apiKey?: string;
  collectionName: string;
  timeoutMs?: number;
}

export interface NativeVectorQueryOptions extends StoreConstraintContext {
  limit: number;
  minScore?: number;
}

export class QdrantEmbeddingsStore implements EmbeddingsStore {
  private client: QdrantClient;
  private url: string;
  private collectionName: string;
  private chunksById: Map<string, DocChunk> = new Map();

  constructor(config: QdrantStoreConfig) {
    this.url = (config.url || process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");
    this.collectionName = config.collectionName;
    this.client = new QdrantClient({
      url: this.url,
      apiKey: config.apiKey || process.env.QDRANT_API_KEY || undefined,
      timeout: config.timeoutMs ?? 30_000,
    });
  }

  public getCollectionName(): string {
    return this.collectionName;
  }

  public getUrl(): string {
    return this.url;
  }

  public setChunks(chunks: DocChunk[]): void {
    this.chunksById.clear();
    for (const c of chunks) {
      this.chunksById.set(c.chunkId, c);
    }
  }

  /**
   * Fast reachability probe so the server and router can detect whether Qdrant is online.
   */
  static async isReachable(
    url = process.env.QDRANT_URL || "http://127.0.0.1:6333",
    timeoutMs = 1500
  ): Promise<boolean> {
    const cleanUrl = url.replace(/\/+$/, "");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers: Record<string, string> = {};
      if (process.env.QDRANT_API_KEY) {
        headers["api-key"] = process.env.QDRANT_API_KEY;
      }
      const res = await fetch(`${cleanUrl}/collections`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async collectionExists(): Promise<boolean> {
    const collections = await this.client.getCollections();
    return collections.collections.some((c) => c.name === this.collectionName);
  }

  private async ensureCollection(dimensions: number): Promise<void> {
    const exists = await this.collectionExists();
    if (exists) {
      const info = await this.client.getCollection(this.collectionName);
      const vecConfig: any = info.config?.params?.vectors;
      const existingDim = typeof vecConfig?.size === "number" ? vecConfig.size : undefined;
      if (existingDim && existingDim !== dimensions) {
        await this.client.deleteCollection(this.collectionName);
      } else {
        return;
      }
    }

    await this.client.createCollection(this.collectionName, {
      vectors: {
        size: dimensions,
        distance: "Cosine",
      },
    });

    // Create payload keyword indexes for fast currency/country filtering
    await Promise.all([
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "supportedCurrencies",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "supportedCountries",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "docId",
        field_schema: "keyword",
      }),
    ]).catch(() => {
      // Non-fatal if index already exists
    });
  }

  async loadEmbeddings(): Promise<Map<string, ChunkEmbedding>> {
    const map = new Map<string, ChunkEmbedding>();
    try {
      if (!(await this.collectionExists())) {
        return map;
      }

      let offset: string | number | Record<string, unknown> | undefined = undefined;
      while (true) {
        const page = await this.client.scroll(this.collectionName, {
          limit: 100,
          offset: offset as any,
          with_payload: true,
          with_vector: true,
        });

        for (const pt of page.points) {
          const payload = (pt.payload ?? {}) as Record<string, any>;
          const chunkId = typeof payload.chunkId === "string" ? payload.chunkId : undefined;
          const hash = typeof payload.hash === "string" ? payload.hash : "";
          const model = typeof payload.model === "string" ? payload.model : undefined;
          const vector = Array.isArray(pt.vector) ? (pt.vector as number[]) : [];
          if (chunkId && vector.length > 0) {
            map.set(chunkId, { chunkId, hash, vector, model });
          }
        }

        if (!page.next_page_offset) break;
        offset = page.next_page_offset as any;
      }
    } catch {
      return new Map();
    }
    return map;
  }

  async saveEmbeddings(
    embeddings: Map<string, ChunkEmbedding>,
    corpusHash: string,
    metadata?: { model?: string; dimensions?: number },
    chunks?: DocChunk[]
  ): Promise<void> {
    if (chunks) {
      this.setChunks(chunks);
    }

    const first = embeddings.values().next().value as ChunkEmbedding | undefined;
    const dimensions = metadata?.dimensions ?? first?.vector?.length;
    if (!dimensions || dimensions <= 0) return;

    await this.ensureCollection(dimensions);

    const activeIds = new Set<string>();
    const points = Array.from(embeddings.values()).map((item) => {
      const uuid = chunkIdToUuid(item.chunkId);
      activeIds.add(uuid);
      const chunk = this.chunksById.get(item.chunkId);
      const currencies =
        chunk?.metadata.supportedCurrencies && chunk.metadata.supportedCurrencies.length > 0
          ? chunk.metadata.supportedCurrencies.map((c) => c.trim().toUpperCase())
          : ["ALL"];
      const countries =
        chunk?.metadata.supportedCountries && chunk.metadata.supportedCountries.length > 0
          ? chunk.metadata.supportedCountries.map((c) => c.trim().toUpperCase())
          : ["ALL"];

      return {
        id: uuid,
        vector: item.vector,
        payload: {
          chunkId: item.chunkId,
          hash: item.hash,
          model: metadata?.model ?? item.model,
          corpusHash,
          dimensions,
          docId: chunk?.docId,
          title: chunk?.title,
          category: chunk?.category,
          sectionHeader: chunk?.sectionHeader,
          content: chunk?.content,
          supportedCurrencies: currencies,
          supportedCountries: countries,
        },
      };
    });

    if (points.length > 0) {
      await this.client.upsert(this.collectionName, {
        wait: true,
        points,
      });
    }

    // Remove orphaned points from deleted/renamed documents
    const stalePointIds: string[] = [];
    let offset: any = undefined;
    while (true) {
      const page = await this.client.scroll(this.collectionName, {
        limit: 100,
        offset,
        with_payload: false,
        with_vector: false,
      });
      for (const pt of page.points) {
        const idStr = String(pt.id);
        if (!activeIds.has(idStr)) {
          stalePointIds.push(idStr);
        }
      }
      if (!page.next_page_offset) break;
      offset = page.next_page_offset;
    }

    if (stalePointIds.length > 0) {
      await this.client.delete(this.collectionName, {
        wait: true,
        points: stalePointIds,
      });
    }
  }

  async getMetadata(): Promise<EmbeddingsMetadata | null> {
    try {
      if (!(await this.collectionExists())) return null;
      const info = await this.client.getCollection(this.collectionName);
      const vecConfig: any = info.config?.params?.vectors;
      const dimensions = typeof vecConfig?.size === "number" ? vecConfig.size : undefined;
      const page = await this.client.scroll(this.collectionName, {
        limit: 1,
        with_payload: true,
        with_vector: false,
      });
      const payload = (page.points[0]?.payload ?? {}) as Record<string, any>;
      return {
        corpusHash: typeof payload.corpusHash === "string" ? payload.corpusHash : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        dimensions: typeof payload.dimensions === "number" ? payload.dimensions : dimensions,
      };
    } catch {
      return null;
    }
  }

  async getCorpusHash(): Promise<string | null> {
    const meta = await this.getMetadata();
    return meta?.corpusHash || null;
  }

  /**
   * Native Qdrant ANN vector search with payload constraint filter pushdown.
   */
  async querySimilar(
    queryVector: number[],
    options: NativeVectorQueryOptions
  ): Promise<Array<{ chunkId: string; similarity: number }>> {
    if (!(await this.collectionExists())) {
      return [];
    }

    const must: any[] = [];
    if (options.currency) {
      must.push({
        key: "supportedCurrencies",
        match: { any: [options.currency.trim().toUpperCase(), "ALL"] },
      });
    }
    if (options.country) {
      must.push({
        key: "supportedCountries",
        match: { any: [options.country.trim().toUpperCase(), "ALL"] },
      });
    }

    const results = await this.client.query(this.collectionName, {
      query: queryVector,
      limit: options.limit,
      ...(must.length > 0 ? { filter: { must } } : {}),
      ...(options.minScore !== undefined ? { score_threshold: options.minScore } : {}),
      with_payload: ["chunkId"],
      with_vector: false,
    });

    return results.points
      .map((r) => ({
        chunkId: String((r.payload as any)?.chunkId || ""),
        similarity: Number((r.score ?? 0).toFixed(6)),
      }))
      .filter((r) => Boolean(r.chunkId));
  }
}
