import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { MtajirStoreSchema } from "../src/schema/store.schema.js";
import { SEED_STORE } from "../src/data/seed-store.js";
import { StoreRepository } from "../src/storage/store.repository.js";
import { StagingService } from "../src/staging/staging.service.js";
import { generateSemanticDiff } from "../src/diff/semantic-diff.js";
import { DocsService, FileEmbeddingsStore, InMemoryEmbeddingsStore } from "../src/rag/docs.service.js";
import { cosineSimilarity } from "../src/rag/embeddings.js";
import { loadDocumentationCorpus } from "../src/rag/doc-loader.js";
import { BM25SearchEngine, normalizeAndTokenize } from "../src/rag/bm25-search.js";
import { extractMatchedExcerpts, buildCitationDetails } from "../src/rag/citation-highlighter.js";
import { RerankerService } from "../src/rag/reranker.js";
import { chunkIdToUuid } from "../src/rag/qdrant-store.js";
import { ProviderRouter } from "../src/routing/provider-router.js";
import { JsonPatchOperation } from "../src/schema/patch.schema.js";
import {
  QueryLoggerService,
  calculateCost,
  TokenUsage,
} from "../src/telemetry/query-logger.js";
import { compilePredicatePath, getValueAtPath } from "../src/patch/patch-compiler.js";
import { AgentResponse, AgentStep, KhadoomAgent } from "../src/agent/khadoom.agent.js";
import { evaluateTaskOutcome, type AgentEvalTask } from "../evals/run_agent_eval.js";

