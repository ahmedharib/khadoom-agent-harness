import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveDefaultQueryLogPath(): string {
  const cwdCandidate = path.join(process.cwd(), "data", "logs", "query-logs.jsonl");
  if (fsSync.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRootCandidate = path.resolve(__dirname, "..", "..", "data", "logs", "query-logs.jsonl");
  if (fsSync.existsSync(pkgRootCandidate)) {
    return pkgRootCandidate;
  }
  const harnessCandidate = path.join(process.cwd(), "khadoom-agent-harness", "data", "logs", "query-logs.jsonl");
  if (fsSync.existsSync(harnessCandidate)) {
    return harnessCandidate;
  }
  if (fsSync.existsSync(path.resolve(__dirname, "..", "..", "data"))) {
    return pkgRootCandidate;
  }
  return cwdCandidate;
}

export interface ModelPricingTier {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricingTier> = {
  "gpt-4o-mini": {
    inputPerMillion: 0.150,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.600,
  },
  "gpt-4o": {
    inputPerMillion: 2.50,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10.00,
  },
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens?: number;
}

export interface CostBreakdown {
  uncachedInputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export type QueryIntentType =
  | "mutation"
  | "doc_question"
  | "store_inspection"
  | "navigation"
  | "conversation"
  | "error";

export type ProviderMode = "openai_api" | "custom_endpoint";

export interface QueryLogEntry {
  id: string;
  timestamp: string;
  storeId: string;
  userPrompt: string;
  model: string;
  providerType?: ProviderMode;
  latencyMs: number;
  llmLatencyMs?: number;
  llmCallsCount?: number;
  tokensPerSecond?: number;
  msPerOutputToken?: number;
  intentType: QueryIntentType;
  toolCalls: string[];
  retriesCount: number;
  jsonParseErrorsCount?: number;
  semanticCacheHit?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  status: "success" | "error";
  errorMessage?: string;
}

export interface ModelBenchmarkSummary {
  queries: number;
  providerType: ProviderMode | "mixed";
  avgPromptTokens: number;
  avgCompletionTokens: number;
  cacheHitRatePct: number;
  totalCostUsd: number;
  avgCostPerQueryUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgLlmLatencyMs: number;
  avgTokensPerSecond: number;
  avgMsPerOutputToken: number;
  avgLlmCallsPerQuery: number;
  retryRatePct: number;
  jsonParseErrorCount: number;
  errorRatePct: number;
  semanticCacheHits: number;
}

export interface UsageSummary {
  totalQueries: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgLlmLatencyMs: number;
  avgTokensPerSecond: number;
  avgMsPerOutputToken: number;
  avgLlmCallsPerQuery: number;
  totalRetries: number;
  totalJsonParseErrors: number;
  semanticCacheHits: number;
  cacheHitRatePct: number;
  mutationsCount: number;
  questionsCount: number;
  byModel: Record<string, ModelBenchmarkSummary>;
}

export interface CostCalculationOptions {
  latencyMs?: number;
  hourlyCostUsd?: number;
}

/**
 * Calculates USD cost based on token counts and known model pricing,
 * optional per-token env overrides, or amortized GPU runtime hourly pricing
 * (e.g. LLM_HOURLY_COST_USD=0.25 for an L4 instance).
 */
export function calculateCost(
  model: string,
  usage: TokenUsage,
  options?: CostCalculationOptions
): CostBreakdown {
  const known = MODEL_PRICING[model];
  const envIn = process.env.LLM_INPUT_COST_PER_M ? Number(process.env.LLM_INPUT_COST_PER_M) : undefined;
  const envOut = process.env.LLM_OUTPUT_COST_PER_M ? Number(process.env.LLM_OUTPUT_COST_PER_M) : undefined;

  const pricing: ModelPricingTier = known ?? {
    inputPerMillion: Number.isFinite(envIn) ? envIn! : 0,
    cachedInputPerMillion: Number.isFinite(envIn) ? envIn! : 0,
    outputPerMillion: Number.isFinite(envOut) ? envOut! : 0,
  };

  const cachedTokens = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncachedPromptTokens = Math.max(0, usage.promptTokens - cachedTokens);

  const uncachedInputCostUsd = (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion;
  const cachedInputCostUsd = (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
  const outputCostUsd = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;

  let runtimeCostUsd = 0;
  if (!known && pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0) {
    const envHourly = process.env.LLM_HOURLY_COST_USD ? Number(process.env.LLM_HOURLY_COST_USD) : undefined;
    const hourlyRate =
      options?.hourlyCostUsd ?? (Number.isFinite(envHourly) ? envHourly! : 0);
    if (hourlyRate > 0 && options?.latencyMs && options.latencyMs > 0) {
      runtimeCostUsd = (options.latencyMs / 3_600_000) * hourlyRate;
    }
  }

  const totalCostUsd = uncachedInputCostUsd + cachedInputCostUsd + outputCostUsd + runtimeCostUsd;

  return {
    uncachedInputCostUsd: Number(uncachedInputCostUsd.toFixed(8)),
    cachedInputCostUsd: Number(cachedInputCostUsd.toFixed(8)),
    outputCostUsd: Number((outputCostUsd + runtimeCostUsd).toFixed(8)),
    totalCostUsd: Number(totalCostUsd.toFixed(8)),
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

function summarizeGroup(entries: QueryLogEntry[]): ModelBenchmarkSummary {
  const n = entries.length;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;
  let totalLatency = 0;
  let totalLlmLatency = 0;
  let llmLatencyCount = 0;
  let totalLlmCalls = 0;
  let llmCallsPresentCount = 0;
  let totalRetries = 0;
  let jsonParseErrorCount = 0;
  let errorCount = 0;
  let semanticCacheHits = 0;
  let liveLlmLatencySum = 0;
  let liveCompletionSum = 0;
  const providers = new Set<ProviderMode>();
  const latencies: number[] = [];

  for (const e of entries) {
    totalPrompt += e.usage.promptTokens;
    totalCompletion += e.usage.completionTokens;
    totalCached += e.usage.cachedTokens;
    totalCost += e.cost.totalCostUsd;
    totalLatency += e.latencyMs;
    latencies.push(e.latencyMs);
    totalRetries += e.retriesCount ?? 0;
    jsonParseErrorCount += e.jsonParseErrorsCount ?? 0;
    if (e.status === "error") errorCount++;
    if (e.semanticCacheHit) semanticCacheHits++;
    if (e.providerType) providers.add(e.providerType);

    const effLlmMs = e.llmLatencyMs ?? (e.semanticCacheHit ? 0 : e.latencyMs);
    if (!e.semanticCacheHit && effLlmMs > 0) {
      totalLlmLatency += effLlmMs;
      llmLatencyCount++;
      liveLlmLatencySum += effLlmMs;
      liveCompletionSum += e.usage.completionTokens;
    }

    if (typeof e.llmCallsCount === "number") {
      totalLlmCalls += e.llmCallsCount;
      llmCallsPresentCount++;
    } else if (!e.semanticCacheHit) {
      totalLlmCalls += 1 + (e.toolCalls?.length ?? 0) + (e.retriesCount ?? 0);
      llmCallsPresentCount++;
    }
  }

  latencies.sort((a, b) => a - b);
  const avgTokensPerSecond =
    liveLlmLatencySum > 0 && liveCompletionSum > 0
      ? Number(((liveCompletionSum * 1000) / liveLlmLatencySum).toFixed(2))
      : 0;
  const avgMsPerOutputToken =
    liveCompletionSum > 0 && liveLlmLatencySum > 0
      ? Number((liveLlmLatencySum / liveCompletionSum).toFixed(2))
      : 0;

  return {
    queries: n,
    providerType: providers.size === 1 ? [...providers][0] : "mixed",
    avgPromptTokens: Math.round(totalPrompt / n),
    avgCompletionTokens: Math.round(totalCompletion / n),
    cacheHitRatePct:
      totalPrompt > 0 ? Number(((totalCached / totalPrompt) * 100).toFixed(1)) : 0,
    totalCostUsd: Number(totalCost.toFixed(6)),
    avgCostPerQueryUsd: Number((totalCost / n).toFixed(6)),
    avgLatencyMs: Math.round(totalLatency / n),
    p50LatencyMs: Math.round(percentile(latencies, 0.5)),
    p95LatencyMs: Math.round(percentile(latencies, 0.95)),
    avgLlmLatencyMs: llmLatencyCount > 0 ? Math.round(totalLlmLatency / llmLatencyCount) : 0,
    avgTokensPerSecond,
    avgMsPerOutputToken,
    avgLlmCallsPerQuery:
      llmCallsPresentCount > 0 ? Number((totalLlmCalls / llmCallsPresentCount).toFixed(2)) : 0,
    retryRatePct: Number(((totalRetries / n) * 100).toFixed(1)),
    jsonParseErrorCount,
    errorRatePct: Number(((errorCount / n) * 100).toFixed(1)),
    semanticCacheHits,
  };
}

export class QueryLoggerService {
  private logFilePath: string;

  constructor(logFilePath = resolveDefaultQueryLogPath()) {
    this.logFilePath = logFilePath;
  }

  private async ensureLogDir(): Promise<void> {
    const dir = path.dirname(this.logFilePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async logQuery(entry: QueryLogEntry): Promise<void> {
    await this.ensureLogDir();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.logFilePath, line, "utf-8");
  }

  async getLogs(limit?: number): Promise<QueryLogEntry[]> {
    try {
      const content = await fs.readFile(this.logFilePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const entries: QueryLogEntry[] = lines.map((line) => JSON.parse(line));
      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async getSummary(storeId?: string): Promise<UsageSummary> {
    const all = await this.getLogs();
    const filtered = storeId ? all.filter((e) => e.storeId === storeId) : all;

    if (filtered.length === 0) {
      return {
        totalQueries: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 0,
        averageLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        avgLlmLatencyMs: 0,
        avgTokensPerSecond: 0,
        avgMsPerOutputToken: 0,
        avgLlmCallsPerQuery: 0,
        totalRetries: 0,
        totalJsonParseErrors: 0,
        semanticCacheHits: 0,
        cacheHitRatePct: 0,
        mutationsCount: 0,
        questionsCount: 0,
        byModel: {},
      };
    }

    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    let totalCost = 0;
    let totalRetries = 0;
    let totalJsonParseErrors = 0;
    let mutationsCount = 0;
    let questionsCount = 0;

    const groupedByModel = new Map<string, QueryLogEntry[]>();
    for (const e of filtered) {
      totalPrompt += e.usage.promptTokens;
      totalCompletion += e.usage.completionTokens;
      totalCached += e.usage.cachedTokens;
      totalCost += e.cost.totalCostUsd;
      totalRetries += e.retriesCount ?? 0;
      totalJsonParseErrors += e.jsonParseErrorsCount ?? 0;

      if (e.intentType === "mutation") mutationsCount++;
      if (e.intentType === "doc_question" || e.intentType === "store_inspection") questionsCount++;

      const bucket = groupedByModel.get(e.model) ?? [];
      bucket.push(e);
      groupedByModel.set(e.model, bucket);
    }

    const overall = summarizeGroup(filtered);
    const byModel: Record<string, ModelBenchmarkSummary> = {};
    for (const [modelName, entries] of groupedByModel.entries()) {
      byModel[modelName] = summarizeGroup(entries);
    }

    return {
      totalQueries: filtered.length,
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      totalCachedTokens: totalCached,
      totalCostUsd: Number(totalCost.toFixed(6)),
      averageLatencyMs: overall.avgLatencyMs,
      p50LatencyMs: overall.p50LatencyMs,
      p95LatencyMs: overall.p95LatencyMs,
      avgLlmLatencyMs: overall.avgLlmLatencyMs,
      avgTokensPerSecond: overall.avgTokensPerSecond,
      avgMsPerOutputToken: overall.avgMsPerOutputToken,
      avgLlmCallsPerQuery: overall.avgLlmCallsPerQuery,
      totalRetries,
      totalJsonParseErrors,
      semanticCacheHits: overall.semanticCacheHits,
      cacheHitRatePct: overall.cacheHitRatePct,
      mutationsCount,
      questionsCount,
      byModel,
    };
  }
}
