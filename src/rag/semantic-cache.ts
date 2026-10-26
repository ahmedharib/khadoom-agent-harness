import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { cosineSimilarity, EmbeddingsService } from "./embeddings.js";
import { StoreConstraintContext } from "./constraint-filter.js";
import { tokenizeToWordForms } from "./bm25-search.js";

export interface CachedDocAnswer {
  answer: string;
  citations: string[];
  similarity: number;
  hitType: "exact" | "semantic";
}

interface SemanticCacheEntry {
  canonicalQuery: string;
  queryVector: number[];
  answer: string;
  citations: string[];
  contextScope: string;
  corpusHash: string;
  createdAt: number;
}

export interface SemanticCacheOptions {
  corpusHash?: string;
  /**
   * Minimum cosine similarity for a semantic hit. Calibrated against text-embedding-3-small:
   * true paraphrases score 0.68–0.96 while meaning-flipping near-misses ("enable Tabby" vs
   * "disable Tabby", "primary" vs "secondary color") score up to 0.88, so cosine alone cannot
   * separate them. The lexical guard does the real filtering; this threshold is a sanity check.
   */
  similarityThreshold?: number;
  /** Optional JSON file path so the cache survives process restarts (CLI). In-memory when omitted. */
  persistPath?: string;
}

const QUESTION_STARTERS = new Set([
  "how", "what", "whats", "what's", "why", "where", "which", "who", "when",
  "can", "could", "does", "do", "is", "are", "should", "will", "would",
  "explain", "describe", "tell",
  "كيف", "ما", "ماذا", "لماذا", "متى", "اين", "أين", "هل", "ماهي", "ماهو", "اشرح", "وضح",
]);

/**
 * Only informational questions are cacheable. Imperatives ("enable tabby") are store mutations and
 * must always reach the agent, otherwise a cached explanation could be returned instead of acting.
 */
export function isInformationalQuestion(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (/[?؟]\s*$/.test(trimmed)) return true;
  const firstWord = trimmed.toLowerCase().split(/\s+/)[0].replace(/[^\p{L}']/gu, "");
  return QUESTION_STARTERS.has(firstWord);
}

/** Lowercases, strips punctuation, and collapses whitespace for exact-tier matching. */
function canonicalize(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lexical guard: two queries are equivalent only if every content word in one has a matching
 * normalized form in the other (stopwords, casing, punctuation, word order and inflections ignored).
 * This blocks meaning-flipping near-misses that embeddings rate as highly similar.
 */
function haveEquivalentContentWords(a: string, b: string): boolean {
  const wordsA = tokenizeToWordForms(a).map((forms) => new Set(forms));
  const wordsB = tokenizeToWordForms(b).map((forms) => new Set(forms));
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const hasMatch = (word: Set<string>, others: Set<string>[]) =>
    others.some((other) => [...word].some((form) => other.has(form)));

  return wordsA.every((w) => hasMatch(w, wordsB)) && wordsB.every((w) => hasMatch(w, wordsA));
}

export class SemanticCache {
  private entries: SemanticCacheEntry[] = [];
  private embeddingsService: EmbeddingsService;
  private corpusHash: string;
  private similarityThreshold: number;
  private persistPath?: string;

  constructor(embeddingsService: EmbeddingsService, options: SemanticCacheOptions = {}) {
    this.embeddingsService = embeddingsService;
    this.corpusHash = options.corpusHash ?? "default_corpus";
    this.similarityThreshold = options.similarityThreshold ?? 0.9;
    this.persistPath = options.persistPath;
    this.loadFromDisk();
  }

  /**
   * Builds a compound partition key from corpusHash + store constraints (currency, country, locale)
   * so cached answers never leak across incompatible store configurations.
   */
  public buildContextScope(constraints?: StoreConstraintContext): string {
    const currency = (constraints?.currency || "ANY").trim().toUpperCase();
    const country = (constraints?.country || "ANY").trim().toUpperCase();
    const locale = (constraints?.locale || "ANY").trim().toLowerCase();
    return `${this.corpusHash}::${currency}::${country}::${locale}`;
  }

  /**
   * Updates the active corpus hash and invalidates any cached entries from older corpus versions.
   */
  public syncCorpusHash(newCorpusHash: string): void {
    if (this.corpusHash !== newCorpusHash) {
      this.corpusHash = newCorpusHash;
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e.corpusHash === newCorpusHash);
      if (this.entries.length !== before) {
        void this.saveToDisk();
      }
    }
  }

  public clear(): void {
    this.entries = [];
    void this.saveToDisk();
  }

  public size(): number {
    return this.entries.length;
  }

  public async set(
    query: string,
    answer: string,
    citations: string[] = ["Semantic Cache (Mtajir Docs)"],
    constraints?: StoreConstraintContext
  ): Promise<void> {
    const canonicalQuery = canonicalize(query);
    if (!canonicalQuery) return;

    const contextScope = this.buildContextScope(constraints);
    const queryVector = await this.embeddingsService.embedText(canonicalQuery);

    const entry: SemanticCacheEntry = {
      canonicalQuery,
      queryVector,
      answer,
      citations,
      contextScope,
      corpusHash: this.corpusHash,
      createdAt: Date.now(),
    };

    const existingIdx = this.entries.findIndex(
      (e) => e.contextScope === contextScope && e.canonicalQuery === canonicalQuery
    );
    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.push(entry);
    }

    await this.saveToDisk();
  }

  public async get(
    query: string,
    constraints?: StoreConstraintContext
  ): Promise<CachedDocAnswer | undefined> {
    const canonicalQuery = canonicalize(query);
    if (!canonicalQuery) return undefined;

    const contextScope = this.buildContextScope(constraints);
    const scopedEntries = this.entries.filter(
      (e) => e.corpusHash === this.corpusHash && e.contextScope === contextScope
    );
    if (scopedEntries.length === 0) return undefined;

    // Tier 1: Exact canonical match (no API call)
    const exactMatch = scopedEntries.find((e) => e.canonicalQuery === canonicalQuery);
    if (exactMatch) {
      return {
        answer: exactMatch.answer,
        citations: exactMatch.citations,
        similarity: 1.0,
        hitType: "exact",
      };
    }

    // Tier 2: Lexically-equivalent candidates, confirmed by embedding similarity.
    // The embedding API is only called when a lexical candidate exists, so most misses are free.
    const candidates = scopedEntries.filter((e) =>
      haveEquivalentContentWords(canonicalQuery, e.canonicalQuery)
    );
    if (candidates.length === 0) return undefined;

    const queryVector = await this.embeddingsService.embedText(canonicalQuery);
    let bestEntry: SemanticCacheEntry | null = null;
    let bestSim = -1;

    for (const candidate of candidates) {
      const sim = cosineSimilarity(queryVector, candidate.queryVector);
      if (sim > bestSim) {
        bestSim = sim;
        bestEntry = candidate;
      }
    }

    if (bestEntry && bestSim >= this.similarityThreshold) {
      return {
        answer: bestEntry.answer,
        citations: bestEntry.citations,
        similarity: Number(bestSim.toFixed(6)),
        hitType: "semantic",
      };
    }

    return undefined;
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fsSync.existsSync(this.persistPath)) return;
    try {
      const parsed = JSON.parse(fsSync.readFileSync(this.persistPath, "utf-8"));
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(
          (e: SemanticCacheEntry) => e.corpusHash === this.corpusHash
        );
      }
    } catch {
      this.entries = [];
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.persistPath) return;
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    await fs.writeFile(
      this.persistPath,
      JSON.stringify({ corpusHash: this.corpusHash, entries: this.entries }),
      "utf-8"
    );
  }
}
