# Khadoom AI: Store Agent Harness (Mtajir)

Khadoom AI is a production-grade intelligent co-pilot, mutation engine, and grounded retrieval system built for **Mtajir** (Shopify-like e-commerce platform in the MENA/GCC region).

Instead of letting an LLM rewrite entire store configurations (which causes hallucinations, state loss, race conditions, and token bloat), Khadoom AI operates as a deterministic **mutation and retrieval harness** with strict runtime schema validation, reversible staging, high-water mark versioning, bilingual hybrid RAG, persistent multi-tier semantic response caching, and a modern **dual-pane Web UI Dashboard** alongside an interactive terminal CLI.

---

## Key Architectural Pillars

### Part I: Store Mutation & Staging Engine

#### 1. RFC 6902 JSON Patching & Predicate-Based Paths
- Rather than rewriting the entire store JSON, the LLM outputs atomic RFC 6902 JSON Patches (`add`, `replace`, `remove`).
- **Predicate Path Resolution**: Solves the positional array problem. The agent targets entities naturally by ID (e.g., `/paymentProviders[id=cod]/enabled` or `/products[id=prod_001]/price`) without guessing array indices. The backend compiler resolves these to exact numeric indices at runtime.

#### 2. Relative Arithmetic Operations & Wildcard Bulk Updates
- Native support for relative arithmetic operations:
  - `increment` (`+= delta`)
  - `decrement` (`-= delta`)
  - `percentage` (`+/- X%`)
  - `multiply` (`*= factor`)
- **Automatic Non-Negative Clamping**: Prices and inventory levels are automatically clamped at `0` to prevent invalid states.
- **Wildcard Expansion**: Target arrays in bulk with single operations (e.g., `/products[*]/price` to apply store-wide price adjustments or collection-wide updates).

#### 3. Strict Runtime Zod Schema Validation
- All store mutations are applied to an in-memory clone and strictly validated against [`MtajirStoreSchema`](src/schema/store.schema.ts).
- Validates hex colors (`#RRGGBB` or `#RGB`), nested navigation trees, product SKUs, inventory integers, currency codes (`SAR`, `AED`, `KWD`, etc.), and shipping zones.

#### 4. Self-Correction Retry Loop
- If schema validation fails, the exact Zod error paths and failure reasons are fed back to the model in an automated retry loop (up to 3 retries).
- The agent corrects syntax, schema types, or invalid paths before changes ever reach the merchant.

#### 5. Mandatory Read-Before-Write Rule
- The agent is instructed never to guess entity IDs, SKU codes, or rates.
- Before mutating existing catalog products, shipping rates, or navigation items, the agent must inspect the live store slice via `inspect_store_data` to obtain verified identifiers.

#### 6. Reversible In-Memory Staging Layer
- Validated changes enter an isolated `pending` staging session without touching the live store.
- **Optimistic Concurrency Guard**: Staging checks `baseVersion === liveVersion`. If another admin or process updated the store concurrently, mutation is blocked with a concurrency conflict.

#### 7. Semantic Feature Diffing & No-Op Detection
- Translates raw RFC 6902 patches into human-friendly feature change cards (e.g., *"Changed primary theme color from '#1E293B' to '#2563EB'"*).
- **No-Op Prevention**: Redundant edits (such as setting an already active color or price) are detected and discarded without advancing the version counter.

#### 8. Human-in-the-Loop (HITL) Interactive Flow
- Merchants review proposed changes visually via interactive **Proposal Cards** in the Web UI or via terminal prompts in the CLI with three explicit choices:
  - **[A]ccept**: Commits staged changes to the live store and increments snapshot version.
  - **[R]eject**: Discards staged changes completely, leaving the live store untouched.
  - **[M]odify**: Provides feedback to iteratively adjust and re-stage proposed changes.

#### 9. High-Water Mark Versioning & Deterministic Rollback
- Every accepted commit generates an immutable snapshot (`v1.json`, `v2.json`, ...) and appends to `changelog.json`.
- **High-Water Mark Versioning**: When rolling back to an earlier version (e.g., from `v2` back to `v1`) and subsequently committing new changes, the version advances to `v3` (strictly incrementing past the highest recorded version), ensuring historical snapshots are never overwritten.
- **Safe Rollback Guidance**: The agent instructs users to perform rollbacks via deterministic commands (`/rollback <version>` in the CLI or 1-click rollback in the Web UI Version History dropdown) instead of generating reverse AI patches.

