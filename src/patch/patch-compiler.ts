import jsonpatch, { type Operation } from "fast-json-patch";
import { JsonPatchOperation } from "../schema/patch.schema.js";

const applyPatch = jsonpatch.applyPatch;

const PREDICATE_REGEX = /^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)=([^\]]+)\]$/;
const WILDCARD_REGEX = /^([a-zA-Z0-9_-]+)\[\*\]$/;

function comparePathsDescending(pathA: string, pathB: string): number {
  const segsA = pathA.split("/").filter(Boolean);
  const segsB = pathB.split("/").filter(Boolean);
  const minLen = Math.min(segsA.length, segsB.length);
  for (let i = 0; i < minLen; i++) {
    if (segsA[i] !== segsB[i]) {
      const aIsNum = /^\d+$/.test(segsA[i]);
      const bIsNum = /^\d+$/.test(segsB[i]);
      if (aIsNum && bIsNum) {
        return Number(segsB[i]) - Number(segsA[i]);
      }
      return segsB[i].localeCompare(segsA[i]);
    }
  }
  return segsB.length - segsA.length;
}

export function getValueAtPath(obj: any, path: string): any {
  const parts = path.split("/").filter(Boolean);
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}

/**
 * Expands a semantic path that may contain wildcards (e.g. '/products[*]/price')
 * or filter predicates into an array of concrete RFC 6902 paths.
 */
export function expandSemanticPath(store: any, path: string): string[] {
  const segments = path.split("/").filter(Boolean);

  function expandRecursive(currentObj: any, remainingSegments: string[]): string[][] {
    if (remainingSegments.length === 0) {
      return [[]];
    }

    const [head, ...tail] = remainingSegments;

    // 1. Array Wildcard: [ * ]
    const wildcardMatch = head.match(WILDCARD_REGEX);
    if (wildcardMatch) {
      const [, arrayProp] = wildcardMatch;
      const arr = currentObj?.[arrayProp];
      if (!Array.isArray(arr) || arr.length === 0) {
        return [];
      }

      const results: string[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const subPaths = expandRecursive(arr[i], tail);
        for (const sub of subPaths) {
          results.push([arrayProp, String(i), ...sub]);
        }
      }
      return results;
    }

    // 2. Predicate: [ key = val ]
    const predicateMatch = head.match(PREDICATE_REGEX);
    if (predicateMatch) {
      const [, arrayProp, matchKey, matchValue] = predicateMatch;
      const arr = currentObj?.[arrayProp];
      if (!Array.isArray(arr)) {
        throw new Error(
          `Invalid path segment '${head}': Property '${arrayProp}' is not an array on target object.`
        );
      }

      // Check if matchValue is matching single or filter
      const targetLower = matchValue.toLowerCase();
      const matchedIndices: number[] = [];

      arr.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const fieldVal = item[matchKey];
        if (Array.isArray(fieldVal)) {
          if (fieldVal.some((v) => String(v).toLowerCase() === targetLower)) {
            matchedIndices.push(index);
          }
        } else if (String(fieldVal).toLowerCase() === targetLower) {
          matchedIndices.push(index);
        }
      });

      if (matchedIndices.length === 0) {
        const availableValues = arr.map((item) => item?.[matchKey] ?? "unknown").join(", ");
        throw new Error(
          `Item with ${matchKey}='${matchValue}' not found in /${arrayProp}. Available: [${availableValues}]`
        );
      }

      const results: string[][] = [];
      for (const i of matchedIndices) {
        const subPaths = expandRecursive(arr[i], tail);
        for (const sub of subPaths) {
          results.push([arrayProp, String(i), ...sub]);
        }
      }
      return results;
    }

    // 3. Regular property segment
    const nextObj = currentObj && typeof currentObj === "object" ? currentObj[head] : undefined;
    const subPaths = expandRecursive(nextObj, tail);
    return subPaths.map((sub) => [head, ...sub]);
  }

  const expanded = expandRecursive(store, segments);
  return expanded.map((parts) => "/" + parts.join("/"));
}

/**
 * Resolves a single predicate path into an exact index path.
 */
export function compilePredicatePath(store: any, path: string): string {
  const expanded = expandSemanticPath(store, path);
  if (expanded.length === 0) {
    throw new Error(`Path '${path}' did not resolve to any target in store.`);
  }
  return expanded[0];
}

/**
 * Compiles high-level semantic patches into strict, standard RFC 6902 patches:
 * 1. Expands array wildcards (e.g. '/products[*]/price') into individual item paths.
 * 2. Resolves ID predicates (e.g. '/paymentProviders[id=cod]/enabled') to numeric array indices.
 * 3. Computes arithmetic operations ('increment', 'decrement', 'percentage', 'multiply')
 *    against current store values and converts them to standard 'replace' ops.
 * 4. Automatically clamps prices and inventory reductions to >= 0.
 */
const ARITHMETIC_OPS = new Set(["increment", "decrement", "percentage", "multiply"]);

function computeArithmeticValue(op: string, currentVal: any, targetPath: string, rawOperand: any): number {
  if (typeof currentVal !== "number") {
    throw new Error(
      `Cannot apply '${op}' to non-numeric value at '${targetPath}' (current value: ${JSON.stringify(currentVal)})`
    );
  }
  const operand = Number(rawOperand);
  let rawResult: number;
  if (op === "increment") {
    rawResult = currentVal + operand;
  } else if (op === "decrement") {
    rawResult = currentVal - operand;
  } else if (op === "percentage") {
    rawResult = currentVal * (1 + operand / 100);
  } else {
    rawResult = currentVal * operand;
  }
  return Math.max(0, Number(rawResult.toFixed(2)));
}

export function compilePredicatePatches(
  store: any,
  patches: JsonPatchOperation[]
): JsonPatchOperation[] {
  const compiled: JsonPatchOperation[] = [];
  // Advance a working clone step-by-step so sequential patches and multi-item
  // removals never read stale indices or pre-batch values (C4).
  const workingStore = JSON.parse(JSON.stringify(store));

  for (const patch of patches) {
    const expandedPaths = expandSemanticPath(workingStore, patch.path);

    if (expandedPaths.length === 0) {
      throw new Error(`Path '${patch.path}' did not match any targets in the store.`);
    }

    const targetPaths =
      patch.op === "remove" && expandedPaths.length > 1
        ? [...expandedPaths].sort(comparePathsDescending)
        : expandedPaths;

    for (const targetPath of targetPaths) {
      const currentVal = getValueAtPath(workingStore, targetPath);
      const compiledOp: JsonPatchOperation = ARITHMETIC_OPS.has(patch.op)
        ? {
            op: "replace",
            path: targetPath,
            value: computeArithmeticValue(patch.op, currentVal, targetPath, patch.value),
          }
        : {
            op: patch.op,
            path: targetPath,
            value: patch.value,
            from: patch.from ? compilePredicatePath(workingStore, patch.from) : undefined,
          };

      applyPatch(workingStore, [compiledOp as Operation], true, true);
      compiled.push(compiledOp);
    }
  }

  return compiled;
}
