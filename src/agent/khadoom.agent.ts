import OpenAI from "openai";
import { StoreRepository } from "../storage/store.repository.js";
import { StagingService, StagingSession } from "../staging/staging.service.js";
import { DocsService } from "../rag/docs.service.js";
import { JsonPatchOperation } from "../schema/patch.schema.js";
import { MtajirStore } from "../schema/store.schema.js";
import { compilePredicatePath, getValueAtPath as getCompiledValue } from "../patch/patch-compiler.js";
import {
  QueryLoggerService,
  calculateCost,
  TokenUsage,
  CostBreakdown,
  QueryIntentType,
} from "../telemetry/query-logger.js";

export interface AgentTelemetry {
  latencyMs: number;
  usage: TokenUsage;
  cost: CostBreakdown;
  model: string;
}

export interface AgentResponse {
  type: "answer" | "mutation_staged" | "navigation" | "error";
  message: string;
  answerText?: string;
  stagingSession?: StagingSession;
  navigationRoute?: string;
  citations?: string[];
  retryCount?: number;
  telemetry?: AgentTelemetry;
}

export interface ProcessPromptOptions {
  conversationId?: string;
  maxHistoryTurns?: number;
}

interface CompactTurnMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_MEMORY_SESSIONS = 100;
const MAX_STORED_TURN_CHARS = 450;

function truncateForMemory(text: string, maxChars = MAX_STORED_TURN_CHARS): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 3)}...`;
}

export interface KhadoomAgentConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  disableThinking?: boolean;
  timeoutMs?: number;
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

function parseToolArguments(
  rawArgs: string | undefined
): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  if (!rawArgs || !rawArgs.trim()) {
    return { ok: true, value: {} };
  }
  const cleaned = rawArgs
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be a JSON object." };
    }
    return { ok: true, value: parsed as Record<string, any> };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Malformed JSON" };
  }
}

export class KhadoomAgent {
  private openai: OpenAI;
  private repository: StoreRepository;
  private stagingService: StagingService;
  private docsService: DocsService;
  private queryLogger: QueryLoggerService;
  private model: string;
  private baseURL?: string;
  private disableThinking: boolean;
  private sessionMemory: Map<string, CompactTurnMessage[]> = new Map();

  constructor(
    repository: StoreRepository,
    stagingService: StagingService,
    docsService: DocsService,
    queryLogger = new QueryLoggerService(),
    apiKey?: string,
    model?: string,
    config: KhadoomAgentConfig = {}
  ) {
    const resolvedBaseURL =
      config.baseURL ?? (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || undefined);
    const resolvedModel = config.model || model || process.env.LLM_MODEL || "gpt-4o-mini";
    const resolvedApiKey =
      config.apiKey ||
      apiKey ||
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "dummy_key_for_mock";

    this.baseURL = resolvedBaseURL;
    this.model = resolvedModel;
    this.disableThinking =
      config.disableThinking ??
      (process.env.LLM_DISABLE_THINKING === "true" ||
        (Boolean(resolvedBaseURL) &&
          /^qwen/i.test(resolvedModel) &&
          process.env.LLM_DISABLE_THINKING !== "false"));

    this.openai = new OpenAI({
      apiKey: resolvedApiKey,
      ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {}),
      timeout: config.timeoutMs ?? 60_000,
    });
    this.repository = repository;
    this.stagingService = stagingService;
    this.docsService = docsService;
    this.queryLogger = queryLogger;
  }

  public getModelConfig(): {
    model: string;
    baseURL?: string;
    isCustomEndpoint: boolean;
    disableThinking: boolean;
  } {
    return {
      model: this.model,
      baseURL: this.baseURL,
      isCustomEndpoint: Boolean(this.baseURL),
      disableThinking: this.disableThinking,
    };
  }

  private async createChatCompletion(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    toolChoice: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["tool_choice"] = "auto"
  ) {
    const payload: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, any> = {
      model: this.model,
      messages,
      tools: this.getToolDefinitions(),
      parallel_tool_calls: false,
      tool_choice: toolChoice,
      temperature: 0.1,
    };

    if (this.disableThinking) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }

    return this.openai.chat.completions.create(payload);
  }

  private getSystemPrompt(store: MtajirStore): string {
    return `You are Khadoom AI, the intelligent co-pilot and store manager for Mtajir (an e-commerce platform).
