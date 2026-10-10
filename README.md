# Khadoom AI: Store Agent Harness (Mtajir)

Khadoom AI is an intelligent co-pilot and mutation harness built for **Mtajir** (Shopify-like e-commerce platform). It provides safe, reversible, schema-validated store mutations alongside grounded question answering.

---

## Key Features

1. **RFC 6902 JSON Patching:** Instead of rewriting the entire store JSON, `gpt-4o-mini` outputs atomic JSON patches (`add`, `replace`, `remove`).
2. **Runtime Zod Validation:** Patches are applied to an in-memory clone and strictly validated against [`MtajirStoreSchema`](src/schema/store.schema.ts).
3. **Self-Correction Retry Loop:** If schema validation fails, the exact Zod issue paths and error messages are returned to the model for automated self-correction before reaching the user.
4. **Reversible Staging Layer:** Validated changes enter a staging phase with an optimistic concurrency guard (`baseVersion == liveVersion`).
5. **Semantic Feature Diffing:** Rather than raw JSON diffs, changes are converted to merchant-friendly feature cards (e.g. *"Changed primary theme color from '#1E293B' to '#2563EB'"*).
6. **Human-in-the-Loop (HITL):** Merchants can **Accept**, **Reject**, or **Modify** proposals.
7. **Instant Version History & Rollback:** Accepted changes create immutable snapshot versions (`v1.json`, `v2.json`, ...) with changelogs and one-click rollback.
8. **Dual-Path Q&A Retrieval:** Platform questions query Mtajir documentation with semantic caching, while live store queries inspect current store data directly.
9. **Token Usage & Cost Telemetry:** Real-time logging of prompt tokens, cached prompt tokens, completion tokens, execution latency, and exact USD cost calculations for `gpt-4o-mini` saved to append-only JSONL files (`data/logs/query-logs.jsonl`).
10. **Predicate-Based Path Resolution:** Solves the positional array problem in RFC 6902. The LLM targets array entities by natural ID (e.g., `/paymentProviders[id=cod]/enabled` or `/products[id=prod_001]/price`), and the backend compiler resolves them to exact numeric indices before applying and staging.
11. **Arithmetic Operations & Wildcard Expansion:** Native support for `increment`, `decrement`, and `percentage` (+/- X%) operations with automatic non-negative clamping for prices and inventory. Array wildcards (`/products[*]/price`) enable store-wide bulk changes in a single LLM call.

---

## Project Structure

```
├── src/
│   ├── agent/
│   │   └── khadoom.agent.ts     # OpenAI tool calling & self-correction loop
│   ├── diff/
│   │   └── semantic-diff.ts     # Translates JSON patches into readable feature diffs
│   ├── patch/
│   │   └── patch-compiler.ts    # Compiles semantic [id=xyz] predicates to RFC 6902
│   ├── rag/
│   │   └── docs.service.ts      # Mtajir documentation search & semantic cache
│   ├── schema/
│   │   ├── patch.schema.ts      # RFC 6902 patch schema
│   │   └── store.schema.ts      # Complete Mtajir store schema (Zod)
│   ├── staging/
│   │   └── staging.service.ts   # In-memory staging, validation & concurrency checks
│   ├── storage/
│   │   └── store.repository.ts  # File-based store snapshots & changelog
│   ├── telemetry/
│   │   └── query-logger.ts      # Token usage tracking, cost calculator & JSONL logger
│   ├── data/
│   │   └── seed-store.ts        # Seed data for demo store ('Darb Roastery')
│   └── cli.ts                   # Interactive merchant CLI
├── test/
│   └── index.test.ts            # Complete end-to-end test suite
└── package.json
```

---

## Quickstart

### 1. Set Your OpenAI API Key
Copy `.env.example` to `.env` and insert your OpenAI API key:
```bash
OPENAI_API_KEY=sk-...
```

### 2. Run the Interactive CLI
```bash
npm start
```

### 3. Run Verification Tests
```bash
npm test
```