---

### Part II: Grounded Retrieval & Semantic Caching (RAG)

#### 10. Entity-Linked Hybrid RAG Engine (BM25 + Dense Vectors + RRF)
- Combines lexical keyword precision and dense semantic vectors:
  - **Dense Vectors**: Semantic vector similarity via OpenAI `text-embedding-3-small` (1,536 dimensions).
  - **Bilingual Lexical BM25**: Okapi BM25 indexer ($k_1 = 1.5, b = 0.75$) with field boosting across titles, section headers, entities, and tags.
  - **Reciprocal Rank Fusion (RRF)**: Merges lexical and vector search ranks using $RRF(d) = \sum \frac{1}{k + rank(d)}$ ($k = 60$), eliminating fragile score calibration.
  - **Store Constraint Hard Filtering**: Prunes documentation incompatible with the store's active `currency` or `country` (e.g., filtering out KNet for Saudi SAR stores).
  - **EmbeddingsStore Repository Adapter**: Abstract storage interface (`FileEmbeddingsStore` / `InMemoryEmbeddingsStore`) ready to swap to `pgvector`, `sqlite-vec`, or Qdrant.
  - **Deterministic MD5 Chunk Caching**: Chunks are hashed on content; re-indexing skips unchanged chunks, making embedding runs fast and virtually free.

#### 11. Bilingual Arabic & English Text Normalization & Clitic Stemming
- Built-in bilingual text normalizer in [`bm25-search.ts`](src/rag/bm25-search.ts):
  - Strips Arabic diacritics/tashkeel (`[\u064B-\u065F\u0670]`) and tatweel (`\u0640`).
  - Unifies Alef variants (`أ/إ/آ/ٱ` $\to$ `ا`), Taa Marbuta (`ة` $\to$ `ه`), and Alef Maqsura (`ى` $\to$ `ي`).
  - Strips attached Arabic prefixes and clitics (`وال`, `بال`, `كال`, `فال`, `لل`, `ال`, `ل`, `ب`) so queries like `بالتقسيط لتابي` match root terms `تقسيط` and `تابي`.
  - Light English stemmer handles plurals and suffixes (`-ing`, `-ed`, `-es`, `-ies`, `-s`).
  - Preserves exact e-commerce domain acronyms (`COD`, `BNPL`, `SKU`, `ZATCA`, `CR`, `SAR`).

#### 12. Persistent Multi-Tier Semantic Cache
- High-speed query response cache delivering $< 5\text{ms}$ latency at **$0 LLM cost** for repeated or paraphrased questions:
  - **Disk Persistence**: Saved to `data/cache/semantic-cache.json` so cache entries survive server, CLI, and process restarts.
  - **Tier 1 (Exact Canonical Match)**: Case, punctuation, and whitespace-normalized query match (zero latency, zero API calls).
  - **Tier 2 (Lexically-Guarded Semantic Match)**: Uses `tokenizeToWordForms` content-word verification combined with a calibrated cosine similarity threshold ($\ge 0.90$). Safely captures genuine paraphrases while strictly blocking dangerous near-miss collisions (such as antonyms "enable Tabby" vs "disable Tabby", or "primary" vs "secondary" color).
  - **Compound Context Key**: Partitioned by `corpusHash::currency::country::locale`. Prevents cross-store cache pollution so Saudi merchants don't receive Kuwaiti-specific answers.
  - **Corpus Hash Invalidation**: Automatically flushes stale cached answers whenever Markdown documentation files are updated.

#### 13. Scope Boundaries & Anti-Hallucination Guardrails
- **Domain Specialization**: The agent is explicitly scoped to Mtajir e-commerce platform features and merchant store management.
- **Irrelevant Retrieval Protection**: Out-of-scope inquiries (e.g. general software engineering, external AI/RAG system architecture, personal questions) are politely declined. The agent is explicitly forbidden from force-fitting unrelated store docs (such as Tabby installments or store snapshots) into synthetic answers.
- **Attribution & Source Filtering**: If documentation retrieved during hybrid search is non-pertinent to the query, source citations are pruned, and false-positive Q&A is never cached.

#### 14. Token Usage & Cost Telemetry
- Real-time tracking of:
  - Uncached prompt tokens
  - Cached prompt tokens
  - Completion tokens
  - Latency in milliseconds
  - Exact USD API cost breakdown based on model pricing tiers
