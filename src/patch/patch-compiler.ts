import { JsonPatchOperation } from "../schema/patch.schema.js";

const PREDICATE_REGEX = /^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)=([^\]]+)\]$/;
const WILDCARD_REGEX = /^([a-zA-Z0-9_-]+)\[\*\]$/;

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
export function compilePredicatePatches(
  store: any,
  patches: JsonPatchOperation[]
): JsonPatchOperation[] {
  const compiled: JsonPatchOperation[] = [];

  for (const patch of patches) {
    const targetPaths = expandSemanticPath(store, patch.path);

    if (targetPaths.length === 0) {
      throw new Error(`Path '${patch.path}' did not match any targets in the store.`);
    }

    for (const targetPath of targetPaths) {
      const currentVal = getValueAtPath(store, targetPath);

      // 1. Arithmetic: Increment (+= delta)
      if (patch.op === "increment") {
        if (typeof currentVal !== "number") {
          throw new Error(
            `Cannot increment non-numeric value at '${targetPath}' (current value: ${JSON.stringify(currentVal)})`
          );
        }
        const delta = Number(patch.value);
        let newVal = Number((currentVal + delta).toFixed(2));
        newVal = Math.max(0, newVal); // Clamp non-negative
        compiled.push({ op: "replace", path: targetPath, value: newVal });
        continue;
      }

      // 2. Arithmetic: Decrement (-= delta)
      if (patch.op === "decrement") {
        if (typeof currentVal !== "number") {
          throw new Error(
            `Cannot decrement non-numeric value at '${targetPath}' (current value: ${JSON.stringify(currentVal)})`
          );
        }
        const delta = Number(patch.value);
        let newVal = Number((currentVal - delta).toFixed(2));
        newVal = Math.max(0, newVal); // Clamp non-negative
        compiled.push({ op: "replace", path: targetPath, value: newVal });
        continue;
      }

      // 3. Arithmetic: Percentage (+- X%)
      if (patch.op === "percentage") {
        if (typeof currentVal !== "number") {
          throw new Error(
            `Cannot apply percentage to non-numeric value at '${targetPath}' (current value: ${JSON.stringify(currentVal)})`
          );
        }
        const pct = Number(patch.value);
        const factor = 1 + pct / 100;
        let newVal = Number((currentVal * factor).toFixed(2));
        newVal = Math.max(0, newVal); // Clamp non-negative
        compiled.push({ op: "replace", path: targetPath, value: newVal });
        continue;
      }

      // 4. Arithmetic: Multiply (*= factor)
      if (patch.op === "multiply") {
        if (typeof currentVal !== "number") {
          throw new Error(
            `Cannot multiply non-numeric value at '${targetPath}' (current value: ${JSON.stringify(currentVal)})`
          );
        }
        const factor = Number(patch.value);
        let newVal = Number((currentVal * factor).toFixed(2));
        newVal = Math.max(0, newVal); // Clamp non-negative
        compiled.push({ op: "replace", path: targetPath, value: newVal });
        continue;
      }

      // 5. Standard RFC 6902 operation
      compiled.push({
        op: patch.op,
        path: targetPath,
        value: patch.value,
        from: patch.from ? compilePredicatePath(store, patch.from) : undefined,
      });
    }
  }

  return compiled;
}
