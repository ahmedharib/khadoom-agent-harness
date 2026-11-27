import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import OpenAI from "openai";
import { loadDocumentationCorpus } from "../src/rag/doc-loader.js";
import {
  EmbeddingsService,
  FileEmbeddingsStore,
  resolveDefaultEmbeddingsPath,
  type EmbeddingsProfile,
} from "../src/rag/embeddings.js";
import { QdrantEmbeddingsStore } from "../src/rag/qdrant-store.js";
import { HybridSearchEngine } from "../src/rag/hybrid-search.js";
import { RerankerService, type RerankerMode } from "../src/rag/reranker.js";
import { calculateCost } from "../src/telemetry/query-logger.js";

dotenv.config({ override: true });

interface EvalDatasetItem {
  id: string;
  category: string;
  question: string;
  ground_truth: string;
  expected_doc_ids: string[];
  store_constraints?: {
    currency?: string;
    country?: string;
    locale?: string;
  };
}

type EvalVariant = "bm25_only" | "vectordb_only" | "hybrid_rrf" | "hybrid_rrf_rerank";

interface EvalRecord {
  id: string;
  category: string;
  question: string;
  ground_truth: string;
  expected_doc_ids: string[];
  retrieved_doc_ids: string[];
  contexts: string[];
  answer: string;
  recall_at_k: number;
  reciprocal_rank: number;
  retrieval_latency_ms: number;
  generation_latency_ms: number;
  total_latency_ms: number;
  cost_usd: number;
}

