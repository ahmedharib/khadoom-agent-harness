import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIST = path.resolve(__dirname, "../ui/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};
import { StoreRepository } from "./storage/store.repository.js";
import { StagingService } from "./staging/staging.service.js";
import { QueryLoggerService } from "./telemetry/query-logger.js";
import { ProviderRouter, type ModelPairId } from "./routing/provider-router.js";
import { type RerankerMode } from "./rag/docs.service.js";
import { SEED_STORE } from "./data/seed-store.js";

dotenv.config({ override: true });

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
const HOST = process.env.HOST || "127.0.0.1";
const storeId = SEED_STORE.id;

const repository = new StoreRepository();
const stagingService = new StagingService(repository);
const queryLogger = new QueryLoggerService();
const router = new ProviderRouter({ repository, stagingService, queryLogger });

// Helper to set CORS and JSON headers
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// Helper to parse JSON body
function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // 1. GET /api/store - Get current store state & changelog
    if (req.method === "GET" && pathname === "/api/store") {
      let store = await repository.getStore(storeId);
      if (!store) {
        store = await repository.saveInitialStore(SEED_STORE);
      }
      const changelog = await repository.getChangelog(storeId);
      const telemetry = await queryLogger.getSummary(storeId);
      return sendJson(res, 200, {
        store,
        changelog,
        telemetry,
        modelConfig: router.getActiveAgent().getModelConfig(),
        routerState: router.getRouterState(),
      });
    }

    // 1b. GET /api/providers - Inspect available LLM/Embeddings pairs, rerankers, and VectorDB status
    if (req.method === "GET" && pathname === "/api/providers") {
      return sendJson(res, 200, router.getRouterState());
    }

    // 1c. POST /api/providers/refresh - Re-probe local/Qdrant/commercial endpoints
    if (req.method === "POST" && pathname === "/api/providers/refresh") {
      const routerState = await router.refreshStatus();
      return sendJson(res, 200, {
        routerState,
        modelConfig: router.getActiveAgent().getModelConfig(),
      });
    }

    // 1d. POST /api/providers/select - Switch active Model+Embeddings pair and/or Reranker
    if (req.method === "POST" && pathname === "/api/providers/select") {
      const body = await parseJsonBody(req);
      const modelPair = body.modelPair as ModelPairId | undefined;
      const reranker = body.reranker as RerankerMode | undefined;
      try {
        const routerState = await router.setSelection({ modelPair, reranker });
        return sendJson(res, 200, {
          routerState,
          modelConfig: router.getActiveAgent().getModelConfig(),
        });
      } catch (err: any) {
        return sendJson(res, 400, {
          error: err?.message || "Cannot switch provider selection",
          routerState: router.getRouterState(),
        });
      }
    }

    const executeAgentTurn = async (
      promptText: string,
      opts: {
        conversationId?: unknown;
        requireMutationProposal?: boolean;
        stream?: unknown;
        afterTurn?: (turnResult: { type: string }) => void;
      }
    ) => {
      const wantsStream =
        opts.stream === true || Boolean(req.headers.accept?.includes("text/event-stream"));
      const convId =
        typeof opts.conversationId === "string" && opts.conversationId ? opts.conversationId : undefined;

      const writeSse = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
      }

      try {
        const turnResult = await router.getActiveAgent().processUserPrompt(storeId, promptText, {
          conversationId: convId,
          requireMutationProposal: opts.requireMutationProposal,
          onStep: wantsStream ? (step) => writeSse("step", step) : undefined,
        });
        opts.afterTurn?.(turnResult);
        const currentStore = await repository.getStore(storeId);
        const changelog = await repository.getChangelog(storeId);
        const telemetry = await queryLogger.getSummary(storeId);
        const payload = {
          ...turnResult,
          turnTelemetry: turnResult.telemetry,
          currentStore,
          changelog,
          telemetry,
        };
        if (wantsStream) {
          writeSse("done", payload);
          res.end();
          return;
        }
        return sendJson(res, 200, payload);
      } catch (err: any) {
        if (wantsStream) {
          writeSse("error", { error: err?.message || "Agent turn failed" });
          res.end();
          return;
        }
        throw err;
      }
    };

    // 2. POST /api/chat - Send merchant prompt to Khadoom
    if (req.method === "POST" && pathname === "/api/chat") {
      const body = await parseJsonBody(req);
      const { prompt, conversationId, stream } = body;
      if (!prompt || typeof prompt !== "string") {
        return sendJson(res, 400, { error: "prompt is required" });
      }

      return await executeAgentTurn(prompt.trim(), {
        conversationId,
        stream,
      });
    }

    // 3. POST /api/staging/accept - Accept & commit staged mutation
    if (req.method === "POST" && pathname === "/api/staging/accept") {
      const body = await parseJsonBody(req);
      const { sessionId } = body;
      if (!sessionId) {
        return sendJson(res, 400, { error: "sessionId is required" });
      }

      try {
        const committedStore = await stagingService.commitSession(sessionId);
        const changelog = await repository.getChangelog(storeId);
        return sendJson(res, 200, {
          success: true,
          store: committedStore,
          changelog,
        });
      } catch (commitErr: any) {
        if (commitErr.code === "CONCURRENCY_CONFLICT") {
          return sendJson(res, 409, { error: commitErr.message, code: "CONCURRENCY_CONFLICT" });
        }
        throw commitErr;
      }
    }

    // 4. POST /api/staging/reject - Reject staged mutation
    if (req.method === "POST" && pathname === "/api/staging/reject") {
      const body = await parseJsonBody(req);
      const { sessionId } = body;
      if (!sessionId) {
        return sendJson(res, 400, { error: "sessionId is required" });
      }

      stagingService.rejectSession(sessionId);
      return sendJson(res, 200, { success: true });
    }

    // 5. POST /api/staging/modify - Tweak staged mutation with feedback
    if (req.method === "POST" && pathname === "/api/staging/modify") {
      const body = await parseJsonBody(req);
      const { sessionId, feedback, conversationId, stream } = body;
      if (!sessionId || !feedback) {
        return sendJson(res, 400, { error: "sessionId and feedback are required" });
      }

      const session = stagingService.getSession(sessionId);

      const modifyPrompt = session
        ? `Modify the previous staged proposal "${session.explanation}" (previous patches: ${JSON.stringify(
            session.patches
          )}) using this merchant feedback: "${feedback}". Preserve any unchanged parts of the proposal and call 'propose_store_changes' with the complete updated patch list.`
        : feedback;

      return await executeAgentTurn(modifyPrompt, {
        conversationId,
        requireMutationProposal: true,
        stream,
        afterTurn: (turnResult) => {
          if (turnResult.type === "mutation_staged") {
            stagingService.rejectSession(sessionId);
          }
        },
      });
    }

    // 6. POST /api/store/rollback - Rollback store to specific version
    if (req.method === "POST" && pathname === "/api/store/rollback") {
      const body = await parseJsonBody(req);
      const { version } = body;
      if (typeof version !== "number") {
        return sendJson(res, 400, { error: "version (number) is required" });
      }

      const rolledBackStore = await repository.rollbackToVersion(storeId, version);
      const changelog = await repository.getChangelog(storeId);
      return sendJson(res, 200, {
        success: true,
        store: rolledBackStore,
        changelog,
      });
    }

    // 7. POST /api/store/reset - Reset store back to seed v1
    if (req.method === "POST" && pathname === "/api/store/reset") {
      const body = await parseJsonBody(req).catch(() => ({}));
      if (typeof body?.conversationId === "string" && body.conversationId) {
        router.getActiveAgent().clearConversation(body.conversationId);
      }
      const resetStore = await repository.saveInitialStore(SEED_STORE);
      const changelog = await repository.getChangelog(storeId);
      return sendJson(res, 200, {
        success: true,
        store: resetStore,
        changelog,
      });
    }

    // 8. GET /api/telemetry - Token and cost stats
    if (req.method === "GET" && pathname === "/api/telemetry") {
      const telemetry = await queryLogger.getSummary(storeId);
      return sendJson(res, 200, telemetry);
    }

    // 9. Static UI asset serving & SPA fallback
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      const sanitized = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
      let filePath = path.join(UI_DIST, sanitized === "/" || sanitized === "\\" ? "index.html" : sanitized);
      try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
          filePath = path.join(filePath, "index.html");
        }
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        });
        return res.end(data);
      } catch {
        try {
          const indexHtml = await fs.readFile(path.join(UI_DIST, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(indexHtml);
        } catch {
          return sendJson(res, 404, { error: "UI build not found. Run 'npm run build' in ui/ directory." });
        }
      }
    }

    return sendJson(res, 404, { error: "Not Found" });
  } catch (err: any) {
    console.error("[Server Error]", err);
    return sendJson(res, 500, { error: err.message || "Internal Server Error" });
  }
});

async function start() {
  console.log("[Khadoom API] Initializing Provider Router, VectorDB/RAG & Store Repository...");
  const routerState = await router.initialize();

  let store = await repository.getStore(storeId);
  if (!store) {
    store = await repository.saveInitialStore(SEED_STORE);
  }

  const llmInfo = router.getActiveAgent().getModelConfig();

  server.listen(PORT, HOST, () => {
    console.log(`\n==================================================`);
    console.log(`  KHADOOM API SERVER READY: http://${HOST}:${PORT}`);
    console.log(`  Active Pair: ${routerState.selectedPair} (${llmInfo.model})`);
    console.log(`  Reranker:    ${routerState.selectedReranker}`);
    console.log(`  VectorDB:    ${routerState.vectorDb.mode} (${routerState.vectorDb.activeCollection})`);
    console.log(`  Store:       ${store.name} (v${store.version})`);
    console.log(`==================================================\n`);
  });
}

start().catch((err) => {
  console.error("[Fatal Init Error]", err);
  process.exit(1);
});
