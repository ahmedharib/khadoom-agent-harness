import { DocChunk } from "./doc-loader.js";

export interface StoreConstraintContext {
  currency?: string;
  country?: string;
  locale?: string;
}

/**
 * Checks whether a single documentation chunk is compatible with the active store's
 * currency and country constraints.
 */
export function isChunkCompatibleWithStore(
  chunk: DocChunk,
  constraints?: StoreConstraintContext
): boolean {
  if (!constraints) return true;

  if (constraints.currency) {
    const targetCurrency = constraints.currency.trim().toUpperCase();
    const supportedCurrencies = chunk.metadata.supportedCurrencies;
    if (Array.isArray(supportedCurrencies) && supportedCurrencies.length > 0) {
      const normalizedSupported = supportedCurrencies.map((c) => c.trim().toUpperCase());
      if (!normalizedSupported.includes(targetCurrency)) {
        return false;
      }
    }
  }

  if (constraints.country) {
    const targetCountry = constraints.country.trim().toUpperCase();
    const supportedCountries = chunk.metadata.supportedCountries;
    if (Array.isArray(supportedCountries) && supportedCountries.length > 0) {
      const normalizedSupported = supportedCountries.map((c) => c.trim().toUpperCase());
      if (!normalizedSupported.includes(targetCountry)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filters a list of documentation chunks by active store constraints.
 */
export function filterChunksByConstraints(
  chunks: DocChunk[],
  constraints?: StoreConstraintContext
): {
  allowedChunks: DocChunk[];
  allowedChunkIds: Set<string>;
} {
  const allowedChunks = chunks.filter((chunk) => isChunkCompatibleWithStore(chunk, constraints));
  const allowedChunkIds = new Set(allowedChunks.map((c) => c.chunkId));
  return { allowedChunks, allowedChunkIds };
}
