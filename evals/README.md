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

## Usage

### 1. Generate Retrieval + Generation Outputs (Node.js)
```bash
# Ensure Qdrant is running (`docker compose up -d`) and embeddings are synced (`npm run embed`)
npm run eval:rag

# Or specify local Qwen pair + local BGE reranker explicitly:
npx tsx evals/run_rag_retrieval_eval.ts --pair=local --reranker=local

# Fast retrieval-only Recall@K & MRR check (no LLM generation calls):
npx tsx evals/run_rag_retrieval_eval.ts --retrieval-only
```

### 2. Score Core RAG Metrics with Ragas (Python)
```bash
pip install -r evals/requirements-evals.txt
python evals/score_with_ragas.py
```
Outputs are written to `evals/results/ragas_comparison_report.md` and `evals/results/ragas_comparison_report.json`.
