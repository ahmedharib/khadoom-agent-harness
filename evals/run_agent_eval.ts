import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { SEED_STORE } from "../src/data/seed-store.js";
import { StoreRepository } from "../src/storage/store.repository.js";
import { StagingService } from "../src/staging/staging.service.js";
import { DocsService, InMemoryEmbeddingsStore } from "../src/rag/docs.service.js";
import { QueryLoggerService } from "../src/telemetry/query-logger.js";
import { KhadoomAgent, type AgentResponse, type KhadoomAgentConfig } from "../src/agent/khadoom.agent.js";
import { compilePredicatePath, getValueAtPath } from "../src/patch/patch-compiler.js";
import type { MtajirStore } from "../src/schema/store.schema.js";

export interface StateCheck {
  path: string;
  equals?: string | number | boolean;
  equalsIgnoreCase?: string;
  approx?: number;
}

export interface AgentEvalTask {
  id: string;
  category: string;
  prompt: string;
  modifyFeedback?: string;
  expectedType: "answer" | "mutation_staged" | "navigation";
  expectedTools?: string[];
  forbiddenTools?: string[];
  expectedStateChecks?: StateCheck[];
  expectedAnswerAll?: string[];
  expectedAnswerAnyCount?: { terms: string[]; minMatches: number };
  expectedRouteIncludes?: string;
  expectedNoMutation?: boolean;
  expectedNoCitations?: boolean;
}

export interface AgentEvalTaskResult {
  id: string;
  category: string;
  passed: boolean;
  failureReasons: string[];
  responseType: string;
  toolsExecuted: string[];
  latencyMs: number;
  llmLatencyMs: number;
  llmCallsCount: number;
  tokensPerSecond: number;
  msPerOutputToken: number;
  retriesCount: number;
  jsonParseErrorsCount: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  answerPreview: string;
}

export interface AgentEvalReport {
  modelLabel: string;
  model: string;
  providerType: "openai_api" | "custom_endpoint";
  baseURL?: string;
  peakVramGb?: number;
  ttftMs?: number;
  timestamp: string;
  taskCount: number;
  passedCount: number;
  taskSuccessRatePct: number;
  toolAccuracyPct: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgLlmLatencyMs: number;
  avgTokensPerSecond: number;
  avgMsPerOutputToken: number;
  avgLlmCallsPerTask: number;
  totalRetries: number;
  totalJsonParseErrors: number;
  errorCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  avgCostPerTaskUsd: number;
  byCategory: Record<string, { total: number; passed: number; successRatePct: number }>;
  tasks: AgentEvalTaskResult[];
}

function getArgValue(prefix: string): string | undefined {
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p))];
}

function resolveStateValue(store: MtajirStore, exprPath: string): unknown {
  const compiled = compilePredicatePath(store, exprPath);
  return getValueAtPath(store, compiled);
}

