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

export interface QueryLogEntry {
  id: string;
  timestamp: string;
  storeId: string;
  userPrompt: string;
  model: string;
  latencyMs: number;
  intentType: QueryIntentType;
  toolCalls: string[];
  retriesCount: number;
  usage: TokenUsage;
  cost: CostBreakdown;
  status: "success" | "error";
  errorMessage?: string;
}

export interface UsageSummary {
  totalQueries: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  mutationsCount: number;
  questionsCount: number;
}

/**
 * Calculates exact USD cost based on token counts and model pricing
 */
export function calculateCost(model: string, usage: TokenUsage): CostBreakdown {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];

  const cachedTokens = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncachedPromptTokens = Math.max(0, usage.promptTokens - cachedTokens);

  const uncachedInputCostUsd = (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion;
  const cachedInputCostUsd = (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
  const outputCostUsd = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  const totalCostUsd = uncachedInputCostUsd + cachedInputCostUsd + outputCostUsd;

  return {
    uncachedInputCostUsd: Number(uncachedInputCostUsd.toFixed(8)),
    cachedInputCostUsd: Number(cachedInputCostUsd.toFixed(8)),
    outputCostUsd: Number(outputCostUsd.toFixed(8)),
    totalCostUsd: Number(totalCostUsd.toFixed(8)),
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
        mutationsCount: 0,
        questionsCount: 0,
      };
    }

    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    let totalCost = 0;
    let totalLatency = 0;
    let mutationsCount = 0;
    let questionsCount = 0;

    for (const e of filtered) {
      totalPrompt += e.usage.promptTokens;
      totalCompletion += e.usage.completionTokens;
      totalCached += e.usage.cachedTokens;
      totalCost += e.cost.totalCostUsd;
      totalLatency += e.latencyMs;

      if (e.intentType === "mutation") mutationsCount++;
      if (e.intentType === "doc_question" || e.intentType === "store_inspection") questionsCount++;
    }

    return {
      totalQueries: filtered.length,
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      totalCachedTokens: totalCached,
      totalCostUsd: Number(totalCost.toFixed(6)),
      averageLatencyMs: Math.round(totalLatency / filtered.length),
      mutationsCount,
      questionsCount,
    };
  }
}