You have two main capabilities:
1. STORE MUTATION: When the merchant requests changes to their store (e.g., updating colors, banner text, adding products, modifying shipping rates, toggling payment gateways), call the 'propose_store_changes' tool using valid RFC 6902 JSON Patches.
2. QUESTION ANSWERING & SUPPORT: When the merchant asks how something works or asks about their store or Mtajir, use the 'search_documentation' or 'inspect_store_data' tools.

CRITICAL RULES FOR STORE MUTATIONS:
- All mutations MUST use operations ('add', 'remove', 'replace', 'increment', 'decrement', 'percentage', 'multiply') starting with '/'.
- Target the schema structure:
  - Theme colors: '/theme/colors/primary', '/theme/colors/secondary', etc. (Hex codes like '#2563EB')
  - Theme banner: '/theme/banner/enabled' (boolean), '/theme/banner/text' (string), '/theme/banner/backgroundColor'
  - Products: '/products/-' for adding, '/products[id=prod_001]/price' for updating
  - Shipping: '/shippingZones[id=zone_sa]/rates[id=rate_std]/price'
  - Payment Gateways: '/paymentProviders[id=cod]/enabled' (or mada, apple_pay, credit_card, tabby)
- PREDICATE PATH RESOLUTION:
  You do NOT need to guess numeric array indices! Target array items by ID directly:
  * '/paymentProviders[id=cod]/enabled'
  * '/products[id=prod_001]/price'
  * '/shippingZones[id=zone_sa]/rates[id=rate_std]/price'
  The backend compiler automatically resolves [id=xyz] into the correct array index.
- ARITHMETIC & RELATIVE OPERATIONS:
  When a user asks to increase, decrease, or scale numbers (price, inventory, shipping):
  * Use op: 'increment' with value: N (e.g. increase by 5 SAR -> op: 'increment', value: 5)
  * Use op: 'decrement' with value: N (e.g. decrease stock by 10 -> op: 'decrement', value: 10)
  * Use op: 'percentage' with value: N (e.g. 10% discount -> op: 'percentage', value: -10; 15% increase -> op: 'percentage', value: 15)
  DO NOT guess the final total or set the price directly to the delta amount! The backend calculates it automatically.
- WILDCARD BULK UPDATES:
  Use '[*]' to apply an operation across all items in an array at once:
  * '/products[*]/price' -> updates price for all products in catalog
  * '/products[*]/inventory' -> updates stock for all products
  * '/products[categories=Coffee Beans]/price' -> updates all products in a specific collection
- Store name is "${store.name}", description is "${store.description || "No description set"}".
- Store currency is ${store.currency}, locale is ${store.locale}, current store version is v${store.version}.
- Always provide a clear, concise merchant-facing explanation of what you are changing and why.
- RESPONSE FORMATTING:
  * Structure responses cleanly with concise paragraphs and bullet points for lists.
  * Use bold markdown (**term**) intentionally for key terms, carrier names, or headers. Avoid wrapping punctuation, symbols, or entire sentences in asterisks.

GENERALIZED READ-BEFORE-WRITE RULE (MANDATORY):
- Never guess entity IDs, keys, or current store configuration!
- Whenever the merchant requests modifying an existing entity (products, shipping zones/rates, navigation links, or payment gateways):
  * If the exact entity ID or current state is not explicitly verified, you MUST call 'inspect_store_data' on the relevant slice (e.g., '/products', '/shippingZones', '/navigation') BEFORE proposing mutations.
  * Never invent or assume IDs (e.g., do NOT guess '[id=humus]', '[id=rate_other]', or numeric indices). Always inspect the live store slice first to obtain the authentic ID and current values.