export function evaluateTaskOutcome(
  task: AgentEvalTask,
  res: AgentResponse,
  toolsExecuted: string[]
): { passed: boolean; failureReasons: string[]; toolMatched: boolean } {
  const failureReasons: string[] = [];

  if (res.type !== task.expectedType) {
    failureReasons.push(`Expected type '${task.expectedType}', got '${res.type}' (${res.message})`);
  }

  let toolMatched = true;
  if (task.expectedTools) {
    for (const reqTool of task.expectedTools) {
      if (!toolsExecuted.includes(reqTool)) {
        toolMatched = false;
        failureReasons.push(`Missing expected tool '${reqTool}' (called: [${toolsExecuted.join(", ")}])`);
      }
    }
  }
  if (task.forbiddenTools) {
    for (const badTool of task.forbiddenTools) {
      if (toolsExecuted.includes(badTool)) {
        toolMatched = false;
        failureReasons.push(`Called forbidden tool '${badTool}'`);
      }
    }
  }

  if (task.expectedNoMutation && res.stagingSession) {
    failureReasons.push("Expected no stagingSession (no-op), but mutation was staged");
  }

  if (task.expectedNoCitations && res.citations && res.citations.length > 0) {
    failureReasons.push(`Expected no citations on out-of-scope query, got [${res.citations.join(", ")}]`);
  }

  if (task.expectedRouteIncludes) {
    const route = (res.navigationRoute || "").toLowerCase();
    if (!route.includes(task.expectedRouteIncludes.toLowerCase())) {
      failureReasons.push(
        `Expected navigationRoute containing '${task.expectedRouteIncludes}', got '${res.navigationRoute || ""}'`
      );
    }
  }

  if (task.expectedStateChecks && task.expectedStateChecks.length > 0) {
    const stagedStore = res.stagingSession?.stagedStore;
    if (!stagedStore) {
      failureReasons.push("Missing stagedStore to verify state assertions");
    } else {
      for (const chk of task.expectedStateChecks) {
        try {
          const actual = resolveStateValue(stagedStore, chk.path);
          if (chk.equals !== undefined && actual !== chk.equals) {
            failureReasons.push(`State '${chk.path}': expected ${JSON.stringify(chk.equals)}, got ${JSON.stringify(actual)}`);
          } else if (
            chk.equalsIgnoreCase !== undefined &&
            String(actual ?? "").toLowerCase() !== chk.equalsIgnoreCase.toLowerCase()
          ) {
            failureReasons.push(`State '${chk.path}': expected '${chk.equalsIgnoreCase}', got '${actual}'`);
          } else if (chk.approx !== undefined) {
            const num = Number(actual);
            if (!Number.isFinite(num) || Math.abs(num - chk.approx) > 0.05) {
              failureReasons.push(`State '${chk.path}': expected ~${chk.approx}, got ${actual}`);
            }
          }
        } catch (err: any) {
          failureReasons.push(`Failed reading path '${chk.path}': ${err?.message || err}`);
        }
      }
    }
  }

  const combinedText = `${res.answerText || ""}\n${res.message || ""}`.toLowerCase();
  if (task.expectedAnswerAll) {
    for (const term of task.expectedAnswerAll) {
      if (!combinedText.includes(term.toLowerCase())) {
        failureReasons.push(`Answer missing required detail '${term}'`);
      }
    }
  }

  if (task.expectedAnswerAnyCount) {
    const matches = task.expectedAnswerAnyCount.terms.filter((t) =>
      combinedText.includes(t.toLowerCase())
    ).length;
    if (matches < task.expectedAnswerAnyCount.minMatches) {
      failureReasons.push(
        `Answer matched ${matches}/${task.expectedAnswerAnyCount.minMatches} expected catalog terms`
      );
    }
  }

  return {
    passed: failureReasons.length === 0,
    failureReasons,
    toolMatched,
  };
}