- Persisted to append-only JSONL logs (`data/logs/query-logs.jsonl`).

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
│   ├── cache/                     # Persisted Tier 2 semantic query cache
│   │   └── semantic-cache.json
│   ├── docs/                      # Markdown documentation corpus with YAML frontmatter
│   │   ├── doc-payment-knet.md
│   │   ├── doc-payment-providers.md
│   │   ├── doc-payment-tabby.md
│   │   ├── doc-products-inventory.md
│   │   ├── doc-shipping-zones.md
│   │   ├── doc-theme-customization.md
│   │   └── doc-version-rollback.md
│   ├── embeddings/                # Persisted chunk embeddings & MD5 content hashes
│   │   └── doc-embeddings.json
│   ├── logs/                      # Append-only query telemetry & cost logs
│   │   └── query-logs.jsonl
│   └── stores/                    # Live store JSONs, snapshots & changelogs
│       ├── store_darb_001.json
│       └── store_darb_001/
│           ├── changelog.json
│           └── snapshots/
│               ├── v1.json
│               ├── v2.json
│               └── v3.json
├── docs/
│   └── RAG_IMPLEMENTATION_SPEC.md # Full RAG engine specification & architecture
├── src/
│   ├── index.ts                   # Public library exports
│   ├── server.ts                  # HTTP REST API & static SPA server (Port 3005)
│   ├── agent/
│   │   └── khadoom.agent.ts       # OpenAI tool calling, self-correction & compound flow
│   ├── data/
│   │   └── seed-store.ts          # Seed store dataset ('Darb Roastery')
│   ├── diff/
│   │   └── semantic-diff.ts       # Translates JSON patches into merchant feature cards
│   ├── patch/
│   │   └── patch-compiler.ts      # Predicate path compiler & arithmetic operator engine
│   ├── rag/
│   │   ├── bm25-search.ts         # Okapi BM25 engine with Arabic & English normalizer
│   │   ├── constraint-filter.ts   # Currency & country hard filter
│   │   ├── doc-loader.ts          # Markdown frontmatter parser & section chunker
│   │   ├── docs.service.ts        # Unified documentation & hybrid retrieval facade
│   │   ├── embeddings.ts          # EmbeddingsStore adapter & vector search engine
│   │   ├── hybrid-search.ts       # Reciprocal Rank Fusion (RRF) search engine
│   │   ├── semantic-cache.ts      # Context-scoped Tier 2 semantic query cache
│   │   └── sync-embeddings.ts     # CLI script to embed and persist documentation corpus
│   ├── schema/
│   │   ├── patch.schema.ts        # RFC 6902 + arithmetic JSON patch schema
│   │   └── store.schema.ts        # Complete Mtajir store schema (Zod)
│   ├── staging/
│   │   └── staging.service.ts     # In-memory staging, validation & concurrency checks
│   ├── storage/
│   │   └── store.repository.ts    # Snapshots, changelog & high-water mark rollback
│   ├── telemetry/
│   │   └── query-logger.ts        # Token usage tracking, cost calculator & JSONL logger
│   └── cli.ts                     # Merchant interactive CLI
├── ui/                            # Modern React 18 + Vite Web Dashboard SPA
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatPane.tsx       # Conversational interface with quick chips & input
│   │   │   ├── FormattedMessage.tsx # Markdown renderer & source citation badges
│   │   │   ├── Header.tsx         # Store status, live version & telemetry cost summary
│   │   │   ├── KhadoomIcon.tsx    # Branded icon components
│   │   │   ├── LoadingIndicator.tsx # Animated agent thinking indicators
│   │   │   ├── ProposalCard.tsx   # Interactive HITL staging cards (Accept/Reject/Modify)
│   │   │   └── StorePane.tsx      # Tabbed live store visualizer & version history
│   │   ├── App.tsx                # Main dual-pane application layout & state
│   │   ├── index.css              # Custom styling & Tailwind-compatible utility classes
│   │   ├── main.tsx               # React DOM entry point
│   │   └── types.ts               # Shared TypeScript frontend contracts
│   ├── dist/                      # Pre-built static SPA assets served by server.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── test/
│   └── index.test.ts              # Complete 29-stage automated test suite
├── package.json
└── tsconfig.json
```

---

## Merchant Interfaces: Web Dashboard & CLI

Khadoom AI provides two merchant interfaces: a modern **Dual-Pane Web Dashboard** (primary) and an **Interactive Terminal CLI** (headless/automation).

### 1. Web Dashboard (`http://localhost:3005`)

