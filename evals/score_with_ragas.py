"""
Evaluates exported Khadoom RAG runs (`evals/results/rag_eval_*.json`) using Ragas Core RAG Metrics:
- Faithfulness (Hallucination guard: claims grounded in retrieved contexts)
- Answer Relevancy
- Context Precision (Ranking quality — highlights Cross-Encoder Reranker gain)
- Context Recall (Retrieval coverage — highlights Hybrid VectorDB + BM25 gain)
- Answer Correctness (End-to-end factual match against ground_truth)
"""

import glob
import json
import os
from pathlib import Path
from dotenv import load_dotenv
from datasets import Dataset
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from ragas import evaluate
from ragas.metrics import (
    answer_correctness,
    answer_relevancy,
    context_precision,
    context_recall,
    faithfulness,
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper


def build_judge():
    # Prefer an independent commercial judge (gpt-4o-mini / gpt-4o) if OPENAI_API_KEY is available,
    # or fall back to EVAL_LLM_BASE_URL / LLM_BASE_URL if evaluating purely locally.
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()
    eval_base = os.getenv("EVAL_LLM_BASE_URL") or (
        None if (openai_key and not openai_key.startswith("your_")) else os.getenv("LLM_BASE_URL")
    )
    eval_key = os.getenv("EVAL_LLM_API_KEY") or (
        openai_key if (openai_key and not openai_key.startswith("your_")) else os.getenv("LLM_API_KEY", "not-needed")
    )
    eval_model = os.getenv("EVAL_LLM_MODEL") or (
        "gpt-4o-mini" if not eval_base else os.getenv("LLM_MODEL", "Qwen/Qwen3-8B-FP8")
    )

    emb_base = os.getenv("EVAL_EMBEDDING_BASE_URL") or (
        None if (openai_key and not openai_key.startswith("your_")) else os.getenv("EMBEDDING_BASE_URL")
    )
    emb_key = os.getenv("EVAL_EMBEDDING_API_KEY") or (
        openai_key if (openai_key and not openai_key.startswith("your_")) else os.getenv("EMBEDDING_API_KEY", "not-needed")
    )
    emb_model = os.getenv("EVAL_EMBEDDING_MODEL") or (
        "text-embedding-3-small" if not emb_base else os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
    )

    llm = ChatOpenAI(
        model=eval_model,
        api_key=eval_key,
        **({"base_url": eval_base} if eval_base else {}),
        temperature=0,
    )
    embeddings = OpenAIEmbeddings(
        model=emb_model,
        api_key=emb_key,
        **({"base_url": emb_base} if emb_base else {}),
    )
    return LangchainLLMWrapper(llm), LangchainEmbeddingsWrapper(embeddings), eval_model


def main():
    root_dir = Path(__file__).resolve().parent.parent
    load_dotenv(root_dir / ".env")

    results_dir = Path(__file__).resolve().parent / "results"
    files = sorted(glob.glob(str(results_dir / "rag_eval_*.json")))
    if not files:
        raise FileNotFoundError(
            f"No rag_eval_*.json files found in {results_dir}. Run `npm run eval:rag` first."
        )

    judge_llm, judge_embeddings, judge_model = build_judge()
    metrics = [
        faithfulness,
        answer_relevancy,
        context_precision,
        context_recall,
        answer_correctness,
    ]

    comparison = []
    for fpath in files:
        with open(fpath, "r", encoding="utf-8") as f:
            payload = json.load(f)

        records = [r for r in payload.get("records", []) if r.get("answer", "").strip()]
        if not records:
            print(f"[Skip] {Path(fpath).name} has no generated answers (run without --retrieval-only).")
            continue

        ds = Dataset.from_dict(
            {
                "question": [r["question"] for r in records],
                "answer": [r["answer"] for r in records],
                "contexts": [r["contexts"] if r["contexts"] else ["No context retrieved."] for r in records],
                "ground_truth": [r["ground_truth"] for r in records],
            }
        )

        print(f"\nEvaluating {payload['variant']} ({len(records)} items) using judge '{judge_model}'...")
        res = evaluate(dataset=ds, metrics=metrics, llm=judge_llm, embeddings=judge_embeddings)
        df = res.to_pandas()

        row = {
            "variant": payload["variant"],
            "pair": payload.get("pair"),
            "vector_db": payload.get("vectorDb"),
            "reranker": payload.get("reranker"),
            "faithfulness": round(float(df["faithfulness"].mean()), 4),
            "answer_relevancy": round(float(df["answer_relevancy"].mean()), 4),
            "context_precision": round(float(df["context_precision"].mean()), 4),
            "context_recall": round(float(df["context_recall"].mean()), 4),
            "answer_correctness": round(float(df["answer_correctness"].mean()), 4),
            "recall_at_k": payload.get("summary", {}).get("recall_at_k"),
            "mrr": payload.get("summary", {}).get("mrr"),
            "avg_total_ms": payload.get("summary", {}).get("avg_total_ms"),
            "total_cost_usd": payload.get("summary", {}).get("total_cost_usd"),
        }
        comparison.append(row)

    out_json = results_dir / "ragas_comparison_report.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"judge_model": judge_model, "results": comparison}, f, indent=2)

    out_md = results_dir / "ragas_comparison_report.md"
    lines = [
        "# Khadoom RAG Evaluation Report (Ragas)",
        f"- **Judge LLM:** `{judge_model}`",
        "",
        "| Variant | Faithfulness | Answer Relevancy | Context Precision | Context Recall | Answer Correctness | Recall@K | MRR | Avg Latency | Cost (USD) |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]
    for r in comparison:
        lines.append(
            f"| `{r['variant']}` | {r['faithfulness']:.3f} | {r['answer_relevancy']:.3f} | "
            f"{r['context_precision']:.3f} | {r['context_recall']:.3f} | {r['answer_correctness']:.3f} | "
            f"{r['recall_at_k'] or 0:.3f} | {r['mrr'] or 0:.3f} | {r['avg_total_ms'] or 0} ms | ${r['total_cost_usd'] or 0:.5f} |"
        )
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nSaved Ragas reports:\n - {out_json}\n - {out_md}")


if __name__ == "__main__":
    main()
