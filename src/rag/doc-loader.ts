import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DocFrontmatter {
  id: string;
  title: string;
  category: string;
  entities: string[];
  supportedCurrencies?: string[];
  supportedCountries?: string[];
  requiresCommercialRegistration?: boolean;
  relatedDocs?: string[];
  tags: string[];
}

export interface DocChunk {
  chunkId: string;
  docId: string;
  title: string;
  category: string;
  sectionHeader: string;
  content: string;
  hash: string;
  metadata: {
    entities: string[];
    supportedCurrencies?: string[];
    supportedCountries?: string[];
    requiresCommercialRegistration?: boolean;
    relatedDocs?: string[];
    tags: string[];
  };
}

export interface LoadedCorpus {
  chunks: DocChunk[];
  corpusHash: string;
}

export function computeMd5(input: string): string {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

function resolveDefaultDocsDir(): string {
  const cwdCandidate = path.join(process.cwd(), "data", "docs");
  if (fsSync.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRootCandidate = path.resolve(__dirname, "..", "..", "data", "docs");
  if (fsSync.existsSync(pkgRootCandidate)) {
    return pkgRootCandidate;
  }
  return cwdCandidate;
}

function parseBracketArray(rawArray: string): string[] {
  try {
    const parsed = JSON.parse(rawArray);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Handle Prettier trailing commas or single-quoted YAML items
  }
  return rawArray
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Parses YAML frontmatter block delimited by `---` at the top of a Markdown file.
 * Supports single-line arrays, Prettier-formatted multi-line `[ ... ]` arrays,
 * and YAML `- item` lists.
 */
export function parseFrontmatterAndBody(rawMarkdown: string): {
  frontmatter: DocFrontmatter;
  body: string;
} {
  const normalized = rawMarkdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  const defaults: DocFrontmatter = {
    id: "doc_unknown",
    title: "Untitled Document",
    category: "General",
    entities: [],
    tags: [],
  };

  if (!match) {
    return { frontmatter: defaults, body: normalized.trim() };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const parsed: Record<string, any> = {};
  const lines = yamlBlock.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const valStr = line.slice(colonIdx + 1).trim();

    if (valStr.startsWith("[") && valStr.endsWith("]")) {
      parsed[key] = parseBracketArray(valStr);
    } else if (valStr.startsWith("[")) {
      // Multi-line array starting on the key line: `tags: [` ... `]`
      const parts = [valStr];
      while (i + 1 < lines.length && !parts[parts.length - 1].endsWith("]")) {
        i++;
        const nextLine = lines[i].trim();
        if (nextLine && !nextLine.startsWith("#")) {
          parts.push(nextLine);
        }
      }
      parsed[key] = parseBracketArray(parts.join(" "));
    } else if (valStr === "") {
      // Check following lines for Prettier-indented `[ ... ]` or YAML `- item` list
      let lookahead = i + 1;
      while (lookahead < lines.length && (!lines[lookahead].trim() || lines[lookahead].trim().startsWith("#"))) {
        lookahead++;
      }

      if (lookahead < lines.length && lines[lookahead].trim().startsWith("[")) {
        const parts: string[] = [];
        i = lookahead - 1;
        while (i + 1 < lines.length) {
          i++;
          const nextLine = lines[i].trim();
          if (nextLine && !nextLine.startsWith("#")) {
            parts.push(nextLine);
            if (nextLine.endsWith("]")) break;
          }
        }
        parsed[key] = parseBracketArray(parts.join(" "));
      } else if (lookahead < lines.length && lines[lookahead].trim().startsWith("- ")) {
        const items: string[] = [];
        i = lookahead - 1;
        while (i + 1 < lines.length) {
          const peek = lines[i + 1].trim();
          if (!peek || peek.startsWith("#")) {
            i++;
            continue;
          }
          if (!peek.startsWith("- ")) break;
          i++;
          items.push(peek.slice(2).trim().replace(/^["']|["']$/g, ""));
        }
        parsed[key] = items;
      } else {
        parsed[key] = "";
      }
    } else if (valStr === "true" || valStr === "false") {
      parsed[key] = valStr === "true";
    } else {
      parsed[key] = valStr.replace(/^["']|["']$/g, "");
    }
  }

  return {
    frontmatter: {
      id: String(parsed.id || defaults.id),
      title: String(parsed.title || defaults.title),
      category: String(parsed.category || defaults.category),
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
      supportedCurrencies: Array.isArray(parsed.supportedCurrencies)
        ? parsed.supportedCurrencies.map(String)
        : undefined,
      supportedCountries: Array.isArray(parsed.supportedCountries)
        ? parsed.supportedCountries.map(String)
        : undefined,
      requiresCommercialRegistration:
        typeof parsed.requiresCommercialRegistration === "boolean"
          ? parsed.requiresCommercialRegistration
          : undefined,
      relatedDocs: Array.isArray(parsed.relatedDocs)
        ? parsed.relatedDocs.map(String)
        : undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    },
    body,
  };
}

/**
 * Splits a markdown document body by `## ` section headers into semantic chunks
 * while propagating document-level frontmatter metadata to each chunk.
 */
export function chunkMarkdownDocument(rawMarkdown: string): DocChunk[] {
  const { frontmatter, body } = parseFrontmatterAndBody(rawMarkdown);

  // Strip top-level `# Title` if present so sections stay clean
  const bodyWithoutH1 = body.replace(/^#\s+[^\n]+\n+/, "").trim();
  const rawSections = bodyWithoutH1.split(/\n(?=##\s+)/);

  const chunks: DocChunk[] = [];

  rawSections.forEach((sectionText, idx) => {
    const trimmed = sectionText.trim();
    if (!trimmed) return;

    let sectionHeader = "Overview";
    let content = trimmed;

    const headerMatch = trimmed.match(/^##\s+([^\n]+)\n+([\s\S]*)$/);
    if (headerMatch) {
      sectionHeader = headerMatch[1].trim();
      content = headerMatch[2].trim();
    } else if (trimmed.startsWith("## ")) {
      sectionHeader = trimmed.replace(/^##\s+/, "").trim();
      content = sectionHeader;
    }

    const chunkId = `${frontmatter.id}#chunk_${idx}`;
    const metadata = {
      entities: frontmatter.entities,
      supportedCurrencies: frontmatter.supportedCurrencies,
      supportedCountries: frontmatter.supportedCountries,
      requiresCommercialRegistration: frontmatter.requiresCommercialRegistration,
      relatedDocs: frontmatter.relatedDocs,
      tags: frontmatter.tags,
    };

    const hashPayload = JSON.stringify({
      chunkId,
      title: frontmatter.title,
      sectionHeader,
      content,
      metadata,
    });

    chunks.push({
      chunkId,
      docId: frontmatter.id,
      title: frontmatter.title,
      category: frontmatter.category,
      sectionHeader,
      content,
      hash: computeMd5(hashPayload),
      metadata,
    });
  });

  return chunks;
}

/**
 * Loads all `.md` files from `docsDir`, chunks them, and computes an aggregate corpusHash.
 */
export async function loadDocumentationCorpus(
  docsDir = resolveDefaultDocsDir()
): Promise<LoadedCorpus> {
  let files: string[] = [];
  try {
    const entries = await fs.readdir(docsDir);
    files = entries.filter((f) => f.endsWith(".md")).sort();
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { chunks: [], corpusHash: computeMd5("empty_corpus") };
    }
    throw err;
  }

  const allChunks: DocChunk[] = [];
  for (const file of files) {
    const fullPath = path.join(docsDir, file);
    const raw = await fs.readFile(fullPath, "utf-8");
    const docChunks = chunkMarkdownDocument(raw);
    allChunks.push(...docChunks);
  }

  const corpusHash = computeMd5(allChunks.map((c) => `${c.chunkId}:${c.hash}`).join("|"));
  return { chunks: allChunks, corpusHash };
}

/**
 * Synchronous corpus loader for synchronous initialization paths.
 */
export function loadDocumentationCorpusSync(
  docsDir = resolveDefaultDocsDir()
): LoadedCorpus {
  if (!fsSync.existsSync(docsDir)) {
    return { chunks: [], corpusHash: computeMd5("empty_corpus") };
  }

  const files = fsSync
    .readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const allChunks: DocChunk[] = [];
  for (const file of files) {
    const fullPath = path.join(docsDir, file);
    const raw = fsSync.readFileSync(fullPath, "utf-8");
    const docChunks = chunkMarkdownDocument(raw);
    allChunks.push(...docChunks);
  }

  const corpusHash = computeMd5(allChunks.map((c) => `${c.chunkId}:${c.hash}`).join("|"));
  return { chunks: allChunks, corpusHash };
}