function buildComparisonMarkdown(reports: AgentEvalReport[]): string {
  const lines: string[] = [
    "# Khadoom Agent & Model Head-to-Head Benchmark",
    "",
    "| Model Label | Model ID | Tasks Passed | Task Success | Tool Accuracy | Avg Latency | P50 / P95 | TTFT | Avg Speed | VRAM | Retries | JSON Errors | Total Cost | Avg Cost/Task |",
    "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
  ];

  for (const r of reports) {
    lines.push(
      `| ${r.modelLabel} | \`${r.model}\` | ${r.passedCount}/${r.taskCount} | ${r.taskSuccessRatePct.toFixed(1)}% | ${r.toolAccuracyPct.toFixed(1)}% | ${r.avgLatencyMs}ms | ${r.p50LatencyMs} / ${r.p95LatencyMs}ms | ${r.ttftMs !== undefined ? `${r.ttftMs}ms` : "-"} | ${r.avgTokensPerSecond} tok/s | ${r.peakVramGb !== undefined ? `${r.peakVramGb} GB` : "-"} | ${r.totalRetries} | ${r.totalJsonParseErrors} | $${r.totalCostUsd.toFixed(5)} | $${r.avgCostPerTaskUsd.toFixed(6)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function generateComparisonFromSavedResults(resultsDir: string) {
  await fs.mkdir(resultsDir, { recursive: true });
  const files = (await fs.readdir(resultsDir))
    .filter((f) => f.startsWith("agent_eval_") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.log("No saved agent_eval_*.json files found in evals/results/.");
    return;
  }
  const reports: AgentEvalReport[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(resultsDir, f), "utf-8");
    reports.push(JSON.parse(raw) as AgentEvalReport);
  }
  const md = buildComparisonMarkdown(reports);
  await fs.writeFile(path.join(resultsDir, "agent_benchmark_comparison.md"), md, "utf-8");
  console.log("\n" + md);
  console.log(`Saved comparison report to ${path.join(resultsDir, "agent_benchmark_comparison.md")}`);
}

async function main() {
  dotenv.config({ override: true });
  const resultsDir = path.resolve(process.cwd(), "evals", "results");
  if (hasFlag("--compare")) {
    await generateComparisonFromSavedResults(resultsDir);
    return;
  }

  const pair = (getArgValue("--pair=") as "commercial" | "local" | undefined) ||
    (process.env.LLM_BASE_URL ? "local" : "commercial");
  const modelOverride = getArgValue("--model=");
  const baseUrlOverride = getArgValue("--base-url=");
  const limitArg = getArgValue("--limit=");
  const limit = limitArg ? Math.max(1, parseInt(limitArg, 10)) : undefined;
  const vramArg = getArgValue("--vram-gb=");
  const peakVramGb = vramArg && Number.isFinite(Number(vramArg)) ? Number(vramArg) : undefined;
  const ttftArg = getArgValue("--ttft-ms=");
  const ttftMs = ttftArg && Number.isFinite(Number(ttftArg)) ? Number(ttftArg) : undefined;

  let agentConfig: KhadoomAgentConfig;
  if (pair === "local") {
    const baseURL = baseUrlOverride || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL;
    const model = modelOverride || process.env.LLM_MODEL || "Qwen/Qwen3-8B-FP8";
    if (!baseURL) {
      throw new Error("Local pair requires LLM_BASE_URL (or --base-url=...). Run Colab notebook Cells 1-4 first.");
    }
    agentConfig = {
      baseURL,
      apiKey: process.env.LLM_API_KEY || "not-needed",
      model,
    };
  } else {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.startsWith("your_")) {
      throw new Error("Commercial pair requires a valid OPENAI_API_KEY in .env (or use --pair=local).");
    }
    agentConfig = {
      baseURL: baseUrlOverride || undefined,
      apiKey,
      model: modelOverride || "gpt-4o-mini",
    };
  }

  const modelLabel =
    getArgValue("--model-label=") ||
    agentConfig.model!.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");

  const datasetPath = path.resolve(process.cwd(), "evals", "agent_eval_dataset.json");
  const allTasks = JSON.parse(await fs.readFile(datasetPath, "utf-8")) as AgentEvalTask[];
  const tasks = limit ? allTasks.slice(0, limit) : allTasks;

  const evalTmpDir = path.resolve(process.cwd(), "evals", `.tmp_agent_eval_${Date.now()}`);
  await fs.mkdir(evalTmpDir, { recursive: true });

  console.log(`\n=== Khadoom Agent Evaluation (${modelLabel}) ===`);
  console.log(`Model: ${agentConfig.model} | Provider: ${agentConfig.baseURL ? `Custom (${agentConfig.baseURL})` : "OpenAI API"} | Tasks: ${tasks.length}\n`);

  const taskResults: AgentEvalTaskResult[] = [];
  let toolMatchCount = 0;

  try {
    const repo = new StoreRepository(path.join(evalTmpDir, "stores"));
    const staging = new StagingService(repo);
    const docs = new DocsService({
      embeddingsStore: new InMemoryEmbeddingsStore(),
      persistCachePath: path.join(evalTmpDir, "empty-cache.json"),
    });
    const logger = new QueryLoggerService(path.join(evalTmpDir, "eval-logs.jsonl"));
    const agent = new KhadoomAgent(repo, staging, docs, logger, undefined, undefined, agentConfig);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      // Reset SEED_STORE cleanly before every task for deterministic isolation
      await repo.saveInitialStore(JSON.parse(JSON.stringify(SEED_STORE)));
      const convId = `eval_${task.id}_${Date.now()}`;
      const executedToolsSet = new Set<string>();

      const recordSteps = (res: AgentResponse) => {
        for (const s of res.steps || []) {
          if (s.toolName && s.toolName !== "llm" && s.toolName !== "semantic_cache") {
            executedToolsSet.add(s.toolName);
          }
        }
      };

      let finalRes = await agent.processUserPrompt(SEED_STORE.id, task.prompt, { conversationId: convId });
      recordSteps(finalRes);

      let totalLatencyMs = finalRes.telemetry?.latencyMs ?? 0;
      let totalLlmLatencyMs = finalRes.telemetry?.llmLatencyMs ?? 0;
      let totalLlmCalls = finalRes.telemetry?.llmCallsCount ?? 0;
      let totalRetries = finalRes.retryCount ?? 0;
      let totalJsonErrors = finalRes.telemetry?.jsonParseErrorsCount ?? 0;
      let totalPromptTok = finalRes.telemetry?.usage.promptTokens ?? 0;
      let totalCachedTok = finalRes.telemetry?.usage.cachedTokens ?? 0;
      let totalCompletionTok = finalRes.telemetry?.usage.completionTokens ?? 0;
      let totalCostUsd = finalRes.telemetry?.cost.totalCostUsd ?? 0;

      if (task.modifyFeedback) {
        if (finalRes.type === "mutation_staged" && finalRes.stagingSession) {
          const prevSession = finalRes.stagingSession;
          const modifyPrompt = `Modify the previous staged proposal "${prevSession.explanation}" (previous patches: ${JSON.stringify(
            prevSession.patches
          )}) using this merchant feedback: "${task.modifyFeedback}". Preserve any unchanged parts of the proposal and call 'propose_store_changes' with the complete updated patch list.`;

          finalRes = await agent.processUserPrompt(SEED_STORE.id, modifyPrompt, {
            conversationId: convId,
            requireMutationProposal: true,
          });
          recordSteps(finalRes);
          if (finalRes.type === "mutation_staged") {
            staging.rejectSession(prevSession.sessionId);
          }

          totalLatencyMs += finalRes.telemetry?.latencyMs ?? 0;
          totalLlmLatencyMs += finalRes.telemetry?.llmLatencyMs ?? 0;
          totalLlmCalls += finalRes.telemetry?.llmCallsCount ?? 0;
          totalRetries += finalRes.retryCount ?? 0;
          totalJsonErrors += finalRes.telemetry?.jsonParseErrorsCount ?? 0;
          totalPromptTok += finalRes.telemetry?.usage.promptTokens ?? 0;
          totalCachedTok += finalRes.telemetry?.usage.cachedTokens ?? 0;
          totalCompletionTok += finalRes.telemetry?.usage.completionTokens ?? 0;
          totalCostUsd += finalRes.telemetry?.cost.totalCostUsd ?? 0;
        }
      }

      const toolsExecuted = Array.from(executedToolsSet);
      const outcome = evaluateTaskOutcome(task, finalRes, toolsExecuted);
      if (outcome.toolMatched) toolMatchCount++;

      const tokPerSec =
        totalLlmLatencyMs > 0 && totalCompletionTok > 0
          ? Number(((totalCompletionTok * 1000) / totalLlmLatencyMs).toFixed(2))
          : 0;
      const msPerTok =
        totalLlmLatencyMs > 0 && totalCompletionTok > 0
          ? Number((totalLlmLatencyMs / totalCompletionTok).toFixed(2))
          : 0;

      taskResults.push({
        id: task.id,
        category: task.category,
        passed: outcome.passed,
        failureReasons: outcome.failureReasons,
        responseType: finalRes.type,
        toolsExecuted,
        latencyMs: totalLatencyMs,
        llmLatencyMs: totalLlmLatencyMs,
        llmCallsCount: totalLlmCalls,
        tokensPerSecond: tokPerSec,
        msPerOutputToken: msPerTok,
        retriesCount: totalRetries,
        jsonParseErrorsCount: totalJsonErrors,
        promptTokens: totalPromptTok,
        cachedTokens: totalCachedTok,
        completionTokens: totalCompletionTok,
        costUsd: Number(totalCostUsd.toFixed(8)),
        answerPreview: (finalRes.answerText || finalRes.message || "").slice(0, 180),
      });

      const badge = outcome.passed ? "PASS" : "FAIL";
      console.log(
        `[${i + 1}/${tasks.length}] ${badge} ${task.id} (${totalLatencyMs}ms, $${totalCostUsd.toFixed(5)})${
          outcome.failureReasons.length > 0 ? ` -> ${outcome.failureReasons.join(" | ")}` : ""
        }`
      );
    }
  } finally {
    await fs.rm(evalTmpDir, { recursive: true, force: true });
  }

  const passedCount = taskResults.filter((t) => t.passed).length;
  const latencies = taskResults.map((t) => t.latencyMs).sort((a, b) => a - b);
  const sumLlmMs = taskResults.reduce((s, t) => s + t.llmLatencyMs, 0);
  const sumCompletionTok = taskResults.reduce((s, t) => s + t.completionTokens, 0);
  const sumCost = taskResults.reduce((s, t) => s + t.costUsd, 0);

  const byCategory: Record<string, { total: number; passed: number; successRatePct: number }> = {};
  for (const t of taskResults) {
    if (!byCategory[t.category]) {
      byCategory[t.category] = { total: 0, passed: 0, successRatePct: 0 };
    }
    byCategory[t.category].total++;
    if (t.passed) byCategory[t.category].passed++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.successRatePct = Number(((cat.passed / cat.total) * 100).toFixed(1));
  }

  const report: AgentEvalReport = {
    modelLabel,
    model: agentConfig.model!,
    providerType: agentConfig.baseURL ? "custom_endpoint" : "openai_api",
    ...(agentConfig.baseURL ? { baseURL: agentConfig.baseURL } : {}),
    ...(peakVramGb !== undefined ? { peakVramGb } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    timestamp: new Date().toISOString(),
    taskCount: taskResults.length,
    passedCount,
    taskSuccessRatePct: Number(((passedCount / taskResults.length) * 100).toFixed(1)),
    toolAccuracyPct: Number(((toolMatchCount / taskResults.length) * 100).toFixed(1)),
    avgLatencyMs: Math.round(taskResults.reduce((s, t) => s + t.latencyMs, 0) / taskResults.length),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    avgLlmLatencyMs: Math.round(sumLlmMs / taskResults.length),
    avgTokensPerSecond: sumLlmMs > 0 && sumCompletionTok > 0 ? Number(((sumCompletionTok * 1000) / sumLlmMs).toFixed(2)) : 0,
    avgMsPerOutputToken: sumCompletionTok > 0 && sumLlmMs > 0 ? Number((sumLlmMs / sumCompletionTok).toFixed(2)) : 0,
    avgLlmCallsPerTask: Number((taskResults.reduce((s, t) => s + t.llmCallsCount, 0) / taskResults.length).toFixed(2)),
    totalRetries: taskResults.reduce((s, t) => s + t.retriesCount, 0),
    totalJsonParseErrors: taskResults.reduce((s, t) => s + t.jsonParseErrorsCount, 0),
    errorCount: taskResults.filter((t) => t.responseType === "error").length,
    totalPromptTokens: taskResults.reduce((s, t) => s + t.promptTokens, 0),
    totalCompletionTokens: sumCompletionTok,
    totalCostUsd: Number(sumCost.toFixed(6)),
    avgCostPerTaskUsd: Number((sumCost / taskResults.length).toFixed(6)),
    byCategory,
    tasks: taskResults,
  };

  await fs.mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `agent_eval_${modelLabel}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nSaved agent eval report: ${outPath}`);
  await generateComparisonFromSavedResults(resultsDir);
}

const isCliEntry = process.argv[1] && path.resolve(process.argv[1]).endsWith("run_agent_eval.ts");
if (isCliEntry) {
  main().catch((err) => {
    console.error("Agent eval failed:", err);
    process.exit(1);
  });
}