async function runTests() {
  console.log("Starting Khadoom AI Harness Verification Tests...\n");

  const testDir = path.join(process.cwd(), "test-data");
  await fs.rm(testDir, { recursive: true, force: true });

  const repository = new StoreRepository(testDir);
  const stagingService = new StagingService(repository);
  const testEmbedder = async (text: string) => {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const vec = new Array(32).fill(0);
    for (let i = 0; i < tokens.length; i++) {
      for (let j = 0; j < tokens[i].length; j++) {
        vec[(tokens[i].charCodeAt(j) * 31 + j) % 32] += 1;
      }
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => Number((v / norm).toFixed(6)));
  };

  const docsService = new DocsService({
    embeddingsStore: new InMemoryEmbeddingsStore(),
    embedder: testEmbedder,
    persistCachePath: path.join(testDir, "cache", "semantic-cache-unit.json"),
  });

  // Test 1: Zod Schema Validation on Seed Store
  console.log("Test 1: Validating Seed Store with Zod...");
  const validStore = MtajirStoreSchema.parse(SEED_STORE);
  assert.equal(validStore.name, "Darb Roastery");
  assert.equal(validStore.version, 1);
  console.log("  Passed: Seed store conforms strictly to Zod schema.");

  // Test 2: Invalid Schema Rejection
  console.log("\nTest 2: Verifying Zod rejection on invalid data...");
  const invalid = { ...SEED_STORE, theme: { ...SEED_STORE.theme, colors: { ...SEED_STORE.theme.colors, primary: "not-a-color" } } };
  const parseResult = MtajirStoreSchema.safeParse(invalid);
  assert.equal(parseResult.success, false);
  console.log("  Passed: Invalid color successfully blocked by Zod runtime validator.");

  // Test 3: Initialize Store & Snapshots in Repository
  console.log("\nTest 3: Saving Initial Store (v1 snapshot)...");
  await repository.saveInitialStore(validStore);
  const loaded = await repository.getStore(validStore.id);
  assert.ok(loaded);
  assert.equal(loaded?.version, 1);
  console.log("  Passed: Initial store and v1 snapshot successfully saved to disk.");

  // Test 4: Reversible Staging with RFC 6902 JSON Patch
  console.log("\nTest 4: Staging RFC 6902 Patch (Theme & Banner Mutation)...");
  const patches: JsonPatchOperation[] = [
    { op: "replace", path: "/theme/colors/primary", value: "#2563EB" },
    { op: "replace", path: "/theme/banner/enabled", value: true },
    { op: "replace", path: "/theme/banner/text", value: "National Day Sale - 30% OFF!" },
  ];

  const stageResult = await stagingService.stageMutation(
    validStore.id,
    1,
    "Update theme to blue and activate National Day banner",
    patches
  );

  assert.equal(stageResult.success, true);
  if (!stageResult.success) return;

  const session = stageResult.session;
  assert.equal(session.status, "pending");
  assert.equal(session.stagedStore.theme.colors.primary, "#2563EB");
  assert.equal(session.stagedStore.theme.banner.enabled, true);
  console.log("  Passed: Mutation successfully staged in memory while live store remains v1.");

  // Test 5: Semantic Diff Generation
  console.log("\nTest 5: Verifying Semantic Diff Engine (Feature-level diffs)...");
  const diffs = generateSemanticDiff(loaded!, patches);
  assert.equal(diffs.length, 3);
  assert.ok(diffs[0].summary.includes("primary theme color"));
  assert.ok(diffs[1].summary.includes("Enabled promotional announcement banner"));
  console.log("  Passed: Semantic diff generated human-readable descriptions:");
  diffs.forEach(d => console.log(`    - [${d.category}] ${d.summary}`));

  // Test 6: Optimistic Concurrency Guard
  console.log("\nTest 6: Testing Optimistic Concurrency Conflict...");
  const staleStageResult = await stagingService.stageMutation(
    validStore.id,
    99, // Wrong base version
    "Stale mutation attempt",
    patches
  );
  assert.equal(staleStageResult.success, false);
  if (!staleStageResult.success) {
    assert.equal(staleStageResult.errorType, "CONCURRENCY_CONFLICT");
    console.log(`  Passed: Concurrency conflict detected: ${staleStageResult.errorMessage}`);
  }

  // Test 7: Staging Acceptance & Version Commit (v1 -> v2)
  console.log("\nTest 7: Accepting and Committing Staged Changes...");
  const committed = await stagingService.commitSession(session.sessionId);
  assert.equal(committed.version, 2);
  assert.equal(committed.theme.colors.primary, "#2563EB");

  const liveStoreAfterCommit = await repository.getStore(validStore.id);
  assert.equal(liveStoreAfterCommit?.version, 2);
  console.log("  Passed: Store updated to v2 with snapshot and changelog recorded.");

  // Test 8: Instant Rollback (v2 -> v1 rollback state)
  console.log("\nTest 8: Testing Store Rollback to v1...");
  const rolledBack = await repository.rollbackToVersion(validStore.id, 1);
  assert.equal(rolledBack.version, 1); // target version restored directly without creating a new version
  assert.equal(rolledBack.theme.colors.primary, "#1E293B"); // original color restored!
  assert.equal(rolledBack.theme.banner.enabled, false);

  const changelog = await repository.getChangelog(validStore.id);
  assert.equal(changelog.length, 3); // v1, v2, and rollback audit entry preserved
  assert.equal(changelog[2].explanation.includes("Rolled back"), true);
  console.log("  Passed: Rollback successfully restored v1 state with history preserved.");

  // Test 9: Mtajir Documentation RAG & Semantic Cache
  console.log("\nTest 9: Verifying Documentation Search & Caching...");
  const searchResults = await docsService.searchDocs("shipping");
  assert.ok(searchResults.length > 0);
  assert.equal(searchResults[0].id, "doc_shipping_zones");

  await docsService.setCachedAnswer("how do shipping zones work", "Shipping is configured via geographic zones.");
  const cachedAnswer = await docsService.getCachedAnswer("how do shipping zones work");
  assert.equal(cachedAnswer, "Shipping is configured via geographic zones.");
  console.log("  Passed: Documentation search and semantic caching operational.");

  // Test 10: Accurate Cost Calculation (gpt-4o-mini pricing)
  console.log("\nTest 10: Verifying Token Cost Calculator for gpt-4o-mini...");
  const usageSample: TokenUsage = {
    promptTokens: 1000,
    cachedTokens: 400, // 400 cached, 600 uncached
    completionTokens: 500,
    totalTokens: 1500,
  };
  const cost = calculateCost("gpt-4o-mini", usageSample);
  // Uncached: (600 / 1M) * 0.150 = $0.00009
  // Cached:   (400 / 1M) * 0.075 = $0.00003
  // Output:   (500 / 1M) * 0.600 = $0.00030
  // Total:    $0.00042
  assert.equal(cost.uncachedInputCostUsd, 0.00009);
  assert.equal(cost.cachedInputCostUsd, 0.00003);
  assert.equal(cost.outputCostUsd, 0.0003);
  assert.equal(cost.totalCostUsd, 0.00042);
  console.log(`  Passed: Cost calculated precisely ($${cost.totalCostUsd} for ${usageSample.totalTokens} tokens).`);

  // Test 11: QueryLoggerService JSONL persistence and Summary
  console.log("\nTest 11: Verifying QueryLoggerService JSONL persistence & analytics...");
  const logFilePath = path.join(testDir, "test-query-logs.jsonl");
  const testLogger = new QueryLoggerService(logFilePath);

  await testLogger.logQuery({
    id: "query_test_1",
    timestamp: new Date().toISOString(),
    storeId: validStore.id,
    userPrompt: "Change theme color to blue",
    model: "gpt-4o-mini",
    latencyMs: 350,
    intentType: "mutation",
    toolCalls: ["propose_store_changes"],
    retriesCount: 0,
    usage: usageSample,
    cost,
    status: "success",
  });

  await testLogger.logQuery({
    id: "query_test_2",
    timestamp: new Date().toISOString(),
    storeId: validStore.id,
    userPrompt: "How do shipping rates work?",
    model: "gpt-4o-mini",
    latencyMs: 150,
    intentType: "doc_question",
    toolCalls: ["search_documentation"],
    retriesCount: 0,
    usage: { promptTokens: 300, cachedTokens: 0, completionTokens: 100, totalTokens: 400 },
    cost: calculateCost("gpt-4o-mini", { promptTokens: 300, cachedTokens: 0, completionTokens: 100, totalTokens: 400 }),
    status: "success",
  });

  const loggedEntries = await testLogger.getLogs();
  assert.equal(loggedEntries.length, 2);
  assert.equal(loggedEntries[0].id, "query_test_1");
  assert.equal(loggedEntries[0].intentType, "mutation");

  const summary = await testLogger.getSummary(validStore.id);
  assert.equal(summary.totalQueries, 2);
  assert.equal(summary.mutationsCount, 1);
  assert.equal(summary.questionsCount, 1);
  assert.equal(summary.totalPromptTokens, 1300);
  assert.equal(summary.totalCachedTokens, 400);
  assert.ok(summary.totalCostUsd > 0);
  console.log(`  Passed: Query logs persisted to JSONL and summary aggregated (${summary.totalQueries} queries, $${summary.totalCostUsd} USD).`);

  // Test 12: Predicate-Based Path Compilation (Solution B)
  console.log("\nTest 12: Testing Predicate Path Compilation ([id=xyz] resolution)...");
  const compiledPaymentPath = compilePredicatePath(validStore, "/paymentProviders[id=cod]/enabled");
  assert.equal(compiledPaymentPath, "/paymentProviders/4/enabled");

  const compiledNestedPath = compilePredicatePath(
    validStore,
    "/shippingZones[id=zone_sa]/rates[id=rate_std]/price"
  );
  assert.equal(compiledNestedPath, "/shippingZones/0/rates/0/price");

  const compiledProductPath = compilePredicatePath(validStore, "/products[id=prod_002]/price");
  assert.equal(compiledProductPath, "/products/1/price");
  console.log("  Passed: Semantic predicate paths compiled cleanly to exact RFC 6902 array indices.");

  // Test 13: Staging Predicate Mutation End-to-End
  console.log("\nTest 13: Staging Predicate Mutation End-to-End (Enable COD)...");
  const predicatePatches: JsonPatchOperation[] = [
    { op: "replace", path: "/paymentProviders[id=cod]/enabled", value: true },
    { op: "replace", path: "/products[id=prod_001]/price", value: 70 },
  ];

  const predicateStageResult = await stagingService.stageMutation(
    validStore.id,
    rolledBack.version,
    "Enable Cash on Delivery and adjust Ethiopian Yirgacheffe price",
    predicatePatches
  );

  assert.equal(predicateStageResult.success, true);
  if (predicateStageResult.success) {
    const session = predicateStageResult.session;
    assert.equal(session.stagedStore.paymentProviders[4].enabled, true);
    assert.equal(session.stagedStore.products[0].price, 70);
    assert.equal(session.patches[0].path, "/paymentProviders/4/enabled");
    assert.equal(session.patches[1].path, "/products/0/price");

    // Check semantic diff
    const codDiff = session.semanticChanges.find((c) => c.path === "/paymentProviders/4/enabled");
    assert.ok(codDiff);
    assert.ok(codDiff?.summary.includes("Cash on Delivery"));
    console.log("  Passed: Predicate mutation staged, compiled, and validated with semantic diff generated.");
  }

  // Test 14: Arithmetic Operations (Increment, Decrement, Non-negative Clamping)
  console.log("\nTest 14: Testing Arithmetic Ops (Increment, Decrement & Zero-Clamping)...");
  const arithmeticPatches: JsonPatchOperation[] = [
    { op: "increment", path: "/products[id=prod_001]/price", value: 5 }, // 65 + 5 = 70
    { op: "decrement", path: "/products[id=prod_003]/inventory", value: 50 }, // 15 - 50 -> clamped to 0
  ];
  const arithmeticStageResult = await stagingService.stageMutation(
    validStore.id,
    rolledBack.version,
    "Increase Ethiopian coffee price by 5 and reduce V60 stock with clamping",
    arithmeticPatches
  );
  assert.equal(arithmeticStageResult.success, true);
  if (arithmeticStageResult.success) {
    assert.equal(arithmeticStageResult.session.stagedStore.products[0].price, 70);
    assert.equal(arithmeticStageResult.session.stagedStore.products[2].inventory, 0); // clamped!
    console.log("  Passed: Increment added delta correctly and decrement clamped at 0.");
  }

  // Test 15: Percentage Scaling Ops
  console.log("\nTest 15: Testing Percentage Scaling (+10% markup and -20% discount)...");
  const percentPatches: JsonPatchOperation[] = [
    { op: "percentage", path: "/products[id=prod_001]/price", value: 10 }, // 65 * 1.1 = 71.5
    { op: "percentage", path: "/products[id=prod_002]/price", value: -20 }, // 58 * 0.8 = 46.4
  ];
  const percentStageResult = await stagingService.stageMutation(
    validStore.id,
    rolledBack.version,
    "Apply 10% markup on prod_001 and 20% discount on prod_002",
    percentPatches
  );
  assert.equal(percentStageResult.success, true);
  if (percentStageResult.success) {
    assert.equal(percentStageResult.session.stagedStore.products[0].price, 71.5);
    assert.equal(percentStageResult.session.stagedStore.products[1].price, 46.4);
    console.log("  Passed: Percentage scaling calculated accurate prices (71.50 and 46.40 SAR).");
  }

  // Test 16: Wildcard Expansion across Array ([*])
  console.log("\nTest 16: Testing Wildcard Expansion (/products[*]/price)...");
  const wildcardPatches: JsonPatchOperation[] = [
    { op: "percentage", path: "/products[*]/price", value: 10 },
  ];
  const wildcardStageResult = await stagingService.stageMutation(
    validStore.id,
    rolledBack.version,
    "Apply 10% inflation adjustment across all catalog products",
    wildcardPatches
  );
  assert.equal(wildcardStageResult.success, true);
  if (wildcardStageResult.success) {
    const session = wildcardStageResult.session;
    // Store has 3 products, so exactly 3 compiled patches should be generated
    assert.equal(session.patches.length, 3);
    assert.equal(session.stagedStore.products[0].price, 71.5); // 65 * 1.1
    assert.equal(session.stagedStore.products[1].price, 63.8); // 58 * 1.1
    assert.equal(session.stagedStore.products[2].price, 99);   // 90 * 1.1
    console.log(`  Passed: Wildcard expanded to all ${session.patches.length} products with exact RFC 6902 replacements.`);
  }

  // Test 17: Verifying Compound Prompt AgentResponse Data Contract
  console.log("\nTest 17: Verifying Compound Prompt AgentResponse Data Contract...");
  const compoundResponse: AgentResponse = {
    type: "mutation_staged",
    message: "Staged 1 change: Enabled Cash on Delivery payment provider",
    answerText:
      "Mada is the local debit card payment network in Saudi Arabia that allows customers to pay online using ATM cards. I have also staged enabling Cash on Delivery for your store.",
    citations: ["Configuring Payment Gateways in Mtajir"],
    stagingSession: wildcardStageResult.success ? wildcardStageResult.session : undefined,
  };
  assert.equal(compoundResponse.type, "mutation_staged");
  assert.ok(compoundResponse.stagingSession);
  assert.ok(compoundResponse.answerText);
  assert.equal(compoundResponse.answerText.includes("Mada is the local debit"), true);
  assert.equal(compoundResponse.citations?.[0], "Configuring Payment Gateways in Mtajir");
  console.log("  Passed: Compound response preserves text Q&A answer, citations, and staged mutation session.");

  // Test 18: Preventing No-Op / Redundant Modifications (e.g. #1E293B to #1E293B)
  console.log("\nTest 18: Testing No-Op / Redundant Modification Prevention...");
  const noOpPatches: JsonPatchOperation[] = [
    { op: "replace", path: "/theme/colors/primary", value: "#1E293B" }, // already #1E293B
  ];
  const noOpResult = await stagingService.stageMutation(
    validStore.id,
    rolledBack.version,
    "Change primary color to #1E293B",
    noOpPatches
  );
  assert.equal(noOpResult.success, false);
  if (!noOpResult.success) {
    assert.equal(noOpResult.errorType, "NO_OP");
    assert.equal(noOpResult.errorMessage.includes("No changes detected"), true);
  }
  const noOpDiff = generateSemanticDiff(validStore, noOpPatches);
  assert.equal(noOpDiff.length, 0);
  console.log("  Passed: Staging blocked redundant #1E293B -> #1E293B mutation with NO_OP status.");

  // Test 19: Rollback Prompt Guidance (directing user to /rollback command)
  console.log("\nTest 19: Testing Rollback Prompt Guidance (/rollback command)...");
  const queryLogger = new QueryLoggerService(path.join(testDir, "query-logs.jsonl"));
  const agent = new KhadoomAgent(
    repository,
    stagingService,
    docsService,
    queryLogger,
    "mock-key"
  );
  const rollbackPromptRes = await agent.processUserPrompt(validStore.id, "rollback 1");
  assert.equal(rollbackPromptRes.type, "answer");
  assert.equal(rollbackPromptRes.message.includes("/rollback"), true);
  assert.equal(rollbackPromptRes.message.includes("/history"), true);
  console.log("  Passed: Agent properly directed merchant to use the CLI '/rollback' command.");

  // Test 20: Commit after Rollback Increments from High-Water Mark (Never Overwriting Existing Versions)
  console.log("\nTest 20: Testing Commit After Rollback Increments from High-Water Mark...");
  // Store is currently live at v1 (after rollback from v2).
  const postRollbackPatches: JsonPatchOperation[] = [
    { op: "replace", path: "/theme/banner/backgroundColor", value: "#10B981" },
  ];
  const postRollbackStage = await stagingService.stageMutation(
    validStore.id,
    1,
    "Update banner background to emerald green",
    postRollbackPatches
  );
  assert.equal(postRollbackStage.success, true);
  if (postRollbackStage.success) {
    const committedV3 = await stagingService.commitSession(postRollbackStage.session.sessionId);
    // Crucial: Must be v3, NOT v2! It must increment past highest recorded version (v2)
    assert.equal(committedV3.version, 3);
    assert.equal(committedV3.theme.banner.backgroundColor, "#10B981");

    // Verify v2 snapshot is intact and was NOT overwritten
    const v2SnapshotRaw = await fs.readFile(
      path.join(testDir, validStore.id, "snapshots", "v2.json"),
      "utf-8"
    );
    const v2Snapshot = JSON.parse(v2SnapshotRaw);
    assert.equal(v2Snapshot.version, 2);
    assert.equal(v2Snapshot.theme.colors.primary, "#2563EB");

    // Verify v3 snapshot was created
    const v3SnapshotRaw = await fs.readFile(
      path.join(testDir, validStore.id, "snapshots", "v3.json"),
      "utf-8"
    );
    const v3Snapshot = JSON.parse(v3SnapshotRaw);
    assert.equal(v3Snapshot.version, 3);
    assert.equal(v3Snapshot.theme.banner.backgroundColor, "#10B981");

    console.log("  Passed: New commit branched from v1 successfully became v3 without overwriting v2.");
  }

  // Clean up test directory
  await fs.rm(testDir, { recursive: true, force: true });

  console.log("\n==================================================");
  // Test 21: Markdown Corpus Loader, YAML Frontmatter & Section Chunking
  console.log("\nTest 21: Testing Markdown Corpus Loader & Section Chunker...");
  const corpus = await loadDocumentationCorpus();
  assert.ok(corpus.chunks.length >= 10, "Should split markdown articles into multiple chunks");
  assert.ok(corpus.corpusHash.length === 32, "Should compute 32-char MD5 corpus hash");
  const tabbyChunk = corpus.chunks.find((c) => c.docId === "doc_payment_tabby");
  assert.ok(tabbyChunk, "Should load doc_payment_tabby from data/docs");
  assert.deepEqual(tabbyChunk?.metadata.supportedCurrencies, ["SAR", "AED"]);
  assert.deepEqual(tabbyChunk?.metadata.supportedCountries, ["SA", "AE"]);
  console.log(
    `  Passed: Loaded ${corpus.chunks.length} chunks across Markdown corpus (hash: ${corpus.corpusHash.slice(0, 8)}...).`
  );

  // Test 22: Bilingual BM25 Normalization & Arabic Clitic/Prefix Stemming
  console.log("\nTest 22: Testing Arabic & English Normalization in BM25...");
  const arabicTokens = normalizeAndTokenize("كيف أفعل الدفع بالتقسيط لتابي في المتجر؟");
  assert.ok(
    arabicTokens.includes("تقسيط"),
    "Arabic prefix 'بال' should be stripped to match root 'تقسيط'"
  );
  assert.ok(
    arabicTokens.includes("تابي"),
    "Arabic prefix 'ل' should be stripped to match root 'تابي'"
  );

  const bm25 = new BM25SearchEngine(corpus.chunks);
  const arabicSearch = bm25.search("كيف أفعل بالتقسيط لتابي؟");
  assert.ok(arabicSearch.length > 0);
  assert.equal(arabicSearch[0].chunk.docId, "doc_payment_tabby");
  console.log("  Passed: Arabic clitic prefixes ('بالتقسيط', 'لتابي') normalized and matched doc_payment_tabby.");

  // Test 23: EmbeddingsStore Repository Adapter & MD5 Hash Persistence
  console.log("\nTest 23: Testing FileEmbeddingsStore Persistence & MD5 Deduplication...");
  const testEmbeddingsPath = path.join(testDir, "embeddings", "doc-embeddings.json");
  const testCachePath = path.join(testDir, "cache", "semantic-cache.json");
  const fileEmbeddingsStore = new FileEmbeddingsStore(testEmbeddingsPath);
  const ragService = new DocsService({
    embeddingsStore: fileEmbeddingsStore,
    embedder: testEmbedder,
    persistCachePath: testCachePath,
  });
  await ragService.syncCorpusAndEmbeddings();

  const persistedMap = await fileEmbeddingsStore.loadEmbeddings();
  assert.equal(persistedMap.size, corpus.chunks.length);
  const persistedCorpusHash = await fileEmbeddingsStore.getCorpusHash();
  assert.equal(persistedCorpusHash, corpus.corpusHash);
  console.log(`  Passed: ${persistedMap.size} chunk embeddings persisted with MD5 hashes via EmbeddingsStore.`);

  // Test 24: Hybrid RRF Search & Store Constraint Hard Filtering (SAR vs KWD)
  console.log("\nTest 24: Testing Hybrid RRF Search & Currency/Country Constraint Filtering...");
  // Querying KNet from a Saudi (SAR / SA) store must prune KWD-exclusive KNet docs
  const sarKnetResults = await ragService.searchDocsAsync("KNet payment gateway Kuwait", {
    currency: "SAR",
    country: "SA",
  });
  const hasKnetInSar = sarKnetResults.some((r) => r.docId === "doc_payment_knet");
  assert.equal(hasKnetInSar, false, "KWD-only KNet doc must be pruned for SAR/SA stores");

  // Querying KNet from a Kuwaiti (KWD / KW) store must return doc_payment_knet at Rank 1
  const kwdKnetResults = await ragService.searchDocsAsync("KNet payment gateway Kuwait", {
    currency: "KWD",
    country: "KW",
  });
  assert.ok(kwdKnetResults.length > 0);
  assert.equal(kwdKnetResults[0].docId, "doc_payment_knet");
  assert.ok(kwdKnetResults[0].rrfScore > 0);
  console.log("  Passed: Hybrid RRF ranked KNet #1 for KWD stores and hard-filtered it out for SAR stores.");

  // Test 25: Context-Scoped Semantic Cache & Corpus Hash Invalidation
  console.log("\nTest 25: Testing Context-Scoped Semantic Cache & Corpus Invalidation...");
  await ragService.setCachedAnswer(
    "how do i enable tabby installments in my store",
    "Tabby is available for SAR and AED stores with a valid CR.",
    ["Configuring Tabby (Buy Now, Pay Later)"],
    { currency: "SAR", country: "SA", locale: "ar" }
  );

  // Paraphrased / close query in same SAR/SA scope should hit semantic cache (>= 0.94 cosine sim)
  const sarCacheHit = await ragService.getCachedEntry(
    "enable tabby installments in my store",
    { currency: "SAR", country: "SA", locale: "ar" }
  );
  assert.ok(sarCacheHit, "Should hit semantic cache for matching SAR/SA store context");
  assert.equal(
    sarCacheHit?.answer,
    "Tabby is available for SAR and AED stores with a valid CR."
  );
  assert.ok((sarCacheHit?.similarity ?? 0) >= 0.94);

  // Same query from a KWD/KW store must NOT hit the SAR cached answer (prevents cache pollution)
  const kwdCacheMiss = await ragService.getCachedEntry(
    "how do i enable tabby installments in my store",
    { currency: "KWD", country: "KW", locale: "ar" }
  );
  assert.equal(
    kwdCacheMiss,
    undefined,
    "Semantic cache must isolate entries across different store currency/country constraints"
  );

  // Updating corpus hash must automatically invalidate stale cache entries
  ragService.updateCorpusHash("new_corpus_hash_after_doc_update_v2");
  const postInvalidationMiss = await ragService.getCachedEntry(
    "how do i enable tabby installments in my store",
    { currency: "SAR", country: "SA", locale: "ar" }
  );
  assert.equal(
    postInvalidationMiss,
    undefined,
    "Stale cache entries must be invalidated when corpusHash changes"
  );
  console.log(
    "  Passed: Semantic cache verified paraphrase hit (>=0.94), cross-currency isolation, and corpus-hash invalidation."
  );

  // Test 26 (C1): Dimension Mismatch Rejection & Legacy/Mixed Embeddings Invalidation
  console.log("\nTest 26 (C1): Testing Embeddings Dimension & Model Validation...");
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, "cosineSimilarity must reject mismatched vector lengths");

  const mixedEmbPath = path.join(testDir, "embeddings", "mixed-embeddings.json");
  await fs.mkdir(path.dirname(mixedEmbPath), { recursive: true });
  const mixedPayload = {
    corpusHash: corpus.corpusHash,
    updatedAt: new Date().toISOString(),
    items: corpus.chunks.map((c, idx) => ({
      chunkId: c.chunkId,
      hash: c.hash,
      vector: new Array(idx === 0 ? 1536 : 256).fill(0.1),
    })),
  };
  await fs.writeFile(mixedEmbPath, JSON.stringify(mixedPayload), "utf-8");

  const mixedStore = new FileEmbeddingsStore(mixedEmbPath);
  const c1DocsService = new DocsService({
    embeddingsStore: mixedStore,
    embedder: testEmbedder,
    persistCachePath: path.join(testDir, "cache", "c1-cache.json"),
  });
  const firstSync = await c1DocsService.syncCorpusAndEmbeddings();
  assert.equal(firstSync.newChunks, corpus.chunks.length, "Legacy mixed-dimension embeddings must all be re-embedded");
  const repairedMeta = await mixedStore.getMetadata();
  assert.equal(repairedMeta?.dimensions, 32);
  assert.equal(repairedMeta?.model, "custom:text-embedding-3-small");

  const c1SecondService = new DocsService({
    embeddingsStore: new FileEmbeddingsStore(mixedEmbPath),
    embedder: testEmbedder,
    persistCachePath: path.join(testDir, "cache", "c1-cache.json"),
  });
  const secondSync = await c1SecondService.syncCorpusAndEmbeddings();
  assert.equal(secondSync.newChunks, 0, "Uniform matching-model embeddings should hit disk cache with 0 API calls");
  console.log("  Passed: Mixed/untyped embeddings rejected cleanly and repaired with uniform dimensions.");

  // Test 27 (C2): Live Semantic Cache Isolation from Tests
  console.log("\nTest 27 (C2): Verifying Live Semantic Cache Was Not Mutated by Tests...");
  const liveCachePath = path.join(process.cwd(), "data", "cache", "semantic-cache.json");
  const liveCacheRaw = await fs.readFile(liveCachePath, "utf-8");
  const liveCacheJson = JSON.parse(liveCacheRaw);
  assert.notEqual(
    liveCacheJson.corpusHash,
    "new_corpus_hash_after_doc_update_v2",
    "Tests must never overwrite live data/cache/semantic-cache.json"
  );
  console.log("  Passed: Live semantic-cache.json remains isolated from test cache mutations.");

  // Test 28 (C3): Block SemanticCache Poisoning When inspect_store_data Runs
  console.log("\nTest 28 (C3): Testing Store-State Cache Poisoning Guard...");
  const c3Repo = new StoreRepository(path.join(testDir, "c3-stores"));
  await c3Repo.saveInitialStore(validStore);
  const c3Staging = new StagingService(c3Repo);
  const c3CachePath = path.join(testDir, "cache", "c3-cache.json");
  const c3Docs = new DocsService({
    embeddingsStore: new InMemoryEmbeddingsStore(),
    embedder: testEmbedder,
    persistCachePath: c3CachePath,
  });
  await c3Docs.syncCorpusAndEmbeddings();
  const c3Logger = new QueryLoggerService(path.join(testDir, "logs", "c3-logs.jsonl"));
  const c3Agent = new KhadoomAgent(c3Repo, c3Staging, c3Docs, c3Logger, "test-key");

  let mockTurn = 0;
  (c3Agent as any).openai = {
    chat: {
      completions: {
        create: async () => {
          mockTurn++;
          if (mockTurn === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tc_doc",
                        type: "function",
                        function: { name: "search_documentation", arguments: JSON.stringify({ query: "Tabby" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (mockTurn === 2) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tc_inspect",
                        type: "function",
                        function: { name: "inspect_store_data", arguments: JSON.stringify({ path: "/paymentProviders" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (mockTurn === 3) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Tabby is currently disabled in your store. You can enable it anytime.",
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (mockTurn === 4) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tc_doc_only",
                        type: "function",
                        function: { name: "search_documentation", arguments: JSON.stringify({ query: "Tabby" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Tabby supports SAR and AED split payments.",
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };

  const mixedRes = await c3Agent.processUserPrompt(validStore.id, "is tabby active in my store right now");
  assert.equal(mixedRes.type, "answer");
  const poisonedCache = await c3Docs.getCachedEntry("is tabby active in my store right now", {
    currency: validStore.currency,
    locale: validStore.locale,
    country: validStore.shippingZones[0].countries[0],
  });
  assert.equal(poisonedCache, undefined, "Hybrid inspect+docs turn must NOT be cached into SemanticCache");

  const pureDocsRes = await c3Agent.processUserPrompt(validStore.id, "what currencies does tabby support");
  assert.equal(pureDocsRes.type, "answer");
  const pureCached = await c3Docs.getCachedEntry("what currencies does tabby support", {
    currency: validStore.currency,
    locale: validStore.locale,
    country: validStore.shippingZones[0].countries[0],
  });
  assert.ok(pureCached, "Pure documentation Q&A turn SHOULD be cached");
  console.log("  Passed: Hybrid store-inspection answers blocked from cache while pure doc Q&A still caches.");

  // Test 29 (C4): Multi-Item Array Removal & Sequential Patch Compilation
  console.log("\nTest 29 (C4): Testing Descending Multi-Item Removals & Sequential Patches...");
  const c4Repo = new StoreRepository(path.join(testDir, "c4-stores"));
  await c4Repo.saveInitialStore(validStore);
  const c4Staging = new StagingService(c4Repo);

  const multiRemoveResult = await c4Staging.stageMutation(
    validStore.id,
    1,
    "Remove all Coffee Beans products without deleting brewing gear",
    [{ op: "remove", path: "/products[categories=Coffee Beans]" }]
  );
  assert.equal(multiRemoveResult.success, true);
  if (multiRemoveResult.success) {
    assert.equal(multiRemoveResult.session.stagedStore.products.length, 1);
    assert.equal(
      multiRemoveResult.session.stagedStore.products[0].id,
      "prod_003",
      "Only V60 Ceramic Dripper (prod_003) should remain after deleting both Coffee Beans items"
    );
    assert.equal(multiRemoveResult.session.semanticChanges.length, 2);
    const summaries = multiRemoveResult.session.semanticChanges.map((c) => c.summary).join(" | ");
    assert.ok(summaries.includes("Colombian Huila") && summaries.includes("Ethiopian Yirgacheffe"));
  }

  const sequentialResult = await c4Staging.stageMutation(
    validStore.id,
    1,
    "Remove first product then update second product by ID and chain price increment",
    [
      { op: "remove", path: "/products[id=prod_001]" },
      { op: "replace", path: "/products[id=prod_002]/price", value: 100 },
      { op: "increment", path: "/products[id=prod_002]/price", value: 15 },
    ]
  );
  assert.equal(sequentialResult.success, true);
  if (sequentialResult.success) {
    assert.equal(sequentialResult.session.stagedStore.products.length, 2);
    assert.equal(sequentialResult.session.stagedStore.products[0].id, "prod_002");
    assert.equal(
      sequentialResult.session.stagedStore.products[0].price,
      115,
      "Sequential patch after index shift must resolve prod_002 cleanly and chain increment (100 -> 115)"
    );
    assert.ok(
      sequentialResult.session.semanticChanges.every((c) => c.summary.includes("Colombian Huila") || c.summary.includes("Ethiopian Yirgacheffe")),
      "Sequential semantic diffs must reference true entity names after removal shift"
    );
  }
  console.log("  Passed: Multi-item removals and sequential index-shifting patches compiled accurately.");

  // Test 30 (H1): Multi-Line YAML Frontmatter Parsing on doc-shipping-zones.md
  console.log("\nTest 30 (H1): Testing Multi-Line YAML Frontmatter Tag Parsing...");
  const shippingChunk = corpus.chunks.find((c) => c.docId === "doc_shipping_zones");
  assert.ok(shippingChunk, "doc_shipping_zones chunk must exist");
  assert.equal(
    shippingChunk?.metadata.tags.length,
    11,
    `Expected 11 tags on doc_shipping_zones, got ${shippingChunk?.metadata.tags.length}`
  );
  assert.ok(
    shippingChunk?.metadata.tags.includes("شحن مجاني"),
    "Arabic tag 'شحن مجاني' must be parsed from multi-line YAML array"
  );
  const arabicShippingResults = bm25.search("شحن مجاني");
  assert.ok(arabicShippingResults.length > 0 && arabicShippingResults[0].chunk.docId === "doc_shipping_zones");
  console.log("  Passed: All 11 English & Arabic tags loaded from multi-line YAML frontmatter.");

  // Test 31 (H2): Lazy Dense-Vector Hydration Without syncCorpusAndEmbeddings()
  console.log("\nTest 31 (H2): Testing Lazy Vector Hydration & Empty-Store Embed Skip...");
  const lazyDocsService = new DocsService({
    embeddingsStore: new FileEmbeddingsStore(mixedEmbPath),
    embedder: testEmbedder,
    persistCachePath: path.join(testDir, "cache", "h2-cache.json"),
  });
  const lazyResults = await lazyDocsService.searchDocs("shipping rates Saudi Arabia");
  assert.ok(lazyResults.length > 0);
  assert.ok(
    lazyResults.some((r) => typeof r.vectorSimilarity === "number" && r.vectorSimilarity > 0),
    "DocsService.searchDocs() must lazily hydrate persisted vectors even without syncCorpusAndEmbeddings()"
  );

  let embedCallCount = 0;
  const countingEmptyService = new DocsService({
    embeddingsStore: new InMemoryEmbeddingsStore(),
    embedder: async (text: string) => {
      embedCallCount++;
      return testEmbedder(text);
    },
    persistCachePath: path.join(testDir, "cache", "h2-empty-cache.json"),
  });
  await countingEmptyService.searchDocs("shipping zones");
  assert.equal(embedCallCount, 0, "Should skip paid query embedding call when vector store has 0 vectors");
  console.log("  Passed: Lazy vector hydration active and empty vector store skips wasted embed call.");

  // Test 32 (H3): TOCTOU Optimistic Concurrency Check on commitSession
  console.log("\nTest 32 (H3): Testing Commit-Time Optimistic Concurrency Guard...");
  const h3Repo = new StoreRepository(path.join(testDir, "h3-stores"));
  await h3Repo.saveInitialStore(validStore);
  const h3Staging = new StagingService(h3Repo);

  const sessionA = await h3Staging.stageMutation(validStore.id, 1, "Session A theme change", [
    { op: "replace", path: "/theme/colors/primary", value: "#111111" },
  ]);
  const sessionB = await h3Staging.stageMutation(validStore.id, 1, "Session B theme change", [
    { op: "replace", path: "/theme/colors/primary", value: "#222222" },
  ]);
  assert.equal(sessionA.success, true);
  assert.equal(sessionB.success, true);
  if (sessionA.success && sessionB.success) {
    await h3Staging.commitSession(sessionB.session.sessionId);
    await assert.rejects(
      async () => {
        await h3Staging.commitSession(sessionA.session.sessionId);
      },
      /CONCURRENCY_CONFLICT/,
      "Committing stale sessionA after sessionB bumped store to v2 must fail with CONCURRENCY_CONFLICT"
    );
    const liveAfterConflict = await h3Repo.getStore(validStore.id);
    assert.equal(liveAfterConflict?.version, 2);
    assert.equal(liveAfterConflict?.theme.colors.primary, "#222222");
  }
  console.log("  Passed: Commit-time TOCTOU race blocked cleanly without overwriting v2.");

  // Test 33 (H4): Bounded Multi-Turn Session Memory
  console.log("\nTest 33 (H4): Testing Bounded Multi-Turn Session Memory...");
  const h4Agent = new KhadoomAgent(h3Repo, h3Staging, countingEmptyService, c3Logger, "test-key");
  const seenMessagesPerCall: any[][] = [];
  let h4Call = 0;
  (h4Agent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          h4Call++;
          seenMessagesPerCall.push([...params.messages]);
          if (h4Call === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Which coffee product do you mean: Ethiopian Yirgacheffe or Colombian Huila?",
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Got it — Colombian Huila.",
                },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
          };
        },
      },
    },
  };

  await h4Agent.processUserPrompt(validStore.id, "change coffee price by 5", {
    conversationId: "sess_h4",
  });
  await h4Agent.processUserPrompt(validStore.id, "Colombian Huila", {
    conversationId: "sess_h4",
  });
  await h4Agent.processUserPrompt(validStore.id, "standalone query", {});

  // Call 2 should contain system + prior user + prior assistant + current user = 4 messages
  assert.equal(seenMessagesPerCall[1].length, 4);
  assert.equal(seenMessagesPerCall[1][1].content, "change coffee price by 5");
  assert.ok(String(seenMessagesPerCall[1][2].content).includes("Colombian Huila"));
  // Call 3 without conversationId must stay stateless (system + user = 2 messages)
  assert.equal(seenMessagesPerCall[2].length, 2);
  console.log("  Passed: Session memory carries compact follow-up context while omitting overhead on stateless calls.");

  // Test 34 (H5): Self-Correction Context Retention, Fast Conflict Fail, & Cumulative Patches
  console.log("\nTest 34 (H5): Testing Self-Correction Context, Fast Conflict Fail & Cumulative Mutations...");
  const h5Repo = new StoreRepository(path.join(testDir, "h5-stores"));
  await h5Repo.saveInitialStore(validStore);
  const h5Staging = new StagingService(h5Repo);
  const h5Agent = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, c3Logger, "test-key");

  // Subtest A & C: Inspect -> invalid negative price -> self-correction sees inspected product JSON -> second sequential propose_store_changes merges cleanly
  const h5PromptsSeen: any[][] = [];
  let h5Step = 0;
  (h5Agent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          h5Step++;
          h5PromptsSeen.push(params.messages);
          if (h5Step === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "h5_inspect",
                        type: "function",
                        function: { name: "inspect_store_data", arguments: JSON.stringify({ path: "/products" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (h5Step === 2) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "h5_bad_patch",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: JSON.stringify({
                            explanation: "Set invalid negative price",
                            patches: [{ op: "replace", path: "/products[id=prod_002]/price", value: -10 }],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (h5Step === 3) {
            // Self-correction call MUST retain inspect_store_data tool output containing Colombian Huila!
            const flat = JSON.stringify(params.messages);
            assert.ok(flat.includes("Colombian Huila"), "Self-correction call must keep inspected store JSON");
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "h5_fixed_patch",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: JSON.stringify({
                            explanation: "Set Colombian Huila price to 60",
                            patches: [{ op: "replace", path: "/products[id=prod_002]/price", value: 60 }],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (h5Step === 4) {
            // Second propose_store_changes turn in same prompt (must merge instead of clobbering!)
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "h5_second_patch",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: JSON.stringify({
                            explanation: "Also enable Tabby",
                            patches: [{ op: "replace", path: "/paymentProviders[id=tabby]/enabled", value: true }],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          return {
            choices: [{ message: { role: "assistant", content: "Both price and Tabby staged." } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };

  const h5Result = await h5Agent.processUserPrompt(validStore.id, "Set Colombian Huila to 60 and enable Tabby");
  assert.equal(h5Result.type, "mutation_staged");
  assert.equal(h5Result.stagingSession?.stagedStore.products[1].price, 60);
  assert.equal(h5Result.stagingSession?.stagedStore.paymentProviders.find((p) => p.id === "tabby")?.enabled, true);

  // Subtest B: CONCURRENCY_CONFLICT must fail fast (0 OpenAI retries inside handleMutationWithSelfCorrection)
  let conflictCallCount = 0;
  (h5Agent as any).openai = {
    chat: {
      completions: {
        create: async () => {
          conflictCallCount++;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "h5_conflict",
                      type: "function",
                      function: {
                        name: "propose_store_changes",
                        arguments: JSON.stringify({
                          explanation: "Will fail version check",
                          patches: [{ op: "replace", path: "/theme/colors/primary", value: "#333333" }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  const conflictRes = await (h5Agent as any).handleMutationWithSelfCorrection(
    validStore.id,
    99,
    "Stale conflict test",
    [{ op: "replace", path: "/theme/colors/primary", value: "#333333" }],
    "change color",
    validStore,
    () => {}
  );
  assert.equal(conflictRes.type, "error");
  assert.equal(conflictCallCount, 0, "CONCURRENCY_CONFLICT must not trigger LLM retry calls");
  console.log("  Passed: Self-correction preserved inspected context, merged sequential mutations, and aborted conflict retries.");

  // Test 35 (Harness Gap): Safe Malformed Tool-Call JSON Parsing & Recovery
  console.log("\nTest 35 (Gap): Testing Safe Tool-Call JSON Parsing & Self-Recovery...");
  const gapAgent = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, c3Logger, "test-key");
  let gapStep = 0;
  (gapAgent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          gapStep++;
          if (gapStep === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "gap_bad_json",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: "{explanation: 'unquoted bad json",
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          if (gapStep === 2) {
            // Confirm invalid-JSON tool error was fed back to the model
            const lastMsg = params.messages[params.messages.length - 1];
            assert.equal(lastMsg.role, "tool");
            assert.ok(String(lastMsg.content).includes("Invalid JSON arguments"));
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "gap_fenced_json",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments:
                            "```json\n{\"explanation\":\"Recovered patch\",\"patches\":[{\"op\":\"replace\",\"path\":\"/theme/colors/primary\",\"value\":\"#8B5CF6\"}]}\n```",
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          return {
            choices: [{ message: { role: "assistant", content: "Theme color staged." } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };

  const gapRes = await gapAgent.processUserPrompt(validStore.id, "Change primary color to #8B5CF6");
  assert.equal(gapRes.type, "mutation_staged");
  assert.equal(gapRes.stagingSession?.stagedStore.theme.colors.primary, "#8B5CF6");
  console.log("  Passed: Malformed JSON recovered cleanly via tool error feedback and fenced JSON stripped.");

  // Test 36 (Local/Colab LLM Switching & Cost Amortization)
  console.log("\nTest 36 (Local LLM): Testing OpenAI-Compatible Endpoint Config & Think Stripping...");
  const localAgent = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, c3Logger, undefined, undefined, {
    baseURL: "http://127.0.0.1:8000/v1",
    apiKey: "not-needed",
    model: "Qwen/Qwen3-8B",
  });
  const modelCfg = localAgent.getModelConfig();
  assert.equal(modelCfg.model, "Qwen/Qwen3-8B");
  assert.equal(modelCfg.baseURL, "http://127.0.0.1:8000/v1");
  assert.equal(modelCfg.isCustomEndpoint, true);
  assert.equal(modelCfg.disableThinking, true);

  let seenChatTemplateKwargs: any;
  (localAgent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          seenChatTemplateKwargs = params.chat_template_kwargs;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "<think>internal reasoning that must stay hidden</think>\nMtajir supports Aramex and SMSA.",
                },
              },
            ],
            usage: { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2050 },
          };
        },
      },
    },
  };

  const qwenRes = await localAgent.processUserPrompt(validStore.id, "hello");
  assert.equal(qwenRes.type, "answer");
  assert.deepEqual(seenChatTemplateKwargs, { enable_thinking: false });
  assert.equal(qwenRes.message, "Mtajir supports Aramex and SMSA.");

  const l4Cost = calculateCost(
    "Qwen/Qwen3-8B",
    { promptTokens: 3000, completionTokens: 80, totalTokens: 3080, cachedTokens: 0 },
    { latencyMs: 1800, hourlyCostUsd: 0.25 }
  );
  // (1800 / 3,600,000) * 0.25 = 0.000125 USD
  assert.equal(l4Cost.totalCostUsd, 0.000125);
  console.log("  Passed: Open-weight endpoint config, think stripping, and L4 hourly cost calculation verified.");

  // Test 37 (Unified Telemetry & Per-Model Benchmark Analytics)
  console.log("\nTest 37 (Telemetry): Testing Speed/Latency Metrics & Per-Model Aggregation...");
  const benchLogPath = path.join(testDir, "logs", "bench-telemetry.jsonl");
  const benchLogger = new QueryLoggerService(benchLogPath);
  const benchAgentOpenAI = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, benchLogger, "test-key", "gpt-4o-mini");
  const benchAgentQwen = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, benchLogger, undefined, undefined, {
    baseURL: "http://127.0.0.1:8000/v1",
    apiKey: "not-needed",
    model: "Qwen/Qwen3-8B",
  });

  (benchAgentOpenAI as any).openai = {
    chat: {
      completions: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return {
            choices: [{ message: { role: "assistant", content: "Hello from OpenAI." } }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 40,
              total_tokens: 1040,
              prompt_tokens_details: { cached_tokens: 500 },
            },
          };
        },
      },
    },
  };

  (benchAgentQwen as any).openai = {
    chat: {
      completions: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return {
            choices: [{ message: { role: "assistant", content: "Hello from Qwen3." } }],
            usage: { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 },
          };
        },
      },
    },
  };

  const openaiTurn = await benchAgentOpenAI.processUserPrompt(validStore.id, "hi");
  const qwenTurn = await benchAgentQwen.processUserPrompt(validStore.id, "hi");

  assert.equal(openaiTurn.telemetry?.providerType, "openai_api");
  assert.equal(openaiTurn.telemetry?.cacheHitRatePct, 50);
  assert.ok((openaiTurn.telemetry?.llmLatencyMs ?? 0) >= 15);
  assert.ok((openaiTurn.telemetry?.tokensPerSecond ?? 0) > 0);
  assert.ok((openaiTurn.telemetry?.msPerOutputToken ?? 0) > 0);
  assert.equal(openaiTurn.telemetry?.llmCallsCount, 1);

  assert.equal(qwenTurn.telemetry?.providerType, "custom_endpoint");
  assert.ok((qwenTurn.telemetry?.tokensPerSecond ?? 0) > 0);

  const benchSummary = await benchLogger.getSummary(validStore.id);
  assert.equal(benchSummary.totalQueries, 2);
  assert.ok(benchSummary.p50LatencyMs > 0);
  assert.ok(benchSummary.p95LatencyMs >= benchSummary.p50LatencyMs);
  assert.ok(benchSummary.byModel["gpt-4o-mini"], "Summary must include gpt-4o-mini bucket");
  assert.ok(benchSummary.byModel["Qwen/Qwen3-8B"], "Summary must include Qwen/Qwen3-8B bucket");
  assert.equal(benchSummary.byModel["gpt-4o-mini"].providerType, "openai_api");
  assert.equal(benchSummary.byModel["Qwen/Qwen3-8B"].providerType, "custom_endpoint");
  assert.equal(benchSummary.byModel["gpt-4o-mini"].cacheHitRatePct, 50);
  console.log("  Passed: Telemetry speed, latency percentiles, and per-model benchmarks verified.");

  // Test 38 (Modify Proposal Tool Enforcement)
  console.log("\nTest 38 (Modify Enforcement): Testing Forced 'propose_store_changes' Retry & Error Guard...");
  let modifyTurnCount = 0;
  let sawForcedToolChoice: any = null;
  const modifyAgent = new KhadoomAgent(h5Repo, h5Staging, countingEmptyService, c3Logger, undefined, undefined, {
    baseURL: "http://127.0.0.1:8000/v1",
    apiKey: "not-needed",
    model: "Qwen/Qwen3-8B",
  });
  (modifyAgent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          modifyTurnCount++;
          if (modifyTurnCount === 1) {
            return {
              choices: [{ message: { role: "assistant", content: "Updated Huila to 60 SAR!" } }],
              usage: { prompt_tokens: 1500, completion_tokens: 20, total_tokens: 1520 },
            };
          }
          if (modifyTurnCount === 2) {
            sawForcedToolChoice = params.tool_choice;
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_mod_forced_1",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: JSON.stringify({
                            explanation: "Set Ethiopian Yirgacheffe to 70 and Colombian Huila to 60.",
                            patches: [
                              { op: "replace", path: "/products[id=prod_001]/price", value: 70 },
                              { op: "replace", path: "/products[id=prod_002]/price", value: 60 },
                            ],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1800, completion_tokens: 45, total_tokens: 1845 },
            };
          }
          return {
            choices: [{ message: { role: "assistant", content: "Proposal staged for review." } }],
            usage: { prompt_tokens: 1900, completion_tokens: 12, total_tokens: 1912 },
          };
        },
      },
    },
  };

  const modifyRecovered = await modifyAgent.processUserPrompt(
    validStore.id,
    "Modify previous staged proposal: huila 60",
    { requireMutationProposal: true }
  );
  assert.equal(modifyRecovered.type, "mutation_staged");
  assert.deepEqual(sawForcedToolChoice, { type: "function", function: { name: "propose_store_changes" } });
  assert.equal(modifyRecovered.stagingSession?.patches.length, 2);
  if (modifyRecovered.stagingSession) {
    h5Staging.rejectSession(modifyRecovered.stagingSession.sessionId);
  }

  (modifyAgent as any).openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { role: "assistant", content: "Changes applied!" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
        }),
      },
    },
  };
  const modifyRefused = await modifyAgent.processUserPrompt(
    validStore.id,
    "Modify previous staged proposal: huila 60",
    { requireMutationProposal: true }
  );
  assert.equal(modifyRefused.type, "error");
  assert.match(modifyRefused.message, /propose_store_changes/i);
  console.log("  Passed: Modify tool enforcement forced retry and error guard verified.");

  // Test 39 (Citation Passages & Highlight Extraction): Highlighted excerpts & cache preservation
  console.log("\nTest 39 (Citation Passages): Testing Passage Highlight Extraction & Cache Preservation...");
  const samplePassage = [
    "1. Navigate to /settings/payments or ask Khadoom AI to enable Tabby.",
    "2. Verify checkout behavior while testMode is set to true.",
    "3. Switch testMode to false once your merchant account is verified.",
  ].join("\n");
  const excerptRes = extractMatchedExcerpts(
    samplePassage,
    "Switch testMode to false after your merchant account is verified.",
    "when do I disable testMode"
  );
  assert.equal(excerptRes.matchedExcerpts.length, 1);
  assert.ok(excerptRes.matchedExcerpts[0].includes("Switch testMode to false"));
  assert.ok(excerptRes.answerOverlapScore > 0);

  const builtDetails = buildCitationDetails(
    [
      {
        id: "doc_payment_tabby",
        docId: "doc_payment_tabby",
        chunkId: "doc_payment_tabby_chunk_2",
        title: "Configuring Tabby (Buy Now, Pay Later)",
        category: "Payments",
        sectionHeader: "Activation Steps",
        content: samplePassage,
        tags: ["tabby"],
        rrfScore: 0.032,
        metadata: { entities: ["Tabby"], tags: ["tabby"] },
      },
    ],
    "Switch testMode to false after your merchant account is verified.",
    "when do I disable testMode"
  );
  assert.equal(builtDetails.length, 1);
  assert.equal(builtDetails[0].passages[0].matchedExcerpts.length, 1);

  const citeCacheDir = path.join(testDir, "cite-cache");
  const citeDocsService = new DocsService({
    embeddingsStore: new InMemoryEmbeddingsStore(),
    persistCachePath: path.join(citeCacheDir, "semantic-cache.json"),
    embedder: async (text: string) => {
      const lower = text.toLowerCase();
      return [
        lower.includes("tabby") || lower.includes("installment") ? 1 : 0,
        lower.includes("testmode") || lower.includes("activate") || lower.includes("requirement") ? 1 : 0,
        0.1,
      ];
    },
  });
  await citeDocsService.syncCorpusAndEmbeddings();
  const citeAgent = new KhadoomAgent(h5Repo, h5Staging, citeDocsService, c3Logger, "test-key");
  let citeStep = 0;
  (citeAgent as any).openai = {
    chat: {
      completions: {
        create: async () => {
          citeStep++;
          if (citeStep === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_cite_search",
                        type: "function",
                        function: {
                          name: "search_documentation",
                          arguments: JSON.stringify({ query: "Tabby activation requirements SAR AED" }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "To activate Tabby in live mode, your store must operate in SAR or AED and hold a Saudi or UAE Commercial Registration.",
                },
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
          };
        },
      },
    },
  };

  const citeFirstRes = await citeAgent.processUserPrompt(
    validStore.id,
    "What are the requirements to activate Tabby?"
  );
  assert.equal(citeFirstRes.type, "answer");
  assert.ok(citeFirstRes.citations && citeFirstRes.citations.length > 0);
  assert.ok(citeFirstRes.citationDetails && citeFirstRes.citationDetails.length > 0);
  const tabbyDetail = citeFirstRes.citationDetails!.find((d) => d.docId === "doc_payment_tabby");
  assert.ok(tabbyDetail, "Expected doc_payment_tabby in citationDetails");
  assert.ok(
    tabbyDetail!.passages[0].matchedExcerpts.some((e) => e.includes("Commercial Registration")),
    "Top passage must highlight the Commercial Registration sentence used in the answer"
  );

  // Repeat identical query: must hit semantic cache AND preserve citationDetails
  const citeCachedRes = await citeAgent.processUserPrompt(
    validStore.id,
    "What are the requirements to activate Tabby?"
  );
  assert.equal(citeCachedRes.telemetry?.semanticCacheHit, true);
  assert.ok(citeCachedRes.citationDetails && citeCachedRes.citationDetails.length > 0);
  assert.equal(citeCachedRes.citationDetails![0].title, citeFirstRes.citationDetails![0].title);
  console.log("  Passed: Citation passage extraction, highlighting, and cache preservation verified.");

  // Test 40 (Cross-Encoder Reranker + Fallback): Rerank RRF candidates and fall back cleanly on errors
  console.log("\nTest 40 (Reranker): Testing Cross-Encoder Reranking & Fallback...");
  const rerankDocs = new DocsService({
    embeddingsStore: new InMemoryEmbeddingsStore(),
    persistCachePath: path.join(testDir, "rerank-cache.json"),
    embedder: async () => [0.5, 0.5, 0.5],
    reranker: new RerankerService({
      customReranker: async (_q, docs, topN) => {
        // Promote doc_shipping_zones chunk to rank 1
        const sorted = [...docs].sort((a, b) => {
          const aShip = a.chunkId.includes("shipping") ? 1 : 0;
          const bShip = b.chunkId.includes("shipping") ? 1 : 0;
          return bShip - aShip;
        });
        return sorted.slice(0, topN).map((d, idx) => ({
          chunkId: d.chunkId,
          score: d.chunkId.includes("shipping") ? 0.97 : 0.42,
          rank: idx + 1,
        }));
      },
    }),
    rerankerMode: "local",
  });
  await rerankDocs.syncCorpusAndEmbeddings();
  const rerankedHits = await rerankDocs.searchDocs("delivery free threshold", { limit: 3 });
  assert.ok(rerankedHits.length > 0);
  assert.equal(rerankedHits[0].docId, "doc_shipping_zones");
  assert.equal(rerankedHits[0].rerankScore, 0.97);
  assert.equal(rerankedHits[0].rerankRank, 1);

  // Verify graceful fallback to RRF when reranker fails
  rerankDocs.setReranker(
    new RerankerService({
      customReranker: async () => {
        throw new Error("Simulated reranker timeout");
      },
    }),
    "commercial"
  );
  const fallbackHits = await rerankDocs.searchDocs("shipping zones", { limit: 3 });
  assert.ok(fallbackHits.length > 0);
  assert.equal(fallbackHits[0].rerankScore, undefined);
  console.log("  Passed: Reranker promotion and graceful RRF fallback verified.");

  // Test 41 (Provider Router & Inactive Option Guards): Reject inactive pairs/rerankers
  console.log("\nTest 41 (Router): Testing ProviderRouter Availability Guards & Cross-Pair Switching...");
  const savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
    RERANKER_BASE_URL: process.env.RERANKER_BASE_URL,
    COHERE_API_KEY: process.env.COHERE_API_KEY,
  };
  try {
    process.env.OPENAI_API_KEY = "sk-test-commercial-key";
    delete process.env.LLM_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.RERANKER_BASE_URL;
    process.env.COHERE_API_KEY = "cohere-test-key";

    const testRouter = new ProviderRouter({
      repository: h5Repo,
      stagingService: h5Staging,
      queryLogger: c3Logger,
      qdrantUrl: "http://127.0.0.1:19999", // unreachable -> cleanly falls back to file store
    });
    const rState = await testRouter.initialize();
    assert.equal(rState.vectorDb.mode, "file");
    assert.equal(rState.selectedPair, "commercial");
    assert.equal(rState.modelPairs.find((p) => p.id === "commercial")?.active, true);
    assert.equal(rState.modelPairs.find((p) => p.id === "local")?.active, false);
    assert.equal(rState.rerankers.find((r) => r.id === "local")?.active, false);
    assert.equal(rState.rerankers.find((r) => r.id === "commercial")?.active, true);

    await assert.rejects(
      () => testRouter.setSelection({ modelPair: "local" }),
      /inactive/i
    );
    await assert.rejects(
      () => testRouter.setSelection({ reranker: "local" }),
      /inactive/i
    );

    // Commercial pair can select Commercial reranker cleanly
    const updatedState = await testRouter.setSelection({ reranker: "commercial" });
    assert.equal(updatedState.selectedPair, "commercial");
    assert.equal(updatedState.selectedReranker, "commercial");
    assert.equal(testRouter.getActiveDocsService().getRerankerMode(), "commercial");

    // Verify commercial pair never leaks LLM_BASE_URL / EMBEDDING_BASE_URL when both env sets exist
    process.env.LLM_BASE_URL = "https://colab-qwen-mock.trycloudflare.com/v1";
    process.env.EMBEDDING_BASE_URL = "https://colab-embed-mock.trycloudflare.com/v1";
    await testRouter.refreshStatus();
    assert.equal(testRouter.getActivePair(), "commercial");
    const commercialAgentCfg = testRouter.getActiveAgent().getModelConfig();
    assert.equal(commercialAgentCfg.baseURL, undefined);
    assert.equal(commercialAgentCfg.isCustomEndpoint, false);
    assert.equal(commercialAgentCfg.model, "gpt-4o-mini");
  } finally {
    process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
    process.env.LLM_BASE_URL = savedEnv.LLM_BASE_URL;
    process.env.EMBEDDING_BASE_URL = savedEnv.EMBEDDING_BASE_URL;
    process.env.RERANKER_BASE_URL = savedEnv.RERANKER_BASE_URL;
    process.env.COHERE_API_KEY = savedEnv.COHERE_API_KEY;
  }
  console.log("  Passed: ProviderRouter availability detection, inactive blocking, and cross-pair reranker verified.");

  // Test 42 (VectorDB Native Query Delegation & Deterministic UUIDs)
  console.log("\nTest 42 (VectorDB): Testing Qdrant UUID Determinism & Native querySimilar Delegation...");
  const uuidA1 = chunkIdToUuid("doc_payment_tabby#chunk_0");
  const uuidA2 = chunkIdToUuid("doc_payment_tabby#chunk_0");
  const uuidB = chunkIdToUuid("doc_payment_tabby#chunk_1");
  assert.equal(uuidA1, uuidA2);
  assert.notEqual(uuidA1, uuidB);
  assert.match(uuidA1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

  let nativeQueryCalled = false;
  const mockVectorDbStore = {
    loadEmbeddings: async () => new Map(),
    saveEmbeddings: async () => {},
    getCorpusHash: async () => null,
    querySimilar: async () => {
      nativeQueryCalled = true;
      return [{ chunkId: "doc_shipping_zones#chunk_0", similarity: 0.91 }];
    },
  };
  const nativeDocs = new DocsService({
    embeddingsStore: mockVectorDbStore,
    persistCachePath: path.join(testDir, "native-qdrant-cache.json"),
    embedder: async () => [0.1, 0.2, 0.3],
  });
  const nativeHits = await nativeDocs.searchDocs("shipping zones", { limit: 3, currency: "SAR" });
  assert.equal(nativeQueryCalled, true);
  assert.ok(nativeHits.some((h) => h.chunkId === "doc_shipping_zones#chunk_0"));
  console.log("  Passed: Qdrant deterministic UUIDs and native VectorDB query delegation verified.");

  // Test 43: Live AgentStep Stream Callbacks & Completed Steps Telemetry
  console.log("\nTest 43: Testing Live AgentStep Callbacks & Completed Steps...");
  const stepAgent = new KhadoomAgent(h5Repo, h5Staging, citeDocsService, c3Logger, "test-key");
  let stepMockTurn = 0;
  (stepAgent as any).openai = {
    chat: {
      completions: {
        create: async () => {
          stepMockTurn++;
          if (stepMockTurn === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_step_inspect",
                        type: "function",
                        function: {
                          name: "inspect_store_data",
                          arguments: JSON.stringify({ path: "/currency" }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Your store currency is SAR.",
                },
              },
            ],
            usage: { prompt_tokens: 110, completion_tokens: 14, total_tokens: 124 },
          };
        },
      },
    },
  };
  const emittedEvents: AgentStep[] = [];
  const stepRes = await stepAgent.processUserPrompt(validStore.id, "Check my current store currency", {
    onStep: (s) => emittedEvents.push(s),
  });
  assert.equal(stepRes.type, "answer");
  assert.ok(stepRes.steps && stepRes.steps.length === 3, `Expected 3 steps, got ${stepRes.steps?.length}`);
  assert.equal(stepRes.steps![0].toolName, "llm");
  assert.equal(stepRes.steps![1].toolName, "inspect_store_data");
  assert.equal(stepRes.steps![1].detail, "/currency");
  assert.equal(stepRes.steps![2].toolName, "llm");
  assert.ok(stepRes.steps!.every((s) => s.status === "done" && typeof s.durationMs === "number"));
  // Each step emits running then done (6 events total)
  assert.equal(emittedEvents.length, 6);
  assert.equal(emittedEvents[0].status, "running");
  assert.equal(emittedEvents[1].status, "done");
  assert.equal(emittedEvents[2].status, "running");
  assert.equal(emittedEvents[3].status, "done");

  // Also test semantic cache hit step emission
  await citeDocsService.setCachedAnswer(
    "What currencies work with Tabby?",
    "Tabby works with SAR and AED.",
    ["Tabby Activation Guide"],
    { currency: validStore.currency, locale: validStore.locale, country: "SA" }
  );
  const cacheEvents: AgentStep[] = [];
  const cacheRes = await stepAgent.processUserPrompt(validStore.id, "What currencies work with Tabby?", {
    onStep: (s) => cacheEvents.push(s),
  });
  assert.equal(cacheRes.telemetry?.semanticCacheHit, true);
  assert.equal(cacheRes.steps?.length, 1);
  assert.equal(cacheRes.steps?.[0].toolName, "semantic_cache");
  assert.equal(cacheEvents.length, 2);
  console.log("  Passed: Live AgentStep running/done stream callbacks and cache steps verified.");

  // Test 44: Compound Prompt Mutation Retry Guard (forces propose_store_changes after inspect-only confirm)
  console.log("\nTest 44: Testing Compound Prompt Mutation Retry Guard...");
  const guardAgent = new KhadoomAgent(h5Repo, h5Staging, citeDocsService, c3Logger, "test-key");
  let guardTurn = 0;
  let guardSawForcedProposal = false;
  (guardAgent as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          guardTurn++;
          if (guardTurn === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_guard_inspect",
                        type: "function",
                        function: { name: "inspect_store_data", arguments: JSON.stringify({ path: "/theme/colors" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
            };
          }
          if (guardTurn === 2) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Your primary color is #1E293B. Would you like me to proceed with changing it to #FFFFFF?",
                  },
                },
              ],
              usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 },
            };
          }
          if (guardTurn === 3) {
            guardSawForcedProposal =
              typeof params?.tool_choice === "object" &&
              params?.tool_choice?.function?.name === "propose_store_changes";
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_guard_propose",
                        type: "function",
                        function: {
                          name: "propose_store_changes",
                          arguments: JSON.stringify({
                            explanation: "Set primary color to #FFFFFF",
                            patches: [{ op: "replace", path: "/theme/colors/primary", value: "#FFFFFF" }],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Your primary color is currently #1E293B. I have staged the change to #FFFFFF.",
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          };
        },
      },
    },
  };
  const guardRes = await guardAgent.processUserPrompt(
    validStore.id,
    "what is my primary color, also change primary color to white"
  );
  assert.equal(guardSawForcedProposal, true);
  assert.equal(guardRes.type, "mutation_staged");
  assert.ok(guardRes.stagingSession?.sessionId);
  assert.ok(guardRes.answerText?.includes("#1E293B"));
  console.log("  Passed: Compound prompt mutation retry guard forced propose_store_changes and preserved answer.");

  // Test 45: Agent Eval Dataset Paths & Outcome Scorer
  console.log("\nTest 45: Testing Agent Eval Dataset & Outcome Scorer...");
  const evalDatasetRaw = await fs.readFile(path.join(process.cwd(), "evals", "agent_eval_dataset.json"), "utf-8");
  const evalTasks = JSON.parse(evalDatasetRaw) as AgentEvalTask[];
  assert.equal(evalTasks.length, 18);
  for (const t of evalTasks) {
    if (t.expectedStateChecks) {
      for (const chk of t.expectedStateChecks) {
        const compiled = compilePredicatePath(SEED_STORE, chk.path);
        const val = getValueAtPath(SEED_STORE, compiled);
        assert.notEqual(val, undefined, `Dataset path '${chk.path}' in ${t.id} must resolve on SEED_STORE`);
      }
    }
  }
  const tabbyTask = evalTasks.find((t) => t.id === "task_01_enable_tabby")!;
  const h5Live = (await h5Repo.getStore(validStore.id))!;
  const stagedPass = await h5Staging.stageMutation(validStore.id, h5Live.version, "Enable Tabby", [
    { op: "replace", path: "/paymentProviders[id=tabby]/enabled", value: true },
  ]);
  assert.equal(stagedPass.success, true);
  const okOutcome = evaluateTaskOutcome(
    tabbyTask,
    { type: "mutation_staged", message: "Enabled Tabby", stagingSession: stagedPass.success ? stagedPass.session : undefined },
    ["propose_store_changes"]
  );
  assert.equal(okOutcome.passed, true);
  const badOutcome = evaluateTaskOutcome(
    tabbyTask,
    { type: "answer", message: "Would you like me to proceed?" },
    ["inspect_store_data"]
  );
  assert.equal(badOutcome.passed, false);
  assert.ok(badOutcome.failureReasons.length >= 2);
  console.log("  Passed: Agent eval dataset (18 tasks) and deterministic outcome scorer verified.");

  // Clean up test directory again
  await fs.rm(testDir, { recursive: true, force: true });

  console.log("\n==================================================");
  console.log(" ALL 45 VERIFICATION TESTS PASSED SUCCESSFULLY!   ");
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