CRITICAL RULES FOR QUESTIONS:
- SCOPE & DOMAIN BOUNDARIES:
  You are Khadoom AI, specialized solely in Mtajir e-commerce store operations and platform features.
  For questions outside Mtajir store management (such as general software engineering, AI model architecture, external RAG setup/maintenance, personal advice, or unrelated third-party systems):
  * Do NOT attempt to invent answers, and NEVER force-fit unrelated Mtajir documentation (such as Tabby installments, Shipping, or Store Versioning) into an answer.
  * Politely inform the merchant that this topic is outside Mtajir store management and documentation scope.
- MANDATORY RETRIEVAL-BEFORE-ANSWER RULE:
  You have zero internal knowledge about Mtajir in your pre-trained weights.
  Whenever the merchant asks ANY question about Mtajir (including platform features, shipping carriers, partner integrations, discounts, promo codes, fees, payment gateways, policies, rules, or system configuration), you MUST call 'search_documentation' BEFORE formulating an answer.
  Never answer from assumption or state you lack information without searching first.
- RELEVANCE & GROUNDING:
  * Carefully evaluate whether the retrieved documentation actually answers the user's specific inquiry.
  * If the retrieved documentation does not answer the question or is not relevant to what the user asked, state clearly that the requested information is not available in Mtajir documentation.
  * When relevant documentation is found, ground your answers strictly on the returned text. Include all specific details, codes, partner names, and step-by-step instructions found in the retrieved documentation.
- General conversational messages (e.g. "hello", "hi", "who are you", "thank you") do NOT require tool calls and can be answered directly.

COMPOUND INSTRUCTIONS (QUESTIONS + MUTATIONS):
- When the merchant asks a question AND requests a store change in the same prompt (e.g., "What is my primary color, change price of humus up by 5"):
  * Always inspect ALL necessary store slices first (e.g., inspect '/theme/colors' for the question, AND inspect '/products' to discover the product ID).
  * Do NOT propose mutations with guessed IDs before verifying the entity in the store data.
  * In your final response, provide a thorough, helpful answer to their question alongside confirming the staged changes.

