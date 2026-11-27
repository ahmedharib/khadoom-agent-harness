import { normalizeAndTokenize, tokenizeToWordForms } from "./bm25-search.js";
import type { DocSearchResult } from "./hybrid-search.js";

export interface CitationPassage {
  chunkId: string;
  sectionHeader: string;
  content: string;
  /** Exact substrings inside `content` aligned with the generated answer and query */
  matchedExcerpts: string[];
  rrfScore?: number;
  vectorSimilarity?: number;
  bm25Score?: number;
  rerankScore?: number;
  answerOverlapScore: number;
}

export interface CitationDetail {
  docId: string;
  title: string;
  category: string;
  passages: CitationPassage[];
}

/**
 * Splits a retrieved chunk into non-empty lines/sentences without breaking numbered list prefixes ("1. ").
 */
function splitIntoSegments(content: string): string[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const segments: string[] = [];
  for (const line of lines) {
    // Split on sentence boundaries (. ! ? ؟) followed by whitespace, skipping list prefixes like "1. " or "2) "
    let start = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if ((ch === "." || ch === "!" || ch === "?" || ch === "؟") && /\s/.test(next)) {
        const prefix = line.slice(start, i + 1).trim();
        // Do not split right after a short numbered list item marker ("1.", "12.")
        if (/^\d+\.$/.test(prefix)) {
          continue;
        }
        // Do not split inside common abbreviations/code-like tokens when followed by lowercase
        if (prefix.length >= 12) {
          segments.push(prefix);
          start = i + 1;
          while (start < line.length && /\s/.test(line[start])) {
            start++;
          }
          i = start - 1;
        }
      }
    }
    const tail = line.slice(start).trim();
    if (tail) {
      segments.push(tail);
    }
  }

  return segments;
}

function extractNumbers(text: string): Set<string> {
  const matches = text.match(/\b\d+(?:\.\d+)?\b/g);
  return new Set(matches ?? []);
}

/**
 * Scores segments of `content` against the generated answer (2x weight) and original user query (1x weight),
 * returning exact substrings from `content` that support the answer.
 */
export function extractMatchedExcerpts(
  content: string,
  answerText: string,
  userQuery = ""
): { matchedExcerpts: string[]; answerOverlapScore: number } {
  const segments = splitIntoSegments(content);
  if (segments.length === 0) {
    return { matchedExcerpts: [], answerOverlapScore: 0 };
  }

  const answerTerms = new Set(normalizeAndTokenize(answerText));
  const queryTerms = new Set(normalizeAndTokenize(userQuery));
  const answerNums = extractNumbers(answerText);
  const queryNums = extractNumbers(userQuery);

  let maxRawScore = 0;
  let totalRawScore = 0;

  const scored = segments.map((segment) => {
    const wordForms = tokenizeToWordForms(segment);
    const segNums = extractNumbers(segment);

    let answerHits = 0;
    let queryHits = 0;

    for (const forms of wordForms) {
      if (forms.some((f) => answerTerms.has(f))) {
        answerHits++;
      } else if (forms.some((f) => queryTerms.has(f))) {
        queryHits++;
      }
    }

    for (const n of segNums) {
      if (answerNums.has(n)) {
        answerHits++;
      } else if (queryNums.has(n)) {
        queryHits++;
      }
    }

    const rawScore = answerHits * 2 + queryHits;
    const normalizedScore =
      rawScore === 0 ? 0 : rawScore / Math.sqrt(Math.max(1, wordForms.length + segNums.size));

    if (rawScore > maxRawScore) maxRawScore = rawScore;
    totalRawScore += rawScore;

    return { segment, rawScore, normalizedScore, answerHits };
  });

  if (maxRawScore === 0) {
    return { matchedExcerpts: [], answerOverlapScore: 0 };
  }

  const maxNorm = Math.max(...scored.map((s) => s.normalizedScore));
  const matchedExcerpts = scored
    .filter((s) => s.normalizedScore > 0 && s.normalizedScore >= maxNorm * 0.65)
    .map((s) => s.segment);

  return {
    matchedExcerpts,
    answerOverlapScore: Number((maxNorm + totalRawScore * 0.1).toFixed(4)),
  };
}

/**
 * Groups retrieved RAG chunks by document title/docId, computes highlighted answer excerpts,
 * and orders documents & passages by how strongly they support the final answer.
 */
export function buildCitationDetails(
  results: DocSearchResult[],
  answerText: string,
  userQuery = "",
  allowedTitles?: string[]
): CitationDetail[] {
  const byDoc = new Map<string, CitationDetail>();
  const seenChunks = new Set<string>();

  for (const r of results) {
    if (allowedTitles && !allowedTitles.includes(r.title)) continue;
    if (seenChunks.has(r.chunkId)) continue;
    seenChunks.add(r.chunkId);

    const { matchedExcerpts, answerOverlapScore } = extractMatchedExcerpts(
      r.content,
      answerText,
      userQuery
    );

    const passage: CitationPassage = {
      chunkId: r.chunkId,
      sectionHeader: r.sectionHeader,
      content: r.content,
      matchedExcerpts,
      rrfScore: r.rrfScore,
      vectorSimilarity: r.vectorSimilarity,
      bm25Score: r.bm25Score,
      rerankScore: r.rerankScore,
      answerOverlapScore,
    };

    const existing = byDoc.get(r.docId);
    if (existing) {
      existing.passages.push(passage);
    } else {
      byDoc.set(r.docId, {
        docId: r.docId,
        title: r.title,
        category: r.category,
        passages: [passage],
      });
    }
  }

  const details = Array.from(byDoc.values());
  for (const d of details) {
    d.passages.sort((a, b) => {
      if (Math.abs(b.answerOverlapScore - a.answerOverlapScore) > 1e-6) {
        return b.answerOverlapScore - a.answerOverlapScore;
      }
      return (b.rrfScore ?? 0) - (a.rrfScore ?? 0);
    });
  }

  details.sort((a, b) => {
    const aBest = a.passages[0]?.answerOverlapScore ?? 0;
    const bBest = b.passages[0]?.answerOverlapScore ?? 0;
    if (Math.abs(bBest - aBest) > 1e-6) {
      return bBest - aBest;
    }
    return (b.passages[0]?.rrfScore ?? 0) - (a.passages[0]?.rrfScore ?? 0);
  });

  return details;
}
