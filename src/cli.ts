import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import { StoreRepository } from "./storage/store.repository.js";
import { StagingService } from "./staging/staging.service.js";
import { DocsService } from "./rag/docs.service.js";
import { KhadoomAgent } from "./agent/khadoom.agent.js";
import { QueryLoggerService } from "./telemetry/query-logger.js";
import { SEED_STORE } from "./data/seed-store.js";

dotenv.config({ override: true });

if (!process.env.OPENAI_API_KEY) {
  console.warn("\n[Warning] OPENAI_API_KEY is not defined in your environment or .env file.");
  console.warn("Please add OPENAI_API_KEY=sk-... to your .env file.\n");
}

async function main() {
  const rl = readline.createInterface({ input, output });

  console.log("==================================================");
  console.log("   KHADOOM AI: STORE HARNESS (MTAJIR DEMO)       ");
  console.log("==================================================");

  const repository = new StoreRepository();
  const stagingService = new StagingService(repository);
  const docsService = new DocsService();
  const queryLogger = new QueryLoggerService();
  const agent = new KhadoomAgent(repository, stagingService, docsService, queryLogger);

  const storeId = SEED_STORE.id;

  // Initialize store if not already present
  let store = await repository.getStore(storeId);
  if (!store) {
    console.log(`[Init] Seeding store '${SEED_STORE.name}' (v1)...`);
    store = await repository.saveInitialStore(SEED_STORE);
  }

  console.log(`\nActive Store: ${store.name} (ID: ${store.id}) | Version: v${store.version}`);
  console.log(`Primary Color: ${store.theme.colors.primary} | Banner: ${store.theme.banner.enabled ? "Active" : "Disabled"}`);
  console.log(`Products: ${store.products.length} | Payment Gateways: ${store.paymentProviders.filter(p => p.enabled).map(p => p.name).join(", ")}`);
  console.log("\nCommands available:");
  console.log(" - Type any question (e.g., 'How do shipping zones work in Mtajir?')");
  console.log(" - Type any store change request (e.g., 'Change primary color to #2563EB and enable banner')");
  console.log(" - '/cost'     : View cumulative token usage & API cost metrics");
  console.log(" - '/history'  : View version snapshot changelog");
  console.log(" - '/rollback <v>' : Roll back live store to version <v>");
  console.log(" - '/store'    : Print current store status");
  console.log(" - '/exit'     : Quit\n");

  while (true) {
    const userInput = await rl.question("\n[Merchant Prompt] > ");
    const trimmed = userInput.trim();

    if (!trimmed) continue;
    if (trimmed === "/exit") {
      console.log("Exiting Khadoom AI. Goodbye!");
      break;
    }

    if (trimmed === "/store") {
      const current = await repository.getStore(storeId);
      console.log(JSON.stringify(current, null, 2));
      continue;
    }

    if (trimmed === "/cost" || trimmed === "/usage") {
      const summary = await queryLogger.getSummary(storeId);
      console.log("\n==================================================");
      console.log("      KHADOOM AI: TOKEN USAGE & COST METRICS      ");
      console.log("==================================================");
      console.log(`Total Requests:    ${summary.totalQueries} (${summary.mutationsCount} mutations, ${summary.questionsCount} questions)`);
      console.log(`Prompt Tokens:     ${summary.totalPromptTokens.toLocaleString()} (${summary.totalCachedTokens.toLocaleString()} cached)`);
      console.log(`Completion Tokens: ${summary.totalCompletionTokens.toLocaleString()}`);
      console.log(`Total Tokens:      ${(summary.totalPromptTokens + summary.totalCompletionTokens).toLocaleString()}`);
      console.log(`Average Latency:   ${summary.averageLatencyMs} ms`);
      console.log(`Cumulative Cost:   $${summary.totalCostUsd.toFixed(6)} USD`);
      console.log("==================================================");
      continue;
    }

    if (trimmed === "/history") {
      const history = await repository.getChangelog(storeId);
      console.log("\n--- Store Version History ---");
      history.forEach((h) => {
        console.log(`v${h.version} [${h.timestamp}] - ${h.explanation} (${h.patches.length} patches)`);
      });
      continue;
    }

    if (trimmed.startsWith("/rollback")) {
      const parts = trimmed.split(" ");
      const targetVersion = parseInt(parts[1], 10);
      if (isNaN(targetVersion)) {
        console.log("Usage: /rollback <version_number> (e.g. /rollback 1)");
        continue;
      }
      try {
        const rolledBack = await repository.rollbackToVersion(storeId, targetVersion);
        console.log(`[Success] Rolled back to snapshot v${targetVersion}! Current live version is now v${rolledBack.version}.`);
      } catch (err: any) {
        console.error(`[Rollback Error] ${err.message}`);
      }
      continue;
    }

    console.log("[Khadoom AI] Thinking...");
    const response = await agent.processUserPrompt(storeId, trimmed);

    if (response.type === "answer") {
      console.log(`\nKhadoom: ${response.message}`);
      if (response.citations && response.citations.length > 0) {
        console.log(`(Sources: ${response.citations.join(", ")})`);
      }
    } else if (response.type === "navigation") {
      if (response.answerText) {
        console.log(`\nKhadoom: ${response.answerText}`);
      }
      console.log(`\nKhadoom: Directed to screen '${response.navigationRoute}'.`);
      console.log(`Reason: ${response.message}`);
      if (response.citations && response.citations.length > 0) {
        console.log(`(Sources: ${response.citations.join(", ")})`);
      }
    } else if (response.type === "mutation_staged" && response.stagingSession) {
      let currentResponse = response;

      while (currentResponse.type === "mutation_staged" && currentResponse.stagingSession) {
        const session = currentResponse.stagingSession;

        if (currentResponse.answerText) {
          console.log(`\nKhadoom: ${currentResponse.answerText}`);
          if (currentResponse.citations && currentResponse.citations.length > 0) {
            console.log(`(Sources: ${currentResponse.citations.join(", ")})`);
          }
        }

        console.log("\n==================================================");
        console.log("      REVERSIBLE STAGING PHASE (PROPOSED CHANGES) ");
        console.log("==================================================");
        console.log(`Summary: ${currentResponse.message}`);
        if (currentResponse.retryCount && currentResponse.retryCount > 0) {
          console.log(`(Auto-corrected after ${currentResponse.retryCount} schema validation retries)`);
        }
        console.log("\n--- Semantic Feature Comparison (Before vs After) ---");
        session.semanticChanges.forEach((change, i) => {
          console.log(`\n${i + 1}. [${change.category.toUpperCase()}] ${change.summary}`);
          if (change.details.oldValue !== undefined) {
            console.log(`   - Current: ${JSON.stringify(change.details.oldValue)}`);
          }
          if (change.details.newValue !== undefined) {
            console.log(`   + Staged:  ${JSON.stringify(change.details.newValue)}`);
          }
        });
        console.log("--------------------------------------------------");

        if (currentResponse.telemetry) {
          const t = currentResponse.telemetry;
          console.log(
            `\n[Telemetry] Model: ${t.model} | Latency: ${t.latencyMs}ms | Tokens: ${t.usage.promptTokens} in (${t.usage.cachedTokens} cached) / ${t.usage.completionTokens} out | Est. Cost: $${t.cost.totalCostUsd.toFixed(6)} USD`
          );
        }

        // Human-in-the-Loop decision
        const decision = await rl.question("\nAction: [A]ccept, [R]eject, or [M]odify? (A/R/M) > ");
        const normalized = decision.trim().toUpperCase();

        if (normalized === "A" || normalized === "ACCEPT") {
          try {
            const committed = await stagingService.commitSession(session.sessionId);
            console.log(`[Success] Changes accepted and committed! Store is now live at version v${committed.version}.`);
            console.log(`(Snapshot v${committed.version} created with full rollback support)`);
          } catch (err: any) {
            console.error(`[Commit Error] ${err.message}`);
          }
          break;
        } else if (normalized === "M" || normalized === "MODIFY") {
          const feedback = await rl.question("What would you like to modify in these changes? > ");
          console.log("[Khadoom AI] Adjusting changes based on your feedback...");
          stagingService.rejectSession(session.sessionId);
          const adjusted = await agent.processUserPrompt(
            storeId,
            `Modify previous proposal (${session.explanation}): ${feedback}`
          );
          currentResponse = adjusted;

          if (adjusted.type !== "mutation_staged") {
            if (adjusted.type === "answer") {
              console.log(`\nKhadoom: ${adjusted.message}`);
            } else if (adjusted.type === "navigation") {
              console.log(`\nKhadoom: Directed to screen '${adjusted.navigationRoute}'. Reason: ${adjusted.message}`);
            } else if (adjusted.type === "error") {
              console.error(`\n[Error] ${adjusted.message}`);
            }
            if (adjusted.telemetry) {
              const t = adjusted.telemetry;
              console.log(
                `\n[Telemetry] Model: ${t.model} | Latency: ${t.latencyMs}ms | Tokens: ${t.usage.promptTokens} in (${t.usage.cachedTokens} cached) / ${t.usage.completionTokens} out | Est. Cost: $${t.cost.totalCostUsd.toFixed(6)} USD`
              );
            }
            break;
          }
        } else {
          stagingService.rejectSession(session.sessionId);
          console.log("[Discarded] Proposed changes were rejected. Live store remains unchanged.");
          break;
        }
      }
    } else if (response.type === "error") {
      console.error(`\n[Error] ${response.message}`);
    }

    if (response.type !== "mutation_staged" && response.telemetry) {
      const t = response.telemetry;
      console.log(
        `\n[Telemetry] Model: ${t.model} | Latency: ${t.latencyMs}ms | Tokens: ${t.usage.promptTokens} in (${t.usage.cachedTokens} cached) / ${t.usage.completionTokens} out | Est. Cost: $${t.cost.totalCostUsd.toFixed(6)} USD`
      );
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