The Web Dashboard offers an intuitive visual workspace built with **React 18**, **Vite**, and **Lucide Icons**, served directly by `src/server.ts`.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  [Logo] Khadoom AI  |  Darb Roastery (v2)  |  Tokens: 2,410 ($0.00034)  |  [Reset Store]│
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│               CHAT PANE                │                  STORE PANE                   │
│                                        │  [Products] [Theme] [Shipping] [Pay] [History]│
│ > Merchant: "Enable Tabby & 10% off"   │                                               │
│                                        │  Live Store State (Visualized):               │
│ 🤖 Khadoom: "I've staged 2 changes:    │  • Ethiopian Yirgacheffe: 58.50 SAR (-10%)    │
│                                        │  • Colombian Huila:       52.20 SAR (-10%)    │
│  ┌──────────────────────────────────┐  │  • V60 Ceramic Dripper:   85.50 SAR (-10%)    │
│  │ PROPOSED CHANGES (STAGING v2)    │  │                                               │
│  │ 1. [PAYMENTS] Enable Tabby BNPL  │  │  Active Payment Gateways:                     │
│  │ 2. [CATALOG]  Apply -10% discount│  │  [✓] Mada  [✓] Apple Pay  [✓] Tabby  [ ] COD  │
│  │                                  │  │                                               │
│  │   [Accept]  [Reject]  [Modify]   │  │  Version History & 1-Click Rollback:          │
│  └──────────────────────────────────┘  │  • v2: Enabled Tabby & discount (Current)     │
│                                        │  • v1: Initial store snapshot     [Rollback]  │
│ [Quick Prompt Suggestions...]          │                                               │
└────────────────────────────────────────┴───────────────────────────────────────────────┘
```

#### Core Web Features:
- **Dual-Pane Synchronized Layout**: The right pane immediately visualizes store state updates as soon as changes are staged or committed.
- **Interactive Proposal Cards**: Changes are displayed as structured cards with before/after diffs, arithmetic tags, and one-click **[Accept]**, **[Reject]**, or **[Modify]** actions.
- **Store Visualizer Tabs**: Real-time inspection of **Products** (cards, prices, inventory badges), **Theme & Colors** (live color swatches and promotional banner preview), **Shipping Zones** (domestic & international rates), **Payment Providers** (active/test toggles), **Policies**, and **Version History**.
- **1-Click Rollback & Store Reset**: Roll back to any historical snapshot directly from the Version History tab, or reset the store to the seed state with a single button.
- **Real-Time Telemetry Badges**: Live display of uncached tokens, cached tokens, response latency, and exact cumulative USD spend in the header and message bubbles.
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
| `/api/store` | `GET` | Fetches current live store JSON, changelog snapshots, and telemetry summary. |
| `/api/chat` | `POST` | Dispatches merchant prompt to `KhadoomAgent` (`{ prompt: string }`). |
| `/api/staging/accept` | `POST` | Commits staged mutation session to live store (`{ sessionId: string }`). |
| `/api/staging/reject` | `POST` | Rejects and discards staged mutation session (`{ sessionId: string }`). |
| `/api/staging/modify` | `POST` | Re-stages mutation incorporating feedback (`{ sessionId, feedback }`). |
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

## Ongoing Maintenance & Upkeep Guide

| Maintenance Task | Procedure & CLI Command | Impact & Operational Behavior |
| :--- | :--- | :--- |
| **Adding or Updating Docs** | Create/edit `.md` files in `data/docs/` with YAML frontmatter and `## ` headers, then run `npm run embed`. | **Incremental & Cost-Optimized**: Only chunks with changed MD5 content hashes call OpenAI API (`text-embedding-3-small` at $0.02 / 1M tokens). Unchanged chunks load from cache at $0. |
| **Document Deletion / Renaming** | Delete or rename `.md` in `data/docs/`, then run `npm run embed`. To clean orphan chunk embeddings, delete `data/embeddings/doc-embeddings.json` and re-sync. | Synchronizes chunk registry with active files. Ensures deleted features are pruned from search indices. |
| **Q&A Semantic Cache Invalidation** | **Fully Automatic**: Modifying any document or frontmatter changes the composite `corpusHash`, which automatically invalidates stale cached answers on the next query. | **Zero Maintenance**: Stale answers are automatically evicted. To manually wipe all cached Q&A: `rm data/cache/semantic-cache.json`. |
| **Semantic Cache Size Housekeeping** | Inspect `data/cache/semantic-cache.json`. In high-traffic deployments, purge or archive when entries exceed storage limits (e.g. >10,000 entries). | Survives server restarts. Purging only resets warm hits back to normal RAG retrieval without data loss. |
| **Embedding Model / Dimension Upgrades** | When upgrading embedding models (e.g. from `text-embedding-3-small` to `text-embedding-3-large`), delete `data/embeddings/doc-embeddings.json` and re-run `npm run embed`. | **One-time re-index**: Vector dimension mismatches throw if not regenerated cleanly. |
| **Vector DB Cloud Migration** | Swap `FileEmbeddingsStore` with a database adapter (`pgvector`, `sqlite-vec`, `Qdrant`) by implementing the 3-method `EmbeddingsStore` interface in [`embeddings.ts`](src/rag/embeddings.ts). | Enables multi-node cloud deployments with shared concurrent vector search and centralized indexing. |
| **Arabic Vocabulary & Dialect Tuning** | Add new GCC/MENA e-commerce terms, payment acronyms, or prefixes into [`bm25-search.ts`](src/rag/bm25-search.ts) (`STOPWORDS` or clitic prefix regex). | **Zero API Cost**: Enhances BM25 lexical recall for regional phrasing (e.g. Saudi vs UAE vs Kuwait dialect variants). |
| **Constraint & Currency Hygiene** | Ensure all country/currency-specific docs define `supportedCurrencies` and `supportedCountries` in their YAML frontmatter. | **Strict Tenant Isolation**: Prevents platform features (e.g. KNet in Kuwait) from leaking into irrelevant merchant regions (e.g. Saudi Arabia). |
| **Cost & Token Monitoring** | Inspect live badges in the Web Dashboard header, call `GET /api/telemetry`, run `/cost` in the CLI, or view `data/logs/query-logs.jsonl`. | Real-time telemetry monitoring uncached vs cached prompt tokens, average latency, and cumulative USD spend. |
| **Frontend UI Building** | Run `npm run ui:build` after editing React components in `ui/src/`. | Compiles production SPA assets into `ui/dist/` for static serving via `src/server.ts`. |
| **Telemetry Log Rotation** | Periodically rotate, compress, or truncate `data/logs/query-logs.jsonl` in production. | Standard append-only log maintenance. |
| **Continuous Verification** | Run `npm test` after any documentation, schema, UI, or algorithm change. | Executes 29 end-to-end automated verification stages in ~3s locally. |

