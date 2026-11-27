export type RerankerMode = "none" | "local" | "commercial";

export interface RerankDocument {
  chunkId: string;
  text: string;
}

export interface RerankResult {
  chunkId: string;
  score: number;
  rank: number;
}

export type CustomRerankerFn = (
  query: string,
  documents: RerankDocument[],
  topN: number,
  mode: Exclude<RerankerMode, "none">
) => Promise<RerankResult[]>;

export interface RerankerServiceOptions {
  localBaseURL?: string;
  localApiKey?: string;
  localModel?: string;
  commercialApiKey?: string;
  commercialUrl?: string;
  commercialModel?: string;
  timeoutMs?: number;
  customReranker?: CustomRerankerFn;
}

export class RerankerService {
  private localBaseURL?: string;
  private localApiKey?: string;
  private localModel: string;
  private commercialApiKey?: string;
  private commercialUrl: string;
  private commercialModel: string;
  private timeoutMs: number;
  private customReranker?: CustomRerankerFn;

  constructor(options: RerankerServiceOptions = {}) {
    this.localBaseURL =
      options.localBaseURL ??
      (process.env.RERANKER_BASE_URL || process.env.EMBEDDING_BASE_URL || undefined);
    this.localApiKey =
      options.localApiKey ??
      (process.env.RERANKER_API_KEY || process.env.EMBEDDING_API_KEY || "not-needed");
    this.localModel =
      options.localModel || process.env.RERANKER_MODEL || "BAAI/bge-reranker-v2-m3";

    this.commercialApiKey =
      options.commercialApiKey ?? (process.env.COHERE_API_KEY || undefined);
    this.commercialUrl =
      options.commercialUrl ||
      process.env.COMMERCIAL_RERANKER_URL ||
      "https://api.cohere.com/v2/rerank";
    this.commercialModel =
      options.commercialModel || process.env.COHERE_RERANK_MODEL || "rerank-v3.5";

    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.customReranker = options.customReranker;
  }

  public isLocalConfigured(): boolean {
    return Boolean(this.localBaseURL && this.localBaseURL.trim());
  }

  public isCommercialConfigured(): boolean {
    const key = this.commercialApiKey?.trim();
    return Boolean(key && !key.startsWith("your_"));
  }

  public getModelsInfo() {
    return {
      localModel: this.localModel,
      localBaseURL: this.localBaseURL,
      commercialModel: this.commercialModel,
    };
  }

  /**
   * Checks if the local reranker sidecar endpoint (`/v1/rerank` or `/health`) is live.
   */
  public async probeLocalHealth(timeoutMs = 2000): Promise<{ ok: boolean; reason?: string }> {
    if (!this.localBaseURL) {
      return { ok: false, reason: "RERANKER_BASE_URL / EMBEDDING_BASE_URL not set" };
    }
    const base = this.localBaseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${base}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (data.rerankerModel === null || data.rerankerEnabled === false) {
        return { ok: false, reason: "Reranker sidecar disabled" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Local reranker endpoint unreachable" };
    }
  }

  public async rerank(
    query: string,
    documents: RerankDocument[],
    topN: number,
    mode: RerankerMode
  ): Promise<RerankResult[]> {
    if (mode === "none" || documents.length === 0) {
      return documents.slice(0, topN).map((d, idx) => ({
        chunkId: d.chunkId,
        score: Number((1 / (idx + 1)).toFixed(6)),
        rank: idx + 1,
      }));
    }

    if (this.customReranker) {
      return this.customReranker(query, documents, topN, mode);
    }

    if (mode === "local") {
      return this.callLocalReranker(query, documents, topN);
    }

    return this.callCommercialReranker(query, documents, topN);
  }

  private async callLocalReranker(
    query: string,
    documents: RerankDocument[],
    topN: number
  ): Promise<RerankResult[]> {
    if (!this.localBaseURL) {
      throw new Error("Local reranker is not configured (set RERANKER_BASE_URL or EMBEDDING_BASE_URL).");
    }

    const base = this.localBaseURL.replace(/\/+$/, "");
    const endpoint = base.endsWith("/rerank")
      ? base
      : base.endsWith("/v1")
      ? `${base}/rerank`
      : `${base}/v1/rerank`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.localApiKey ? { Authorization: `Bearer ${this.localApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.localModel,
          query,
          documents: documents.map((d) => d.text),
          top_n: Math.min(topN, documents.length),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Local reranker HTTP ${res.status}: ${errText}`);
      }

      const payload = (await res.json()) as {
        results?: Array<{ index: number; relevance_score?: number; score?: number }>;
      };

      const rawResults = Array.isArray(payload.results) ? payload.results : [];
      return rawResults
        .filter((r) => typeof r.index === "number" && r.index >= 0 && r.index < documents.length)
        .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0))
        .slice(0, topN)
        .map((r, rankIdx) => ({
          chunkId: documents[r.index].chunkId,
          score: Number((r.relevance_score ?? r.score ?? 0).toFixed(6)),
          rank: rankIdx + 1,
        }));
    } finally {
      clearTimeout(timer);
    }
  }

  private async callCommercialReranker(
    query: string,
    documents: RerankDocument[],
    topN: number
  ): Promise<RerankResult[]> {
    if (!this.isCommercialConfigured()) {
      throw new Error("Commercial reranker is not configured (set COHERE_API_KEY in .env).");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.commercialUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.commercialApiKey}`,
        },
        body: JSON.stringify({
          model: this.commercialModel,
          query,
          documents: documents.map((d) => d.text),
          top_n: Math.min(topN, documents.length),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Commercial reranker HTTP ${res.status}: ${errText}`);
      }

      const payload = (await res.json()) as {
        results?: Array<{ index: number; relevance_score?: number }>;
      };

      const rawResults = Array.isArray(payload.results) ? payload.results : [];
      return rawResults
        .filter((r) => typeof r.index === "number" && r.index >= 0 && r.index < documents.length)
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .slice(0, topN)
        .map((r, rankIdx) => ({
          chunkId: documents[r.index].chunkId,
          score: Number((r.relevance_score ?? 0).toFixed(6)),
          rank: rankIdx + 1,
        }));
    } finally {
      clearTimeout(timer);
    }
  }
}
