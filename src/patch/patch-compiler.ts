import { JsonPatchOperation } from "../schema/patch.schema.js";

const PREDICATE_REGEX = /^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]+)=([^\]]+)\]$/;

/**
 * Resolves a semantic predicate path (e.g. '/paymentProviders[id=cod]/enabled')
 * into an exact RFC 6902 positional index path (e.g. '/paymentProviders/4/enabled')
 * based on the current store state.
 */
export function compilePredicatePath(store: any, path: string): string {
  if (!path.includes("[")) {
    return path;
  }

  const segments = path.split("/").filter(Boolean);
  const compiledSegments: string[] = [];
  let currentObj = store;

  for (const segment of segments) {
    const match = segment.match(PREDICATE_REGEX);

    if (match) {
      const [, arrayProp, matchKey, matchValue] = match;

      if (!currentObj || typeof currentObj !== "object" || !Array.isArray(currentObj[arrayProp])) {
        throw new Error(
          `Invalid predicate path segment '${segment}': Property '${arrayProp}' is not an array on the target object.`
        );
      }

      const arr = currentObj[arrayProp] as any[];
      const foundIndex = arr.findIndex((item) => {
        if (!item || typeof item !== "object") return false;
        // String comparison to match numbers or string IDs flexibly
        return String(item[matchKey]).toLowerCase() === String(matchValue).toLowerCase();
      });

      if (foundIndex === -1) {
        const availableValues = arr.map((item) => item?.[matchKey] ?? "unknown").join(", ");
        throw new Error(
          `Item with ${matchKey}='${matchValue}' not found in /${arrayProp}. Available: [${availableValues}]`
        );
      }

      compiledSegments.push(arrayProp);
      compiledSegments.push(String(foundIndex));
      currentObj = arr[foundIndex];
    } else {
      compiledSegments.push(segment);
      if (currentObj && typeof currentObj === "object") {
        currentObj = currentObj[segment];
      }
    }
  }

  return "/" + compiledSegments.join("/");
}

/**
 * Compiles an array of patches, converting any predicate-based paths into standard RFC 6902 paths.
 */
export function compilePredicatePatches(
  store: any,
  patches: JsonPatchOperation[]
): JsonPatchOperation[] {
  return patches.map((patch) => {
    const compiledPath = compilePredicatePath(store, patch.path);
    const compiledFrom = patch.from ? compilePredicatePath(store, patch.from) : undefined;

    return {
      ...patch,
      path: compiledPath,
      ...(compiledFrom ? { from: compiledFrom } : {}),
    };
  });
}