---

### RAG Operational Playbooks

#### 1. Adding or Modifying Documentation
Every document in `data/docs/*.md` must conform to the structured frontmatter schema:
```markdown
---
id: doc_unique_identifier
title: Human-Readable Guide Title
category: Payments | Shipping | Catalog | Design & Themes | System
entities: ["Entity1", "Entity2"]
supportedCurrencies: ["SAR", "AED"]   # Optional: omit if globally available
supportedCountries: ["SA", "AE"]       # Optional: omit if globally available
tags: ["keyword1", "keyword2"]
---

# Title
Overview text...

## Section Heading (Creates a chunk boundary)
Specific instructions, step-by-step guidance, or technical constraints...
```
1. Add or edit the Markdown file in `data/docs/`.
2. Run the sync command:
   ```bash
   npm run embed
   ```
3. The engine computes an MD5 hash per chunk. Only modified or new sections trigger an OpenAI embedding request. Unchanged chunks cost zero tokens.
4. The composite `corpusHash` updates automatically, guaranteeing that any previously cached Q&A referencing stale docs is evicted.

#### 2. Managing the Semantic Cache
- **Storage Location**: `data/cache/semantic-cache.json` (persisted to disk to survive CLI & server restarts).
- **Partitioning**: Entries are partitioned by `corpusHash::currency::country::locale`. A change to documentation or a query from a different currency context cannot collide.
- **Informational Guard**: Only questions matching informational grammar patterns (`isInformationalQuestion`) are cached. Action-oriented store mutations (`"enable cash on delivery"`, `"change banner color"`) always bypass the cache and route to the agent.
- **Manual Cache Reset**:
  ```bash
  rm data/cache/semantic-cache.json
  # or in PowerShell:
  Remove-Item data/cache/semantic-cache.json -Force
  ```

