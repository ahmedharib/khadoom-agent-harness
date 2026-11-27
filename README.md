# Khadoom AI: Store Agent Harness (Mtajir)

Khadoom AI is a production-grade intelligent co-pilot, mutation engine, and grounded retrieval system built for **Mtajir** (Shopify-like e-commerce platform in the MENA/GCC region).

Instead of letting an LLM rewrite entire store configurations (which causes hallucinations, state loss, race conditions, and token bloat), Khadoom AI operates as a deterministic **mutation and retrieval harness** with strict runtime schema validation, reversible staging, high-water mark versioning, bilingual hybrid RAG, persistent multi-tier semantic response caching, and a modern **dual-pane Web UI Dashboard** alongside an interactive terminal CLI.

---

## Key Architectural Pillars

### Part I: Store Mutation & Staging Engine

- **RFC 6902 Patching, Predicates, Arithmetic & Wildcards**: Instead of rewriting full store JSON, the LLM emits atomic patches (`add`, `replace`, `remove`) with runtime predicate path resolution (`/products[id=prod_001]/price`), relative arithmetic (`increment`, `decrement`, `percentage`, `multiply` with automatic `>= 0` clamping), and bulk wildcards (`/products[*]/price`).
- **Strict Validation & Self-Correction**: Mutations apply to an in-memory clone validated against [`MtajirStoreSchema`](src/schema/store.schema.ts) (hex colors, SKUs, inventory integers, currencies, shipping zones). Validation errors feed exact Zod issue paths back into an automated retry loop (up to 3 retries), paired with a mandatory read-before-write rule (`inspect_store_data`) so IDs are never guessed.
- **Reversible Staging, Semantic Diffs & No-Op Guard**: Validated patches enter an isolated `pending` staging session guarded by optimistic concurrency (`baseVersion === liveVersion`), translated into human-readable feature diff cards, and checked for redundant no-op edits.
- **HITL Flow & High-Water Mark Versioning**: Merchants review **Proposal Cards** (Web UI) or CLI prompts to **[A]ccept**, **[R]eject**, or **[M]odify**. Accepted commits write immutable snapshots (`v1.json`, `v2.json`, ...) and `changelog.json`. Rolling back (`v2` → `v1`) and committing again advances to `v3`, never overwriting historical snapshots.

### Part II: Grounded Retrieval, Caching & Routing (RAG)

- **Hybrid RAG Pipeline (Qdrant + BM25 + RRF + Reranker)**:
  - **VectorDB & Dual Profiles**: [`QdrantEmbeddingsStore`](src/rag/qdrant-store.ts) maintains separate collections (`khadoom_docs_openai` 1,536-dim and `khadoom_docs_qwen` 1,024-dim) with cosine ANN search and payload constraint pushdown, falling back seamlessly to `FileEmbeddingsStore` JSON when Qdrant is offline. MD5 chunk hashing skips unchanged sections on `npm run embed`.
  - **Bilingual Lexical BM25 & RRF**: [`bm25-search.ts`](src/rag/bm25-search.ts) runs Okapi BM25 ($k_1=1.5, b=0.75$) with Arabic normalization (diacritics, Alef/Taa Marbuta/Alef Maqsura, clitic prefixes `وال`/`بال`/`لل`/`ال`/`ب`/`ل`), English suffix stemming, and acronym protection (`COD`, `BNPL`, `SKU`, `ZATCA`, `SAR`), fused with vector ranks via RRF ($k=60$).
  - **Cross-Encoder Reranking & Passage Highlighting**: [`reranker.ts`](src/rag/reranker.ts) supports optional stage-3 reranking via **Local (`BAAI/bge-reranker-v2-m3`)** or **Commercial (`Cohere rerank-v3.5`)** with RRF fallback. [`citation-highlighter.ts`](src/rag/citation-highlighter.ts) maps answer sentences back to retrieved excerpts for expandable UI highlights.
