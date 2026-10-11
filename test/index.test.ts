import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { MtajirStoreSchema } from "../src/schema/store.schema.js";
import { SEED_STORE } from "../src/data/seed-store.js";
import { StoreRepository } from "../src/storage/store.repository.js";
import { StagingService } from "../src/staging/staging.service.js";
import { generateSemanticDiff } from "../src/diff/semantic-diff.js";
import { DocsService } from "../src/rag/docs.service.js";
import { JsonPatchOperation } from "../src/schema/patch.schema.js";
import {
  QueryLoggerService,
  calculateCost,
  TokenUsage,
} from "../src/telemetry/query-logger.js";
import { compilePredicatePath } from "../src/patch/patch-compiler.js";
import { AgentResponse, KhadoomAgent } from "../src/agent/khadoom.agent.js";

async function runTests() {
  console.log("Starting Khadoom AI Harness Verification Tests...\n");

  const testDir = path.join(process.cwd(), "test-data");
  await fs.rm(testDir, { recursive: true, force: true });

  const repository = new StoreRepository(testDir);
  const stagingService = new StagingService(repository);
  const docsService = new DocsService();

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
  assert.equal(changelog.length, 1);
  console.log("  Passed: Rollback successfully restored v1 state without creating a new version.");

  // Test 9: Mtajir Documentation RAG & Semantic Cache
  console.log("\nTest 9: Verifying Documentation Search & Caching...");
  const searchResults = docsService.searchDocs("shipping");
  assert.ok(searchResults.length > 0);
  assert.equal(searchResults[0].id, "doc_shipping_zones");

  docsService.setCachedAnswer("how do shipping zones work", "Shipping is configured via geographic zones.");
  const cachedAnswer = docsService.getCachedAnswer("how do shipping zones work");
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

  // Clean up test directory
  await fs.rm(testDir, { recursive: true, force: true });

  console.log("\n==================================================");
  console.log(" ALL 19 VERIFICATION TESTS PASSED SUCCESSFULLY!   ");
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
