# Khadoom AI — RAG Evaluation Suite (`evals/`)

This folder implements the end-to-end **RAG Pipeline Evaluation & Ragas Core Metrics** benchmark comparing:
1. `bm25_only` (Bilingual Okapi BM25 baseline)
2. `vectordb_only` (Qdrant / Dense embeddings baseline)
3. `hybrid_rrf` (VectorDB + BM25 merged with Reciprocal Rank Fusion)
4. `hybrid_rrf_rerank` (VectorDB + BM25 + RRF + Multilingual Cross-Encoder Reranker)

## Files
- `rag_eval_dataset.json`: 18 curated bilingual (English + Arabic) queries with ground truths, expected document IDs, currency/country constraints, and unanswerable hallucination traps.
- `run_rag_retrieval_eval.ts`: Runs all pipeline variants against live Qdrant + embeddings + reranker + LLM (bypassing semantic cache), computing `Recall@K`, `MRR`, latency, and USD cost, and exporting `evals/results/rag_eval_<variant>.json`.
- `score_with_ragas.py`: Scores the exported JSON runs using **Ragas** (`Faithfulness`, `Answer Relevancy`, `Context Precision`, `Context Recall`, `Answer Correctness`) and writes `evals/results/ragas_comparison_report.md`.
- `agent_eval_dataset.json`: 18 multi-step agent workflow tasks (single mutations, arithmetic/wildcards, store inspection, compound question+mutation, modify proposal, Arabic, navigation, no-op, and out-of-scope guards).
- `run_agent_eval.ts`: Executes the agent task suite head-to-head across Commercial (`gpt-4o-mini`) and Self-Hosted quantization variants (`FP8`, `AWQ`, `BF16`), scoring task success rate, tool accuracy, latency (`p50`/`p95`), throughput (`tok/s`), retries, JSON errors, and cost.

## Usage

### 1. Topic 1 — RAG Retrieval + Ragas Evaluation
```bash
# Ensure Qdrant is running (`docker compose up -d`) and embeddings are synced (`npm run embed`)
npm run eval:rag

# Or specify local Qwen pair + local BGE reranker explicitly:
npx tsx evals/run_rag_retrieval_eval.ts --pair=local --reranker=local

# Fast retrieval-only Recall@K & MRR check (no LLM generation calls):
npx tsx evals/run_rag_retrieval_eval.ts --retrieval-only
```

```bash
pip install -r evals/requirements-evals.txt
python evals/score_with_ragas.py
```
Outputs are written to `evals/results/ragas_comparison_report.md` and `evals/results/ragas_comparison_report.json`.

### 2. Topic 2 & Topic 5 — Agent Task Success & Model/Quantization Head-to-Head
```bash
# Commercial API baseline (gpt-4o-mini):
npm run eval:agent -- --pair=commercial --model-label=gpt-4o-mini

# Self-hosted Open-Weight quantization runs (with Colab vLLM URL in .env):
npm run eval:agent -- --pair=local --model=Qwen/Qwen3-8B-FP8 --model-label=qwen3-8b-fp8
npm run eval:agent -- --pair=local --model=Qwen/Qwen3-8B-AWQ --model-label=qwen3-8b-awq
npm run eval:agent -- --pair=local --model=Qwen/Qwen3-8B --model-label=qwen3-8b-bf16

# Regenerate head-to-head comparison table from all saved results:
npm run eval:agent -- --compare
```
Outputs are written to `evals/results/agent_eval_<modelLabel>.json` and `evals/results/agent_benchmark_comparison.md`.