- **Persistent Multi-Tier Semantic Cache**: Stored in `data/cache/semantic-cache.json` (`< 5ms`, $0 LLM cost), partitioned by `corpusHash::currency::country::locale`. Tier 1 handles normalized exact matches; Tier 2 uses `tokenizeToWordForms` + cosine similarity ($\ge 0.90$) to capture paraphrases while blocking antonym/entity collisions. Updates to `data/docs/` automatically invalidate stale entries.
- **Scope Guardrails**: Off-topic queries are declined without force-fitting store docs; non-pertinent retrieved chunks are pruned from citations and excluded from caching.
- **Provider Router & Per-Model Telemetry**: [`provider-router.ts`](src/routing/provider-router.ts) live-probes and switches between **Commercial** (`gpt-4o-mini` + `text-embedding-3-small`) and **Local** (`Qwen/Qwen3-8B-FP8` via vLLM + `Qwen/Qwen3-Embedding-0.6B` from [`notebooks/khadoom_qwen3_colab_vllm.ipynb`](notebooks/khadoom_qwen3_colab_vllm.ipynb), with `<think>` stripping and JSON recovery), plus cross-pair reranker selection. [`query-logger.ts`](src/telemetry/query-logger.ts) logs prompt/cached/completion tokens, `p50`/`p95` latency, `tok/s`, parse recoveries, and API/GPU cost to `data/logs/query-logs.jsonl`.

---

## Multi-Tenant Cloud Architecture (Scaling to Thousands of Merchants)

In production, Khadoom AI cleanly separates **Shared Platform Knowledge** from **Private Merchant Store Data**:

```
[ Merchant Web / App / CLI ] ──(User Prompt)
               │
               ▼
   [ Khadoom Agent Service ]  (Stateless orchestration, session & tool execution)
               │
               ├──> 1. Store DB (Tenant-Isolated: store_darb_001 only)
               │
               └──> 2. Shared RAG Service (Stateless SearchDocs RPC / Microservice)
                           │
                           ├── Shared Semantic Cache (Compound Key: corpusHash + currency + country)
                           ├── EmbeddingsStore (pgvector / Qdrant in Cloud)
                           └── Shared Bilingual BM25 Index
```

1. **Shared Platform RAG**: Platform documentation (how Tabby works, shipping zone guides, versioning rules) is identical across all merchants and indexed once.
2. **Shared Cache Advantage**: When one merchant asks *"How do I activate Mada?"*, all subsequent merchants in that currency/country partition receive instant $<5\text{ms}$ answers with zero OpenAI API calls.
3. **Strict Tenancy Isolation**: Merchant store data (`products`, `inventory`, `orders`, `theme`) is never indexed into the public RAG corpus; it is queried exclusively via tenant-isolated `inspect_store_data` reads.

---

## Project Structure

```
khadoom-agent-harness/
├── data/
│   ├── cache/semantic-cache.json  # Persisted Tier 1/2 semantic query cache
│   ├── docs/                      # 7 Markdown guides with YAML frontmatter
│   ├── embeddings/                # Per-profile embeddings (OpenAI 1536d, Qwen 1024d)
│   ├── logs/query-logs.jsonl      # Append-only query telemetry & cost logs
│   └── stores/                    # Live store JSONs, snapshots & changelogs
├── docs/RAG_IMPLEMENTATION_SPEC.md
├── evals/                         # Bilingual RAG dataset, retrieval benchmark & Ragas scorer
├── notebooks/                     # Colab L4 vLLM (Qwen3) + Embeddings & BGE-M3 sidecar
├── src/
│   ├── index.ts & server.ts       # Library exports + HTTP/SSE API & static SPA server (3005)
│   ├── cli.ts                     # Interactive terminal CLI
│   ├── agent/khadoom.agent.ts     # Tool calling, live step streaming, self-correction & memory
│   ├── diff/ & patch/             # Semantic diff cards, predicate paths & arithmetic compiler
│   ├── rag/                       # BM25, Qdrant/File embeddings, RRF, reranker, cache & citations
│   ├── routing/provider-router.ts # Commercial vs Local pair & cross-pair reranker router
│   ├── schema/, staging/, storage/# Zod schemas, reversible staging & high-water snapshots
│   └── telemetry/query-logger.ts  # Speed, latency & cost logger
├── ui/                            # React 18 + Vite Web Dashboard (ChatPane, StorePane, Header, ProposalCard)
├── test/index.test.ts             # 43-stage automated test suite
├── docker-compose.yml             # Local Qdrant VectorDB service (Ports 6333/6334)
└── package.json
```