function getArgValue(prefix: string): string | undefined {
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function computeRecallAndRR(retrievedDocIds: string[], expectedDocIds: string[]) {
  if (expectedDocIds.length === 0) return { recall: 1, rr: 1 };
  const uniqueRetrieved = Array.from(new Set(retrievedDocIds));
  const hits = expectedDocIds.filter((id) => uniqueRetrieved.includes(id)).length;
  const recall = hits / expectedDocIds.length;
  let rr = 0;
  for (let i = 0; i < uniqueRetrieved.length; i++) {
    if (expectedDocIds.includes(uniqueRetrieved[i])) {
      rr = 1 / (i + 1);
      break;
    }
  }
  return { recall, rr };
}

async function generateGroundedAnswer(
  client: OpenAI,
  model: string,
  question: string,
  contexts: string[],
  disableThinking: boolean
): Promise<{ answer: string; latencyMs: number; costUsd: number }> {
  const t0 = Date.now();
  const contextText =
    contexts.length > 0
      ? contexts.map((c, idx) => `[Source ${idx + 1}]: ${c}`).join("\n\n")
      : "No matching documentation found.";

  const payload: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, any> = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are Khadoom AI for Mtajir e-commerce. Answer the question strictly and concisely using ONLY the provided Source passages. If the sources do not contain the answer, clearly state that the requested information is not available in Mtajir documentation.",
      },
      {
        role: "user",
        content: `Sources:\n${contextText}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.1,
  };
  if (disableThinking) {
    payload.chat_template_kwargs = { enable_thinking: false };
  }

  const resp = await client.chat.completions.create(payload);
  const latencyMs = Date.now() - t0;
  const rawContent = resp.choices[0]?.message?.content || "";
  const answer = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();

  const usage = {
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    totalTokens: resp.usage?.total_tokens ?? 0,
    cachedTokens: (resp.usage?.prompt_tokens_details as any)?.cached_tokens ?? 0,
  };
  const cost = calculateCost(model, usage, { latencyMs });
  return { answer, latencyMs, costUsd: cost.totalCostUsd };
}

async function main() {
  const pair: EmbeddingsProfile =
    (getArgValue("--pair=") as EmbeddingsProfile) ||
    (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith("your_")
      ? "commercial"
      : "local");

  const rerankerArg = (getArgValue("--reranker=") as RerankerMode) || undefined;
  const retrievalOnly = process.argv.includes("--retrieval-only");
  const topK = Number(getArgValue("--top-k=") || "4");
  const variantsArg = getArgValue("--variants=");
  const variants: EvalVariant[] = variantsArg
    ? (variantsArg.split(",") as EvalVariant[])
    : ["bm25_only", "vectordb_only", "hybrid_rrf", "hybrid_rrf_rerank"];

  const evalsDir = path.resolve(process.cwd(), "evals");
  const datasetPath = path.join(evalsDir, "rag_eval_dataset.json");
  const resultsDir = path.join(evalsDir, "results");
  await fs.mkdir(resultsDir, { recursive: true });

  const dataset: EvalDatasetItem[] = JSON.parse(await fs.readFile(datasetPath, "utf-8"));
  const { chunks, corpusHash } = await loadDocumentationCorpus();

  const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
  const qdrantActive = await QdrantEmbeddingsStore.isReachable(qdrantUrl);
  const collectionName = pair === "local" ? "khadoom_docs_qwen" : "khadoom_docs_openai";

  const fileStore = new FileEmbeddingsStore(resolveDefaultEmbeddingsPath(pair));
  const embeddingModel =
    pair === "local"
      ? process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-0.6B"
      : process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const embeddingBaseURL = pair === "local" ? process.env.EMBEDDING_BASE_URL : undefined;
  const embeddingApiKey =
    pair === "local"
      ? process.env.EMBEDDING_API_KEY || "not-needed"
      : process.env.OPENAI_API_KEY || "dummy_key_for_mock";

  let activeStore: FileEmbeddingsStore | QdrantEmbeddingsStore = fileStore;
  if (qdrantActive) {
    const qStore = new QdrantEmbeddingsStore({ url: qdrantUrl, collectionName });
    qStore.setChunks(chunks);
    const qMeta = await qStore.getMetadata();
    if (!qMeta || qMeta.corpusHash !== corpusHash) {
      const diskVectors = await fileStore.loadEmbeddings();
      if (diskVectors.size > 0) {
        await qStore.saveEmbeddings(diskVectors, corpusHash, { model: embeddingModel }, chunks);
      }
    }
    activeStore = qStore;
  }

  const embeddingsService = new EmbeddingsService({
    store: activeStore,
    baseURL: embeddingBaseURL,
    apiKey: embeddingApiKey,
    model: embeddingModel,
  });

  const reranker = new RerankerService();
  let activeRerankerMode: RerankerMode = rerankerArg ?? "none";
  if (!rerankerArg) {
    if ((await reranker.probeLocalHealth()).ok) {
      activeRerankerMode = "local";
    } else if (reranker.isCommercialConfigured()) {
      activeRerankerMode = "commercial";
    }
  }

  const engine = new HybridSearchEngine(chunks, embeddingsService, reranker, activeRerankerMode);

  const llmModel =
    pair === "local"
      ? process.env.LLM_MODEL || "Qwen/Qwen3-8B-FP8"
      : process.env.OPENAI_MODEL || "gpt-4o-mini";
  const llmClient = new OpenAI({
    apiKey:
      pair === "local"
        ? process.env.LLM_API_KEY || "not-needed"
        : process.env.OPENAI_API_KEY || "dummy_key_for_mock",
    ...(pair === "local" && process.env.LLM_BASE_URL ? { baseURL: process.env.LLM_BASE_URL } : {}),
  });
  const disableThinking =
    pair === "local" && process.env.LLM_DISABLE_THINKING !== "false" && /^qwen/i.test(llmModel);

  console.log(`\n==================================================`);
  console.log(`  KHADOOM RAG EVALUATION HARNESS`);
  console.log(`  Pair: ${pair} (${llmModel} + ${embeddingModel})`);
  console.log(`  VectorDB: ${qdrantActive ? `Qdrant (${collectionName})` : "File JSON Store"}`);
  console.log(`  Reranker: ${activeRerankerMode} | Retrieval-Only: ${retrievalOnly}`);
  console.log(`==================================================\n`);

  const summaryRows: Array<{
    variant: EvalVariant;
    recall_at_k: number;
    mrr: number;
    avg_retrieval_ms: number;
    avg_total_ms: number;
    total_cost_usd: number;
  }> = [];

  for (const variant of variants) {
    if (variant === "hybrid_rrf_rerank" && activeRerankerMode === "none") {
      console.log(`[Skip] '${variant}' skipped because no local/commercial reranker is active.`);
      continue;
    }

    const records: EvalRecord[] = [];
    for (const item of dataset) {
      const tRet0 = Date.now();
      const retrievalMode =
        variant === "bm25_only"
          ? "bm25_only"
          : variant === "vectordb_only"
          ? "vector_only"
          : "hybrid";
      const rerankerModeForRun: RerankerMode =
        variant === "hybrid_rrf_rerank" ? activeRerankerMode : "none";

      const hits = await engine.search(item.question, {
        ...(item.store_constraints ?? {}),
        limit: topK,
        retrievalMode,
        rerankerMode: rerankerModeForRun,
      });
      const retrievalLatencyMs = Date.now() - tRet0;

      const retrievedDocIds = hits.map((h) => h.docId);
      const contexts = hits.map((h) => `[${h.title} — ${h.sectionHeader}]: ${h.content}`);
      const { recall, rr } = computeRecallAndRR(retrievedDocIds, item.expected_doc_ids);

      let answer = "";
      let genLatencyMs = 0;
      let costUsd = 0;

      if (!retrievalOnly) {
        const gen = await generateGroundedAnswer(
          llmClient,
          llmModel,
          item.question,
          contexts,
          disableThinking
        );
        answer = gen.answer;
        genLatencyMs = gen.latencyMs;
        costUsd = gen.costUsd;
      }

      records.push({
        id: item.id,
        category: item.category,
        question: item.question,
        ground_truth: item.ground_truth,
        expected_doc_ids: item.expected_doc_ids,
        retrieved_doc_ids: retrievedDocIds,
        contexts,
        answer,
        recall_at_k: Number(recall.toFixed(4)),
        reciprocal_rank: Number(rr.toFixed(4)),
        retrieval_latency_ms: retrievalLatencyMs,
        generation_latency_ms: genLatencyMs,
        total_latency_ms: retrievalLatencyMs + genLatencyMs,
        cost_usd: Number(costUsd.toFixed(6)),
      });
    }

    const avgRecall = records.reduce((s, r) => s + r.recall_at_k, 0) / records.length;
    const mrr = records.reduce((s, r) => s + r.reciprocal_rank, 0) / records.length;
    const avgRetMs = records.reduce((s, r) => s + r.retrieval_latency_ms, 0) / records.length;
    const avgTotMs = records.reduce((s, r) => s + r.total_latency_ms, 0) / records.length;
    const totalCost = records.reduce((s, r) => s + r.cost_usd, 0);

    summaryRows.push({
      variant,
      recall_at_k: Number(avgRecall.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      avg_retrieval_ms: Math.round(avgRetMs),
      avg_total_ms: Math.round(avgTotMs),
      total_cost_usd: Number(totalCost.toFixed(6)),
    });

    const outPath = path.join(resultsDir, `rag_eval_${variant}.json`);
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          variant,
          pair,
          llmModel,
          embeddingModel,
          vectorDb: qdrantActive ? "qdrant" : "file",
          reranker: variant === "hybrid_rrf_rerank" ? activeRerankerMode : "none",
          evaluatedAt: new Date().toISOString(),
          summary: summaryRows[summaryRows.length - 1],
          records,
        },
        null,
        2
      ),
      "utf-8"
    );
    console.log(
      `[${variant}] Recall@${topK}: ${(avgRecall * 100).toFixed(1)}% | MRR: ${mrr.toFixed(3)} | Avg Ret: ${Math.round(avgRetMs)}ms | Total: ${Math.round(avgTotMs)}ms -> ${outPath}`
    );
  }

  await fs.writeFile(
    path.join(resultsDir, "retrieval_benchmark_summary.json"),
    JSON.stringify({ pair, vectorDb: qdrantActive ? "qdrant" : "file", summary: summaryRows }, null, 2),
    "utf-8"
  );
}

main().catch((err) => {
  console.error("RAG evaluation failed:", err);
  process.exit(1);
});
