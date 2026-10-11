import OpenAI from "openai";
import { StoreRepository } from "../storage/store.repository.js";
import { StagingService, StagingSession } from "../staging/staging.service.js";
import { DocsService } from "../rag/docs.service.js";
import { JsonPatchOperation } from "../schema/patch.schema.js";
import { MtajirStore } from "../schema/store.schema.js";
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

export class KhadoomAgent {
  private openai: OpenAI;
  private repository: StoreRepository;
  private stagingService: StagingService;
  private docsService: DocsService;
  private queryLogger: QueryLoggerService;
  private model: string;

  constructor(
    repository: StoreRepository,
    stagingService: StagingService,
    docsService: DocsService,
    queryLogger = new QueryLoggerService(),
    apiKey?: string,
    model = "gpt-4o-mini"
  ) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY || "dummy_key_for_mock",
    });
    this.repository = repository;
    this.stagingService = stagingService;
    this.docsService = docsService;
    this.queryLogger = queryLogger;
    this.model = model;
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
- Store currency is ${store.currency}, locale is ${store.locale}, current store version is v${store.version}.
- Always provide a clear, concise merchant-facing explanation of what you are changing and why.

CRITICAL RULES FOR QUESTIONS:
- Ground your answers strictly on Mtajir documentation or store data.
- If information is not in the documentation or store data, politely state that you do not have that information rather than guessing.

COMPOUND INSTRUCTIONS (QUESTIONS + MUTATIONS):
- When the merchant asks a question AND requests a store change in the same prompt (e.g., "What is Mada and enable COD?"):
  * Call both appropriate tools (such as 'search_documentation' or 'inspect_store_data', AND 'propose_store_changes').
  * In your final response, provide a thorough, helpful answer to their question alongside confirming the staged changes.`;
  }

  private getToolDefinitions() {
    return [
      {
        type: "function" as const,
        function: {
          name: "propose_store_changes",
          description: "Propose modifications to the store JSON via RFC 6902 JSON Patch operations",
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
          description: "Search Mtajir platform documentation and feature guides",
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
          description: "Inspect specific slices or settings of the merchant's live store",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "JSON path to inspect, e.g. '/theme' or '/shippingZones'" },
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

  async processUserPrompt(storeId: string, userPrompt: string): Promise<AgentResponse> {
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
      const cost = calculateCost(this.model, accumulatedUsage);
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

    // 1. Semantic Cache check for Q&A
    const cached = this.docsService.getCachedAnswer(userPrompt);
    if (cached) {
      return await finalize(
        {
          type: "answer",
          message: cached,
          citations: ["Semantic Cache (Mtajir Docs)"],
        },
        "doc_question"
      );
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: this.getSystemPrompt(store) },
      { role: "user", content: userPrompt },
    ];

    try {
      let turns = 0;
      const maxTurns = 6;
      const executedTools: string[] = [];
      const citations: string[] = [];
      let activeStagedMutation: AgentResponse | null = null;
      let activeNavigation: { route: string; reason: string } | null = null;

      while (turns < maxTurns) {
        turns++;

        const response = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          tools: this.getToolDefinitions(),
          parallel_tool_calls: false,
          tool_choice: "auto",
          temperature: 0.1,
        });

        addUsage(response.usage);

        const choice = response.choices[0];
        const message = choice.message;
        messages.push(message);

        // If no tool calls, model gave its final conversational reply
        if (!message.tool_calls || message.tool_calls.length === 0) {
          if (activeStagedMutation && activeStagedMutation.type === "mutation_staged") {
            return await finalize(
              {
                ...activeStagedMutation,
                answerText: message.content || undefined,
                citations: citations.length > 0 ? citations : undefined,
              },
              "mutation",
              executedTools
            );
          }

          if (activeStagedMutation && activeStagedMutation.type === "error") {
            return await finalize(
              {
                type: "error",
                message: message.content || activeStagedMutation.message,
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
                answerText: message.content || undefined,
                citations: citations.length > 0 ? citations : undefined,
              },
              "navigation",
              executedTools
            );
          }

          const finalIntent: QueryIntentType =
            citations.length > 0
              ? "doc_question"
              : executedTools.includes("inspect_store_data")
              ? "store_inspection"
              : executedTools.includes("navigate_to_settings_page")
              ? "navigation"
              : "conversation";

          if (citations.length > 0 && message.content) {
            this.docsService.setCachedAnswer(userPrompt, message.content);
          }

          return await finalize(
            {
              type: "answer",
              message: message.content || "Done.",
              citations: citations.length > 0 ? citations : undefined,
            },
            finalIntent,
            executedTools
          );
        }

        // Process all tool calls in the message, responding to each tool_call_id
        for (const toolCall of message.tool_calls) {
          const fnName = toolCall.function.name;
          executedTools.push(fnName);
          const args = JSON.parse(toolCall.function.arguments);

          if (fnName === "propose_store_changes") {
            const mutationRes = await this.handleMutationWithSelfCorrection(
              storeId,
              store.version,
              args.explanation,
              args.patches,
              userPrompt,
              store,
              addUsage
            );
            activeStagedMutation = mutationRes;

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: mutationRes.type === "mutation_staged" ? "staged_successfully" : "error",
                message: mutationRes.message,
              }),
            });
          } else if (fnName === "search_documentation") {
            const results = this.docsService.searchDocs(args.query);
            results.forEach((r) => {
              if (!citations.includes(r.title)) citations.push(r.title);
            });
            const docContext = results.map((r) => `[${r.title}]: ${r.content}`).join("\n\n");

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
    maxRetries = 3
  ): Promise<AgentResponse> {
    let currentPatches = initialPatches;
    let currentExplanation = initialExplanation;
    let attempts = 0;

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

      const correctionPrompt = `The previous RFC 6902 patch failed schema validation:
Error details:
${errorDetails}

Failed patches:
${JSON.stringify(currentPatches, null, 2)}

Original user request: "${originalPrompt}"

Please output a corrected RFC 6902 patch that satisfies the schema constraints and fixes the above errors.`;

      const correctionResponse = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: this.getSystemPrompt(storeSnapshot) },
          { role: "user", content: correctionPrompt },
        ],
        tools: this.getToolDefinitions(),
        tool_choice: { type: "function", function: { name: "propose_store_changes" } },
        parallel_tool_calls: false,
        temperature: 0.1,
      });

      addUsage(correctionResponse.usage);

      const toolCall = correctionResponse.choices[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        return {
          type: "error",
          message: "Self-correction failed: model did not return a replacement patch.",
        };
      }

      const args = JSON.parse(toolCall.function.arguments);
      currentPatches = args.patches;
      currentExplanation = args.explanation || currentExplanation;
    }

    return {
      type: "error",
      message: "Exceeded maximum self-correction retry attempts.",
    };
  }

  private getValueAtPath(obj: any, path: string): any {
    const parts = path.split("/").filter(Boolean);
    let curr = obj;
    for (const part of parts) {
      if (curr === undefined || curr === null) return undefined;
      curr = curr[part];
    }
    return curr;
  }
}