---

## Merchant Interfaces: Web Dashboard & CLI

Khadoom AI provides two merchant interfaces: a modern **Dual-Pane Web Dashboard** (primary) and an **Interactive Terminal CLI** (headless/automation).

### 1. Web Dashboard (`http://localhost:3005`)

The Web Dashboard offers an intuitive visual workspace built with **React 18**, **Vite**, and **Lucide Icons**, served directly by `src/server.ts`.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  [Logo] Khadoom AI  |  Darb Roastery (v2)  |  Commercial · RRF  |  gpt-4o-mini | Reset │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│               CHAT PANE                │                  STORE PANE                   │
│                                        │  [Products] [Theme] [Shipping] [Pay] [History]│
│ > Merchant: "Enable Tabby & 10% off"   │                                               │
│                                        │  Live Store State (Visualized):               │
│ ▸ Show steps and metrics (3)           │  • Ethiopian Yirgacheffe: 58.50 SAR (-10%)    │
│ 🤖 Khadoom: "I've staged 2 changes:    │  • Colombian Huila:       52.20 SAR (-10%)    │
│                                        │  • V60 Ceramic Dripper:   85.50 SAR (-10%)    │
│  ┌──────────────────────────────────┐  │                                               │
│  │ PROPOSED CHANGES (STAGING v2)    │  │  Active Payment Gateways:                     │
│  │ 1. [PAYMENTS] Enable Tabby BNPL  │  │  [✓] Mada  [✓] Apple Pay  [✓] Tabby  [ ] COD  │
│  │ 2. [CATALOG]  Apply -10% discount│  │                                               │
│  │                                  │  │  Version History & 1-Click Rollback:          │
│  │   [Accept]  [Reject]  [Modify]   │  │  • v2: Enabled Tabby & discount (Current)     │
│  └──────────────────────────────────┘  │  • v1: Initial store snapshot     [Rollback]  │
│                                        │                                               │
│ [Quick Prompt Suggestions...]          │                                               │
└────────────────────────────────────────┴───────────────────────────────────────────────┘
```

#### Core Web Features:
- **Dual-Pane Synchronized Layout**: The right pane immediately visualizes store state updates as soon as changes are staged or committed.
- **Live Execution Steps & Per-Turn Metrics**: While the agent runs, SSE streams real-time steps (`Analyzing request & planning`, `Inspecting store data`, `Searching Mtajir documentation`, `Staging & validating store changes`) instead of a generic spinner. Completed replies include a collapsible **`Show steps and metrics`** toggle above the answer showing step durations, latency, token usage, and estimated cost.
- **Interactive Proposal Cards**: Changes are displayed as structured cards with before/after diffs, arithmetic tags, and one-click **[Accept]**, **[Reject]**, or **[Modify]** actions.
- **Store Visualizer Tabs**: Real-time inspection of **Products** (cards, prices, inventory badges), **Theme & Colors** (live color swatches and promotional banner preview), **Shipping Zones** (domestic & international rates), **Payment Providers** (active/test toggles), **Policies**, and **Version History**.
- **1-Click Rollback & Store Reset**: Roll back to any historical snapshot directly from the Version History tab, or reset the store to the seed state with a single button.
- **Model Pair & Reranker Router Pill**: Click the header router pill to switch between **Commercial (OpenAI)** and **Local/Open-Weight (Qwen 3)** pairs and pick a cross-pair **Reranker** (`Off`, `Local BGE-M3`, or `Commercial Cohere`); inactive/offline options appear greyed out and disabled.
- **Clickable Citations & Highlighted Source Passages**: Source citation pills under RAG answers expand inline to show the retrieved section(s), relevance scores (`Rerank %`, `Vec %`, `BM25`, `RRF`), and highlighted excerpts aligned with the answer.
- **Quick Action Chips**: One-tap sample prompts for sales campaigns, theme restyling, shipping policy updates, and payment gateway configuration.

#### Launching the Web Dashboard:
```bash
# Start the full-stack server (REST API + static UI bundle)
npm run server
```
Open **`http://localhost:3005`** in your browser.

