import { DocChunk } from "./doc-loader.js";

const ARABIC_DIACRITICS_REGEX = /[\u064B-\u065F\u0670\u0640]/g;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "where",
  "which",
  "with",
  "you",
  "your",
  // Arabic common stopwords
  "من",
  "في",
  "على",
  "عن",
  "الى",
  "إلى",
  "مع",
  "هل",
  "كيف",
  "ما",
  "ماذا",
  "متى",
  "هو",
  "هي",
  "هم",
  "ان",
  "أن",
  "إن",
  "كان",
  "هذا",
  "هذه",
  "ذلك",
  "تي",
  "الذي",
  "التي",
  "او",
  "أو",
]);

/**
 * Normalizes a single Arabic word:
 * 1. Strips tashkeel/diacritics and tatweel.
 * 2. Unifies Alef variants (أ/إ/آ/ٱ -> ا), Taa Marbuta (ة -> ه), Alef Maqsura (ى -> ي), Hamza (ؤ->و, ئ->ي).
 * 3. Strips common clitic prefixes (وال, بال, كال, فال, لل, ال, و, ب, ل, ف) when remaining stem >= 3 chars.
 */
export function normalizeArabicWord(word: string): string[] {
  let w = word
    .replace(ARABIC_DIACRITICS_REGEX, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");

  const tokens = new Set<string>([w]);

  // Multi-letter definite prefixes
  const compoundPrefixes = ["وال", "بال", "كال", "فال", "لل", "ال"];
  for (const prefix of compoundPrefixes) {
    if (w.startsWith(prefix) && w.length - prefix.length >= 3) {
      w = w.slice(prefix.length);
      tokens.add(w);
      break;
    }
  }

  // Single-letter clitic prefixes (و, ب, ل, ف, ك) if remaining stem >= 3 chars
  const singlePrefixes = ["و", "ب", "ل", "ف", "ك"];
  for (const prefix of singlePrefixes) {
    if (w.startsWith(prefix) && w.length - prefix.length >= 3) {
      const stripped = w.slice(prefix.length);
      tokens.add(stripped);
      // If followed by ال after single clitic
      if (stripped.startsWith("ال") && stripped.length - 2 >= 3) {
        tokens.add(stripped.slice(2));
      }
      break;
    }
  }

  // Light suffix normalization for Arabic plural/possessive (ات, ين, ون, ها, هم)
  for (const tok of Array.from(tokens)) {
    if (tok.endsWith("ات") && tok.length >= 5) {
      tokens.add(tok.slice(0, -2));
      tokens.add(tok.slice(0, -2) + "ه");
    } else if ((tok.endsWith("ين") || tok.endsWith("ون") || tok.endsWith("ها")) && tok.length >= 5) {
      tokens.add(tok.slice(0, -2));
    }
  }

  return Array.from(tokens);
}

/**
 * Light English stemmer that preserves both the original lowercase token and its base stem.
 */
export function normalizeEnglishWord(word: string): string[] {
  const w = word.toLowerCase();
  const tokens = new Set<string>([w]);

  if (w.length > 4) {
    if (w.endsWith("ies") && w.length > 5) {
      tokens.add(w.slice(0, -3) + "y");
    } else if (w.endsWith("ing") && w.length > 5) {
      const base = w.slice(0, -3);
      tokens.add(base);
      // e.g. shipping -> shipp -> ship, configuring -> configur -> configure
      if (base.length >= 4 && base[base.length - 1] === base[base.length - 2]) {
        tokens.add(base.slice(0, -1));
      } else {
        tokens.add(base + "e");
      }
    } else if (w.endsWith("ed") && w.length > 4) {
      tokens.add(w.slice(0, -2));
      tokens.add(w.slice(0, -1));
    } else if (w.endsWith("es") && w.length > 4) {
      tokens.add(w.slice(0, -2));
      tokens.add(w.slice(0, -1));
    } else if (w.endsWith("s") && !w.endsWith("ss")) {
      tokens.add(w.slice(0, -1));
    }
  }

  return Array.from(tokens);
}

/**
 * Tokenizes bilingual (Arabic + English) text into content words, returning the set of
 * normalized surface forms for each word (e.g. "supported" -> ["supported", "support", ...]).
 * Stopwords are dropped. Used by BM25 indexing and by the semantic cache's lexical guard.
 */
export function tokenizeToWordForms(text: string): string[][] {
  if (!text) return [];

  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim();

  if (!cleaned) return [];

  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  const words: string[][] = [];

  for (const raw of rawWords) {
    // Also split hyphenated or underscored identifiers (e.g., doc_shipping_zones, apple_pay)
    const parts = raw.split(/[_-]+/).filter(Boolean);
    for (const part of parts) {
      if (STOPWORDS.has(part)) continue;
      const isArabic = /[\u0600-\u06FF]/.test(part);
      const expanded = isArabic ? normalizeArabicWord(part) : normalizeEnglishWord(part);
      const forms = expanded.filter((tok) => tok.length >= 2 && !STOPWORDS.has(tok));
      if (forms.length > 0) {
        words.push(forms);
      }
    }
  }

  return words;
}

/**
 * Tokenizes and normalizes bilingual (Arabic + English) text into searchable terms.
 */
export function normalizeAndTokenize(text: string): string[] {
  return tokenizeToWordForms(text).flat();
}

export interface BM25ScoredChunk {
  chunk: DocChunk;
  score: number;
  rank: number;
}

interface IndexedDocument {
  chunk: DocChunk;
  termFreqs: Map<string, number>;
  length: number;
}

/**
 * Zero-dependency Okapi BM25 lexical search engine with field boosting
 * and Arabic/English normalization.
 */
export class BM25SearchEngine {
  private docs: IndexedDocument[] = [];
  private docFreqs: Map<string, number> = new Map();
  private avgDocLength = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(chunks: DocChunk[] = [], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.indexChunks(chunks);
  }

  indexChunks(chunks: DocChunk[]): void {
    this.docs = [];
    this.docFreqs.clear();

    if (chunks.length === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;

    for (const chunk of chunks) {
      // Field weighting: repeat title (3x), sectionHeader (2x), entities (3x), tags (2x)
      const compositeText = [
        chunk.docId,
        chunk.title,
        chunk.title,
        chunk.title,
        chunk.category,
        chunk.sectionHeader,
        chunk.sectionHeader,
        ...(chunk.metadata.entities || []),
        ...(chunk.metadata.entities || []),
        ...(chunk.metadata.entities || []),
        ...(chunk.metadata.tags || []),
        ...(chunk.metadata.tags || []),
        chunk.content,
      ].join(" ");

      const tokens = normalizeAndTokenize(compositeText);
      const termFreqs = new Map<string, number>();

      for (const token of tokens) {
        termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
      }

      for (const uniqueTerm of termFreqs.keys()) {
        this.docFreqs.set(uniqueTerm, (this.docFreqs.get(uniqueTerm) || 0) + 1);
      }

      this.docs.push({
        chunk,
        termFreqs,
        length: tokens.length,
      });

      totalLength += tokens.length;
    }

    this.avgDocLength = totalLength / chunks.length;
  }

  search(query: string, allowedChunkIds?: Set<string>, limit = 10): BM25ScoredChunk[] {
    const queryTokens = normalizeAndTokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) {
      return [];
    }

    const N = this.docs.length;
    const scored: { chunk: DocChunk; score: number }[] = [];

    for (const doc of this.docs) {
      if (allowedChunkIds && !allowedChunkIds.has(doc.chunk.chunkId)) {
        continue;
      }

      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) || 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(term) || 0;
        // Standard Okapi BM25 IDF with smoothing
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const normTf =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / (this.avgDocLength || 1))));

        score += idf * normTf;
      }

      if (score > 0) {
        scored.push({ chunk: doc.chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((item, idx) => ({
      chunk: item.chunk,
      score: Number(item.score.toFixed(6)),
      rank: idx + 1,
    }));
  }
}
