import dotenv from "dotenv";
import { loadDocumentationCorpus } from "./doc-loader.js";
import {
  EmbeddingsService,
  FileEmbeddingsStore,
  resolveDefaultEmbeddingsPath,
  type EmbeddingsProfile,
} from "./embeddings.js";
import { QdrantEmbeddingsStore } from "./qdrant-store.js";

dotenv.config({ override: true });

function hasUsableKey(val?: string): boolean {
  const k = val?.trim();
  return Boolean(k && !k.startsWith("your_") && k !== "dummy_key_for_mock");
}

async function syncProfile(
  profile: EmbeddingsProfile,
  options: {
    model: string;
    baseURL?: string;
    apiKey: string;
    qdrantUrl?: string;
    qdrantActive: boolean;
  }
) {
  const { chunks, corpusHash } = await loadDocumentationCorpus();
  const fileStore = new FileEmbeddingsStore(resolveDefaultEmbeddingsPath(profile));
  const fileService = new EmbeddingsService({
    store: fileStore,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
  });

  console.log(`\n[${profile.toUpperCase()}] Syncing '${options.model}' embeddings (${chunks.length} chunks)...`);
  const fileResult = await fileService.syncCorpusEmbeddings(chunks, corpusHash);

  if (fileResult.newChunks === 0) {
    console.log(
      `  File store up-to-date (${fileResult.totalChunks} cached, 0 API calls).`
    );
  } else {
    console.log(
      `  Embedded ${fileResult.newChunks} new/updated chunks (${fileResult.cachedChunks} cached).`
    );
  }

  if (options.qdrantActive) {
    const collectionName = profile === "local" ? "khadoom_docs_qwen" : "khadoom_docs_openai";
    const qdrantStore = new QdrantEmbeddingsStore({
      url: options.qdrantUrl,
      collectionName,
    });
    qdrantStore.setChunks(chunks);
    const first = fileResult.embeddings.values().next().value;
    await qdrantStore.saveEmbeddings(
      fileResult.embeddings,
      corpusHash,
      {
        model: fileService.getEffectiveModelId(),
        dimensions: first?.vector?.length,
      },
      chunks
    );
    console.log(`  Mirrored ${fileResult.totalChunks} vectors into Qdrant collection '${collectionName}'.`);
  }
}

async function run() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] || "auto";

  const qdrantUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
  const qdrantActive = await QdrantEmbeddingsStore.isReachable(qdrantUrl);
  console.log(`VectorDB (Qdrant @ ${qdrantUrl}): ${qdrantActive ? "ONLINE" : "OFFLINE (saving to disk JSON only)"}`);

  const hasOpenAI = hasUsableKey(process.env.OPENAI_API_KEY);
  const hasLocalEmbed = Boolean(process.env.EMBEDDING_BASE_URL?.trim());

  let syncedAny = false;

  if ((targetArg === "auto" || targetArg === "commercial") && hasOpenAI) {
    await syncProfile("commercial", {
      model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      apiKey: process.env.OPENAI_API_KEY!,
      qdrantUrl,
      qdrantActive,
    });
    syncedAny = true;
  }

  if ((targetArg === "auto" || targetArg === "local") && hasLocalEmbed) {
    await syncProfile("local", {
      model: process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-0.6B",
      baseURL: process.env.EMBEDDING_BASE_URL,
      apiKey: process.env.EMBEDDING_API_KEY || "not-needed",
      qdrantUrl,
      qdrantActive,
    });
    syncedAny = true;
  }

  if (!syncedAny) {
    console.error(
      "\nNo active embedding provider configured in .env.\n" +
        " - For Commercial (OpenAI): set OPENAI_API_KEY=sk-...\n" +
        " - For Local (Qwen): set EMBEDDING_BASE_URL=https://.../v1 and EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B"
    );
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Embedding sync failed:", err);
  process.exit(1);
});