#### Frontend Development Mode:
For live hot-module reloading (HMR) during UI development:
```bash
# Terminal 1: Start backend API
npm run server

# Terminal 2: Start Vite dev server (proxies API requests)
npm run ui:dev

# Build UI bundle to ui/dist/
npm run ui:build
```

#### Backend REST API Endpoints (`src/server.ts`):
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/store` | `GET` | Fetches current live store JSON, changelog snapshots, telemetry, `modelConfig`, and `routerState`. |
| `/api/providers` | `GET` | Returns active/inactive status of model pairs, rerankers, and VectorDB mode. |
| `/api/providers/select` | `POST` | Switches active `modelPair` (`commercial` \| `local`) and/or `reranker` (`none` \| `local` \| `commercial`). |
| `/api/providers/refresh` | `POST` | Re-probes Qdrant, local Colab/vLLM, and reranker endpoints on demand. |
| `/api/chat` | `POST` | Dispatches merchant prompt to the active routed `KhadoomAgent` (`{ prompt, conversationId, stream? }`; returns JSON or SSE `step`/`done` stream). |
| `/api/staging/accept` | `POST` | Commits staged mutation session to live store (`{ sessionId: string }`). |
| `/api/staging/reject` | `POST` | Rejects and discards staged mutation session (`{ sessionId: string }`). |
| `/api/staging/modify` | `POST` | Re-stages mutation incorporating feedback (`{ sessionId, feedback, stream? }`; returns JSON or SSE `step`/`done` stream). |
| `/api/store/rollback` | `POST` | Restores store state to specified snapshot version (`{ version: number }`). |
| `/api/store/reset` | `POST` | Resets store back to seed v1 snapshot. |
| `/api/telemetry` | `GET` | Retrieves aggregate token counts, cache hits, and cumulative cost. |

---

### 2. Interactive Terminal CLI

For headless environments, automated pipelines, or terminal-based store administration:
```bash
npm start
```

#### Supported CLI Commands:
| Command | Description |
| :--- | :--- |
| **Natural Language** | Ask questions (*"How do shipping zones work?"*) or request store changes (*"Change primary color to #2563EB and enable COD"*). |
| `/cost` or `/usage` | View aggregate telemetry: total queries, prompt/cached/completion tokens, average latency, and cumulative USD cost. |
| `/history` | View the full store snapshot history, timestamps, and commit explanations. |
| `/rollback <version>` | Revert live store to a previous snapshot (e.g. `/rollback 1`). |
| `/store` | Print the current live store JSON state. |
| `/exit` | Exit the CLI. |

---

## Operations & RAG Playbook

| Task | Command / Procedure | Behavior |
| :--- | :--- | :--- |
| **Add / Update Docs** | Edit `data/docs/*.md` (YAML frontmatter + `## ` headers), then run `npm run embed`. | MD5 chunk deduplication skips unchanged sections ($0 API cost) and updates `corpusHash`, auto-invalidating stale cache entries. |
| **Delete Docs / Upgrade Model** | Delete `data/embeddings/doc-embeddings*.json` and run `npm run embed`. | Prunes orphan chunks and prevents vector dimension collisions across models. |
| **VectorDB (Qdrant)** | Run `docker compose up -d` (local port `6333`) or set `QDRANT_URL` + `QDRANT_API_KEY` in `.env`. | Startup auto-migrates existing file embeddings into `khadoom_docs_openai` / `khadoom_docs_qwen` at zero API cost. |
| **Reset Semantic Cache** | `rm data/cache/semantic-cache.json` (PowerShell: `Remove-Item data/cache/semantic-cache.json -Force`). | Clears warm Q&A hits; action mutations bypass cache automatically. |
| **Arabic Dialect & Constraints** | Tune `ARABIC_STOPWORDS` / prefix regex in [`bm25-search.ts`](src/rag/bm25-search.ts); set `supportedCurrencies` / `supportedCountries` in doc frontmatter. | Improves GCC/MENA recall and enforces strict regional doc isolation (e.g., KNet vs SAR). |
| **Build UI & Verify** | `npm run ui:build` · `npm test` · `npm run eval:rag` (`python evals/score_with_ragas.py`) | Compiles `ui/dist/`, runs the 43-stage test suite, and benchmarks RAG pipelines ([`evals/README.md`](evals/README.md)). |

**Doc Frontmatter Template (`data/docs/*.md`):**
```markdown
---
id: doc_unique_identifier
title: Human-Readable Guide Title
category: Payments | Shipping | Catalog | Design & Themes | System
entities: ["Entity1", "Entity2"]
supportedCurrencies: ["SAR", "AED"]   # Optional: omit if global
supportedCountries: ["SA", "AE"]       # Optional: omit if global
tags: ["keyword1", "keyword2"]
---
## Section Heading (Creates a chunk boundary)
```

---

## Verification Test Suite

Run the full automated suite:
```bash
npm test
```

The 43-stage suite ([`test/index.test.ts`](test/index.test.ts)) covers four areas using in-memory/mocked LLM calls (no external API keys required):
- **Mutation & Versioning Engine**: Zod validation, RFC 6902 + predicate/arithmetic/wildcard compilation, semantic diffing, no-op detection, optimistic concurrency (staging & commit TOCTOU guards), and high-water mark rollbacks.
- **Bilingual Hybrid RAG & Qdrant**: Markdown chunking, Arabic clitic normalization, constraint isolation (`SAR` vs `KWD`), RRF + cross-encoder reranking/fallback, Qdrant UUID determinism & native `querySimilar`, citation passage highlighting, and context-scoped semantic caching.
- **Agent Loop & Provider Routing**: Bounded session memory, self-correction context preservation, malformed tool-call JSON recovery, forced `propose_store_changes` on modify turns, `<think>` stripping, and `ProviderRouter` availability/switching.
- **Live Streaming & Telemetry**: Per-model cost/throughput (`tok/s`, `P50`/`P95`) aggregation and `AgentStep` (`onStep`) live running/done stream emissions.

---

## Quickstart

### 1. Install Dependencies & Build UI
```bash
npm install
npm --prefix ui install
npm run ui:build
```

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env` and configure either (or both):
- **Commercial Pair (OpenAI):** `OPENAI_API_KEY=sk-...` (plus optional `COHERE_API_KEY=...` for commercial reranking)
- **Local / Self-Hosted Pair (Qwen 3 on Colab L4):** Run Cells 1–4 of [`notebooks/khadoom_qwen3_colab_vllm.ipynb`](notebooks/khadoom_qwen3_colab_vllm.ipynb) and paste the printed `LLM_*`, `EMBEDDING_*`, and `RERANKER_*` variables into `.env`.

### 3. (Optional) Start Qdrant VectorDB & Sync Embeddings
```bash
docker compose up -d
npm run embed
```
*(Syncs configured Commercial and/or Local Qwen embeddings to disk and Qdrant; unchanged chunks cost 0 API calls).*

### 4. Run Verification Tests
```bash
npm test
```

### 5. Launch the Merchant Interface

#### Option A: Web UI Dashboard (Recommended)
```bash
npm run server
```
Then open **`http://localhost:3005`** in your browser.

#### Option B: Terminal CLI
```bash
npm start
```