#### 3. Migrating to a Cloud Vector Database (pgvector / Qdrant)
In production with multiple agent worker pods, replace the local `FileEmbeddingsStore` with a centralized vector database:
1. Open [`src/rag/embeddings.ts`](src/rag/embeddings.ts).
2. Implement the `EmbeddingsStore` interface:
   ```typescript
   export interface EmbeddingsStore {
     loadEmbeddings(): Promise<Map<string, ChunkEmbedding>>;
     saveEmbeddings(embeddings: Map<string, ChunkEmbedding>, corpusHash: string): Promise<void>;
     getCorpusHash(): Promise<string | null>;
   }
   ```
3. Pass your new `PgVectorEmbeddingsStore` instance into `DocsService(embeddingsStore)`. The agent, BM25, and RRF rankers remain completely untouched.

#### 4. Lexical Tuning & Regional Dialect Adaptation
The bilingual BM25 tokenizer in [`src/rag/bm25-search.ts`](src/rag/bm25-search.ts) normalizes Arabic orthography and strips common clitics:
- When introducing brand names with attached prefixes (e.g. `بتابي`, `لتمارا`, `كمدى`), verify that the prefix rule `^([ووبكفل]+)` properly extracts the stem.
- Add frequent non-informative query filler terms (e.g. `ممكن`, `لو سمحت`, `طريقة`) to the `ARABIC_STOPWORDS` set to prevent token dilution.
- Exact e-commerce acronyms (`COD`, `BNPL`, `SKU`, `ZATCA`, `CR`, `SAR`) are protected from stemming and given exact keyword precedence.

---

## Verification Test Suite

Run the full end-to-end test suite:
```bash
npm test
```

The test suite validates 29 distinct stages:
1. Seed Store Zod schema compliance
2. Invalid schema rejection (e.g., malformed hex colors)
3. Snapshot storage & initial v1 changelog creation
4. In-memory reversible staging of RFC 6902 patches
5. Semantic feature diff card generation
6. Optimistic concurrency conflict detection
7. Staging acceptance & commit versioning
8. Live store rollback with history preservation
9. Documentation search & caching functionality
10. Precise token cost calculations for `gpt-4o-mini`
11. QueryLogger JSONL persistence & summary analytics
12. Predicate path compilation (`[id=xyz]` resolution)
13. End-to-end predicate mutation staging (e.g. enabling COD)
14. Arithmetic delta operations with non-negative clamping
15. Percentage-based scaling operations
16. Array wildcard expansion (`/products[*]/price`)
17. Compound response data contracts (simultaneous Q&A + mutation)
18. No-Op / redundant modification prevention
19. Deterministic rollback prompt guidance
20. High-water mark versioning after rollback
21. Markdown corpus loader, frontmatter extraction & section chunking
22. Arabic clitic and prefix normalization in BM25
23. `EmbeddingsStore` disk persistence & MD5 deduplication
24. Store constraint filtering (SAR vs KWD doc isolation)
25. Context-scoped semantic caching, paraphrase matching ($\ge 0.94$), and corpus invalidation
26. Embeddings dimension and model validation with automatic store repair
27. Live semantic cache file isolation during verification tests
28. Store-state dynamic inspection cache-poisoning guard
29. Descending multi-item removals and sequential index-shifting patch compilation

---

## Quickstart

### 1. Configure Environment
Create a `.env` file from `.env.example`:
```bash
OPENAI_API_KEY=sk-your-openai-api-key
```

### 2. Embed Documentation Corpus
Sync and generate vector embeddings for all Markdown documentation guides:
```bash
npm run embed
```
*(Only changed or new chunks will call OpenAI; unchanged chunks are read from cache).*

### 3. Run Verification Tests
```bash
npm test
```

### 4. Launch the Merchant Interface

#### Option A: Web UI Dashboard (Recommended)
Launch the full-stack server (REST API + React SPA):
```bash
npm run server
```
Then open **`http://localhost:3005`** in your browser.

#### Option B: Terminal CLI
Run the terminal-based interactive harness:
```bash
npm start
```