ROLLBACK & VERSION REVERSIONS:
- Version rollbacks are handled deterministically via CLI commands, NOT through AI patches.
- If the merchant asks to rollback, undo, or revert to a previous version (e.g., "rollback to v1", "revert to version 2", "rollback 16", "undo changes"):
  * Do NOT call 'propose_store_changes' or generate reverse patches.
  * Explicitly instruct the merchant to use the CLI '/rollback <version>' command (e.g., '/rollback 1').
  * Inform them that they can type '/history' to see all previous snapshots and their version numbers.`;
  }

  private getToolDefinitions() {
    return [
      {
        type: "function" as const,
        function: {
          name: "propose_store_changes",
          description:
            "Propose modifications to the store JSON via RFC 6902 JSON Patch operations. CRITICAL: Never guess entity IDs. If modifying existing products, shipping rates, or navigation items, always verify their exact IDs using 'inspect_store_data' first.",
          parameters: {
            type: "object",
            properties: {
              explanation: {
                type: "string",
                description: "Human-readable summary of the intended changes for the merchant",
              },
              patches: {
                type: "array",
                description: "Array of RFC 6902 patch operations",
                items: {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      enum: [
                        "add",
                        "remove",
                        "replace",
                        "increment",
                        "decrement",
                        "percentage",
                        "multiply",
                      ],
                      description:
                        "Operation type. Use 'increment', 'decrement', or 'percentage' for relative adjustments.",
                    },
                    path: { type: "string", description: "JSON path starting with '/'" },
                    value: { description: "The new value or arithmetic delta to set" },
                  },
                  required: ["op", "path"],
                },
              },
            },
            required: ["explanation", "patches"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "search_documentation",
          description:
            "Search Mtajir platform documentation, shipping carriers, partner integrations, discounts, promo codes, feature guides, policies, payment gateways, and FAQs. MANDATORY: Call this tool for ANY question about what Mtajir offers, supports, or integrates with before attempting to answer.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query string" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "inspect_store_data",
          description:
            "Inspect specific slices, settings, or metadata of the merchant's live store (e.g. '/', '/name', '/description', '/products', '/theme', '/shippingZones', '/navigation'). Use this tool to look up live configuration or to verify exact entity IDs and current prices before proposing mutations.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "JSON path to inspect, e.g. '/', '/name', '/description', '/theme', or '/shippingZones'" },
            },
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "navigate_to_settings_page",
          description: "Direct the user to the admin dashboard screen where this feature is managed",
          parameters: {
            type: "object",
            properties: {
              route: { type: "string", description: "Target screen route, e.g. '/settings/payments'" },
              reason: { type: "string", description: "Why the user is being directed here" },
            },
            required: ["route", "reason"],
          },
        },
      },
    ];
  }

  public clearConversation(conversationId: string): void {
    this.sessionMemory.delete(conversationId);
  }

  public getConversationHistory(conversationId: string): CompactTurnMessage[] {
    return [...(this.sessionMemory.get(conversationId) ?? [])];
  }

  private recordConversationTurn(
    conversationId: string,
    userPrompt: string,
    res: AgentResponse,
    maxHistoryTurns = 3
  ): void {
    if (res.type === "error") return;

    let assistantSummary = res.message || "Done.";
    if (res.type === "mutation_staged") {
      assistantSummary = res.answerText
        ? `${res.answerText} [Staged proposal: ${res.message}]`
        : `[Staged proposal: ${res.message}]`;
    } else if (res.type === "navigation") {
      assistantSummary = res.answerText
        ? `${res.answerText} [Navigated to ${res.navigationRoute}]`
        : `[Navigated to ${res.navigationRoute}: ${res.message}]`;
    }

    const existing = this.sessionMemory.get(conversationId) ?? [];
    const updated: CompactTurnMessage[] = [
      ...existing,
      { role: "user", content: truncateForMemory(userPrompt) },
      { role: "assistant", content: truncateForMemory(assistantSummary) },
    ];

    const maxMessages = Math.max(2, maxHistoryTurns * 2);
    const trimmed = updated.slice(-maxMessages);

    // Refresh insertion order for simple LRU capping
    this.sessionMemory.delete(conversationId);
    this.sessionMemory.set(conversationId, trimmed);
    if (this.sessionMemory.size > MAX_MEMORY_SESSIONS) {
      const oldestKey = this.sessionMemory.keys().next().value;
      if (oldestKey) this.sessionMemory.delete(oldestKey);
    }
  }

  async processUserPrompt(
    storeId: string,
    userPrompt: string,
    options?: ProcessPromptOptions
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    const accumulatedUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
    };

    const addUsage = (usage?: OpenAI.Completions.CompletionUsage | null) => {
      if (usage) {
        accumulatedUsage.promptTokens += usage.prompt_tokens ?? 0;
        accumulatedUsage.completionTokens += usage.completion_tokens ?? 0;
        accumulatedUsage.totalTokens += usage.total_tokens ?? 0;
        const cached = (usage.prompt_tokens_details as any)?.cached_tokens ?? 0;
        accumulatedUsage.cachedTokens += cached;
      }
    };

    const finalize = async (
      res: AgentResponse,
      intentType: QueryIntentType,
      toolCalls: string[] = []
    ): Promise<AgentResponse> => {
      const latencyMs = Date.now() - startTime;
      const cost = calculateCost(this.model, accumulatedUsage, { latencyMs });
      const telemetry: AgentTelemetry = {
        latencyMs,
        usage: { ...accumulatedUsage },
        cost,
        model: this.model,
      };

      await this.queryLogger.logQuery({
        id: `query_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: new Date().toISOString(),
        storeId,
        userPrompt,
        model: this.model,
        latencyMs,
        intentType,
        toolCalls,
        retriesCount: res.retryCount ?? 0,
        usage: { ...accumulatedUsage },
        cost,
        status: res.type === "error" ? "error" : "success",
        errorMessage: res.type === "error" ? res.message : undefined,
      });

      if (options?.conversationId) {
        this.recordConversationTurn(
          options.conversationId,
          userPrompt,
          res,
          options.maxHistoryTurns ?? 3
        );
      }

      return {
        ...res,
        telemetry,
      };
    };

    const store = await this.repository.getStore(storeId);
    if (!store) {
      return await finalize(
        {
          type: "error",
          message: `Store '${storeId}' was not found. Please create or load a store first.`,
        },
        "error"
      );
    }

    const storeConstraints = {
      currency: store.currency,
      locale: store.locale,
      country: store.shippingZones?.[0]?.countries?.[0],
    };

    const priorHistory = options?.conversationId
      ? this.sessionMemory.get(options.conversationId) ?? []
      : [];
    const looksLikeContextualFollowUp =
      priorHistory.length > 0 &&
      (userPrompt.trim().split(/\s+/).length <= 3 ||
        /\b(?:it|its|that|this|those|them|one|first|second|same)\b/i.test(userPrompt));

    // 1. Context-Scoped Semantic Cache check for Q&A (skip short follow-ups with active memory)
    const cachedEntry = looksLikeContextualFollowUp
      ? undefined
      : await this.docsService.getCachedEntry(userPrompt, storeConstraints);
    if (cachedEntry) {
      return await finalize(
        {
          type: "answer",
          message: cachedEntry.answer,
          citations:
            cachedEntry.citations.length > 0
              ? cachedEntry.citations
              : ["Semantic Cache (Mtajir Docs)"],
        },
        "doc_question"
      );
    }

    // 2. Direct Rollback command guidance check
    const rollbackMatch = userPrompt
      .trim()
      .match(/^(?:can\s+you\s+)?(?:please\s+)?(?:rollback|revert|undo)(?:\s+(?:the\s+)?(?:store\s+)?(?:to\s+)?)?(?:v(?:ersion)?\s*)?(\d+)?$/i);
    if (rollbackMatch) {
      const targetVer = rollbackMatch[1] ? rollbackMatch[1] : "<version_number>";
      return await finalize(
        {
          type: "answer",
          message: `To safely restore a previous store snapshot, please use the CLI command: '/rollback ${targetVer}' (e.g., '/rollback ${targetVer}'). You can also view all past snapshots and changelogs by typing '/history'.`,
        },
        "conversation"
      );
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: this.getSystemPrompt(store) },
      ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userPrompt },
    ];

    try {
      let turns = 0;
      const maxTurns = 6;
      const executedTools: string[] = [];
      const citations: string[] = [];
      let activeStagedMutation: AgentResponse | null = null;
      let cumulativePatches: JsonPatchOperation[] = [];
      const cumulativeExplanations: string[] = [];
      let activeNavigation: { route: string; reason: string } | null = null;

      while (turns < maxTurns) {
        turns++;

        const response = await this.createChatCompletion(messages, "auto");

        addUsage(response.usage);

        const choice = response.choices[0];
        const message = choice.message;
        const cleanContent = message.content ? stripThinkingBlocks(message.content) : null;
        messages.push(message);

        // If no tool calls, model gave its final conversational reply
        if (!message.tool_calls || message.tool_calls.length === 0) {
          if (activeStagedMutation && activeStagedMutation.type === "mutation_staged") {
            return await finalize(
              {
                ...activeStagedMutation,
                answerText: cleanContent || undefined,
                citations: citations.length > 0 ? citations : undefined,
              },
              "mutation",
              executedTools
            );
          }

          if (activeStagedMutation && activeStagedMutation.type === "answer") {
            return await finalize(
              {
                type: "answer",
                message: cleanContent || activeStagedMutation.message,
                citations: citations.length > 0 ? citations : undefined,
              },
              "conversation",
              executedTools
            );
          }

          if (activeStagedMutation && activeStagedMutation.type === "error") {
            return await finalize(
              {
                type: "error",
                message: cleanContent || activeStagedMutation.message,
                citations: citations.length > 0 ? citations : undefined,
              },
              "error",
              executedTools
            );
          }

          if (activeNavigation) {
            return await finalize(
              {
                type: "navigation",
                navigationRoute: activeNavigation.route,
                message: activeNavigation.reason,
                answerText: cleanContent || undefined,
                citations: citations.length > 0 ? citations : undefined,
              },
              "navigation",
              executedTools
            );
          }

          const isNegativeOrOutOfScope =
            /outside (?:the )?scope|not (?:available|covered|found) in Mtajir|no (?:matching )?documentation/i.test(
              cleanContent || ""
            );
          const effectiveCitations = isNegativeOrOutOfScope ? [] : citations;

          const usedInspectTool = executedTools.includes("inspect_store_data");
          const usedMutationOrNavTool =
            executedTools.includes("propose_store_changes") ||
            executedTools.includes("navigate_to_settings_page");
          const mentionsTenantIdentity =
            store.name.trim().length > 2 &&
            (cleanContent || "").toLowerCase().includes(store.name.trim().toLowerCase());

          const finalIntent: QueryIntentType = usedInspectTool
            ? "store_inspection"
            : effectiveCitations.length > 0
            ? "doc_question"
            : executedTools.includes("navigate_to_settings_page")
            ? "navigation"
            : "conversation";

          // Never write tenant/store-specific state into the shared SemanticCache (C3)
          const isPureDocsAnswer =
            effectiveCitations.length > 0 &&
            Boolean(cleanContent) &&
            !activeStagedMutation &&
            !usedInspectTool &&
            !usedMutationOrNavTool &&
            !mentionsTenantIdentity;

          if (isPureDocsAnswer && cleanContent) {
            await this.docsService.setCachedAnswer(
              userPrompt,
              cleanContent,
              effectiveCitations,
              storeConstraints
            );
          }

          return await finalize(
            {
              type: "answer",
              message: cleanContent || "Done.",
              citations: effectiveCitations.length > 0 ? effectiveCitations : undefined,
            },
            finalIntent,
            executedTools
          );
        }

        // Process all tool calls in the message, responding to each tool_call_id
        for (const toolCall of message.tool_calls) {
          const fnName = toolCall.function.name;
          executedTools.push(fnName);
          const parsedArgs = parseToolArguments(toolCall.function.arguments);
          if (!parsedArgs.ok) {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "error",
                message: `Invalid JSON arguments for tool '${fnName}': ${parsedArgs.error}. Please emit valid JSON matching the tool schema.`,
              }),
            });
            continue;
          }
          const args = parsedArgs.value;

          if (fnName === "propose_store_changes") {
            const incomingPatches: JsonPatchOperation[] = Array.isArray(args.patches)
              ? args.patches
              : [];
            const prevSessionId = activeStagedMutation?.stagingSession?.sessionId;
            const mergedPatches =
              cumulativePatches.length > 0
                ? [...cumulativePatches, ...incomingPatches]
                : incomingPatches;
            const explanationText =
              typeof args.explanation === "string"
                ? stripThinkingBlocks(args.explanation)
                : "";
            const mergedExplanation =
              cumulativeExplanations.length > 0
                ? [...cumulativeExplanations, explanationText].filter(Boolean).join("; ")
                : explanationText;

            // Snapshot transcript prior to the current tool-call assistant turn so retries keep
            // all earlier `inspect_store_data` and `search_documentation` context (H5).
            const priorContext = messages.slice(0, -1);

            const mutationRes = await this.handleMutationWithSelfCorrection(
              storeId,
              store.version,
              mergedExplanation,
              mergedPatches,
              userPrompt,
              store,
              addUsage,
              priorContext
            );

            if (mutationRes.type === "mutation_staged" && mutationRes.stagingSession) {
              if (prevSessionId && prevSessionId !== mutationRes.stagingSession.sessionId) {
                this.stagingService.rejectSession(prevSessionId);
              }
              cumulativePatches = [...mutationRes.stagingSession.patches];
              if (args.explanation) cumulativeExplanations.push(args.explanation);
            }
            activeStagedMutation = mutationRes;

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status:
                  mutationRes.type === "mutation_staged"
                    ? "staged_successfully"
                    : mutationRes.type === "answer"
                    ? "no_op"
                    : "error",
                message: mutationRes.message,
              }),
            });
          } else if (fnName === "search_documentation") {
            const results = await this.docsService.searchDocsAsync(args.query, {
              ...storeConstraints,
              limit: 5,
            });
            results.forEach((r) => {
              if (!citations.includes(r.title)) citations.push(r.title);
            });
            const docContext = results
              .map((r) => `[${r.title} — ${r.sectionHeader}]: ${r.content}`)
              .join("\n\n");

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: docContext.length > 0 ? docContext : "No matching documentation found.",
            });
          } else if (fnName === "inspect_store_data") {
            const slicePath = args.path || "/";
            const dataSlice = slicePath === "/" ? store : this.getValueAtPath(store, slicePath);

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(dataSlice ?? "Not found", null, 2),
            });
          } else if (fnName === "navigate_to_settings_page") {
            activeNavigation = { route: args.route, reason: args.reason };
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Navigated merchant to ${args.route}.`,
            });
          } else {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Tool '${fnName}' executed.`,
            });
          }
        }
      }

      if (activeStagedMutation && activeStagedMutation.type === "mutation_staged") {
        return await finalize(
          {
            ...activeStagedMutation,
            citations: citations.length > 0 ? citations : undefined,
          },
          "mutation",
          executedTools
        );
      }

      if (activeStagedMutation && activeStagedMutation.type === "answer") {
        return await finalize(
          {
            type: "answer",
            message: activeStagedMutation.message,
            citations: citations.length > 0 ? citations : undefined,
          },
          "conversation",
          executedTools
        );
      }

      if (activeNavigation) {
        return await finalize(
          {
            type: "navigation",
            navigationRoute: activeNavigation.route,
            message: activeNavigation.reason,
            citations: citations.length > 0 ? citations : undefined,
          },
          "navigation",
          executedTools
        );
      }

      return await finalize(
        {
          type: "answer",
          message: "Request completed with tool operations.",
          citations: citations.length > 0 ? citations : undefined,
        },
        "conversation",
        executedTools
      );
    } catch (err: any) {
      return await finalize(
        {
          type: "error",
          message: `Agent processing error: ${err.message}`,
        },
        "error"
      );
    }
  }

  /**
   * Self-Correction Loop for Store Mutations:
   * Validates staged patches with Zod. If validation fails, feeds exact Zod issue paths
   * and messages back to gpt-4o-mini to synthesize a corrected patch.
   */
  private async handleMutationWithSelfCorrection(
    storeId: string,
    baseVersion: number,
    initialExplanation: string,
    initialPatches: JsonPatchOperation[],
    originalPrompt: string,
    storeSnapshot: MtajirStore,
    addUsage: (usage?: OpenAI.Completions.CompletionUsage | null) => void,
    priorContext?: OpenAI.Chat.ChatCompletionMessageParam[],
    maxRetries = 3
  ): Promise<AgentResponse> {
    let currentPatches = initialPatches;
    let currentExplanation = initialExplanation;
    let attempts = 0;

    // Seed correction thread with inspected store slices & RAG context instead of starting blind (H5).
    const correctionMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
      priorContext && priorContext.length > 0
        ? [...priorContext]
        : [
            { role: "system", content: this.getSystemPrompt(storeSnapshot) },
            { role: "user", content: originalPrompt },
          ];

    while (attempts <= maxRetries) {
      const stageResult = await this.stagingService.stageMutation(
        storeId,
        baseVersion,
        currentExplanation,
        currentPatches
      );

      if (stageResult.success) {
        return {
          type: "mutation_staged",
          message: currentExplanation,
          stagingSession: stageResult.session,
          retryCount: attempts,
        };
      }

      if (stageResult.errorType === "NO_OP") {
        return {
          type: "answer",
          message: stageResult.errorMessage,
        };
      }

      // Version mismatch cannot be fixed by rewriting JSON patches — fail fast without burning retries (H5).
      if (stageResult.errorType === "CONCURRENCY_CONFLICT") {
        return {
          type: "error",
          message: stageResult.errorMessage,
        };
      }

      attempts++;
      if (attempts > maxRetries) {
        return {
          type: "error",
          message: `Mutation failed validation after ${maxRetries} self-correction attempts: ${stageResult.errorMessage}`,
        };
      }

      // Prompt model to correct the specific errors
      const errorDetails = stageResult.zodIssues
        ? stageResult.zodIssues
            .map((issue) => `- Path: /${issue.path.join("/")} | Issue: ${issue.message}`)
            .join("\n")
        : stageResult.errorMessage;

      const correctionPrompt = `The previous RFC 6902 patch failed validation:
Error details:
${errorDetails}

Failed patches:
${JSON.stringify(currentPatches, null, 2)}

Original user request: "${originalPrompt}"

Inspect live store slices with 'inspect_store_data' if any entity ID is missing or invalid, then call 'propose_store_changes' with a corrected patch.`;

      correctionMessages.push({ role: "user", content: correctionPrompt });

      // Allow inspect_store_data up to 2 inner steps before forcing propose_store_changes
      let fixedArgs: { explanation?: string; patches: JsonPatchOperation[] } | null = null;
      for (let step = 0; step < 3; step++) {
        const forceProposal = step === 2;
        const correctionResponse = await this.createChatCompletion(
          correctionMessages,
          forceProposal
            ? { type: "function", function: { name: "propose_store_changes" } }
            : "auto"
        );

        addUsage(correctionResponse.usage);

        const assistantMsg = correctionResponse.choices[0]?.message;
        if (!assistantMsg) break;
        correctionMessages.push(assistantMsg);

        const toolCall = assistantMsg.tool_calls?.[0];
        if (!toolCall) break;

        const parsedToolArgs = parseToolArguments(toolCall.function.arguments);
        if (!parsedToolArgs.ok) {
          correctionMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Invalid JSON arguments for '${toolCall.function.name}': ${parsedToolArgs.error}. Re-emit valid JSON matching the schema.`,
          });
          continue;
        }

        if (toolCall.function.name === "propose_store_changes") {
          fixedArgs = parsedToolArgs.value as {
            explanation?: string;
            patches: JsonPatchOperation[];
          };
          correctionMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Received replacement patch for validation.",
          });
          break;
        }

        if (toolCall.function.name === "inspect_store_data") {
          const slicePath = parsedToolArgs.value.path || "/";
          const dataSlice = slicePath === "/" ? storeSnapshot : this.getValueAtPath(storeSnapshot, slicePath);
          correctionMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(dataSlice ?? "Not found", null, 2),
          });
        } else {
          correctionMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Use 'inspect_store_data' or 'propose_store_changes' to repair the patch.",
          });
        }
      }

      if (!fixedArgs || !Array.isArray(fixedArgs.patches)) {
        return {
          type: "error",
          message: "Self-correction failed: model did not return a replacement patch.",
        };
      }

      currentPatches = fixedArgs.patches;
      currentExplanation = fixedArgs.explanation || currentExplanation;
    }

    return {
      type: "error",
      message: "Exceeded maximum self-correction retry attempts.",
    };
  }

  private getValueAtPath(obj: any, path: string): any {
    try {
      const compiled = compilePredicatePath(obj, path);
      return getCompiledValue(obj, compiled);
    } catch {
      const normalizedPath = path.replace(/^\/store(?=\/|$)/i, "");
      const parts = normalizedPath.split("/").filter(Boolean);
      if (parts.length === 0) return obj;
      let curr = obj;
      for (const part of parts) {
        if (curr === undefined || curr === null) return undefined;
        curr = curr[part];
      }
      return curr;
    }
  }
}
