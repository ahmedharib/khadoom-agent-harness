import dotenv from "dotenv";
import { DocsService } from "./docs.service.js";

dotenv.config({ override: true });

async function run() {
  console.log("Checking documentation corpus & chunk embeddings...");
  const docsService = new DocsService();
  const stats = await docsService.syncCorpusAndEmbeddings();

  if (stats.newChunks === 0) {
    console.log(
      `Documentation unchanged (Corpus Hash: ${stats.corpusHash.slice(0, 8)}...).`
    );
    console.log(
      `All ${stats.totalChunks} chunks verified and loaded from disk cache (${stats.cachedChunks} cached, 0 OpenAI API calls made).`
    );
  } else {
    console.log(
      `Synced ${stats.totalChunks} chunks: ${stats.newChunks} new/updated chunks embedded via OpenAI text-embedding-3-small (${stats.cachedChunks} loaded from cache).`
    );
    console.log(`Corpus Hash: ${stats.corpusHash}`);
  }
  console.log("Embeddings store ready: data/embeddings/doc-embeddings.json");
}

run().catch((err) => {
  console.error("Embedding sync failed:", err);
  process.exit(1);
});
