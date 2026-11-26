import jsonpatch, { type Operation } from "fast-json-patch";
import { JsonPatchOperation } from "../schema/patch.schema.js";
import { MtajirStore } from "../schema/store.schema.js";

const applyPatch = jsonpatch.applyPatch;

export interface SemanticChangeItem {
  category: "branding" | "catalog" | "shipping" | "payments" | "navigation" | "general";
  path: string;
  operation: string;
  summary: string;
  details: {
    oldValue?: any;
    newValue?: any;
  };
}

function getValueAtPath(obj: any, path: string): any {
  const parts = path.split("/").filter(Boolean);
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}

export function isDeepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b;
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function isNoOpPatch(originalStore: any, patch: JsonPatchOperation): boolean {
  const { op, path, value } = patch;
  const oldValue = getValueAtPath(originalStore, path);

  if (op === "replace") {
    return isDeepEqual(oldValue, value);
  }

  if (op === "add") {
    if (oldValue !== undefined) {
      return isDeepEqual(oldValue, value);
    }
    return false;
  }

  if (op === "remove") {
    return oldValue === undefined;
  }

  return false;
}

function buildSemanticDiffItem(
  storeState: MtajirStore,
  patch: JsonPatchOperation
): SemanticChangeItem {
  const { op, path, value } = patch;
  const oldValue = getValueAtPath(storeState, path);

  // 1. Theme / Branding changes
  if (path.startsWith("/theme/colors/")) {
    const colorKey = path.split("/")[3];
    return {
      category: "branding",
      path,
      operation: op,
      summary: `Changed ${colorKey} theme color from '${oldValue}' to '${value}'`,
      details: { oldValue, newValue: value },
    };
  }

  if (path.startsWith("/theme/banner/")) {
    const bannerKey = path.split("/")[3];
    if (bannerKey === "enabled") {
      return {
        category: "branding",
        path,
        operation: op,
        summary: value ? "Enabled promotional announcement banner" : "Disabled announcement banner",
        details: { oldValue, newValue: value },
      };
    }
    return {
      category: "branding",
      path,
      operation: op,
      summary: `Updated banner ${bannerKey} to '${value}'`,
      details: { oldValue, newValue: value },
    };
  }

  if (path.startsWith("/theme/typography/")) {
    const typeKey = path.split("/")[3];
    return {
      category: "branding",
      path,
      operation: op,
      summary: `Updated ${typeKey} font to '${value}'`,
      details: { oldValue, newValue: value },
    };
  }

  // 2. Catalog / Products
  if (path.startsWith("/products")) {
    const parts = path.split("/").filter(Boolean);
    if (
      (parts.length === 1 ||
        (parts.length === 2 && (parts[1] === "-" || /^\d+$/.test(parts[1])))) &&
      op === "add"
    ) {
      return {
        category: "catalog",
        path,
        operation: op,
        summary: `Added new product '${value?.title || "Item"}' (Price: ${value?.price ?? 0} ${storeState.currency})`,
        details: { newValue: value },
      };
    }
    if (parts.length === 2 && op === "remove") {
      const prod = storeState.products[parseInt(parts[1], 10)];
      const prodTitle = prod ? prod.title : `Product #${parts[1]}`;
      return {
        category: "catalog",
        path,
        operation: op,
        summary: `Removed product '${prodTitle}'`,
        details: { oldValue },
      };
    }
    if (parts.length >= 3) {
      const prodIndex = parts[1];
      const field = parts.slice(2).join(".");
      const prod = storeState.products[parseInt(prodIndex, 10)];
      const prodTitle = prod ? prod.title : `Product #${prodIndex}`;
      return {
        category: "catalog",
        path,
        operation: op,
        summary: `Updated ${field} for '${prodTitle}' from '${oldValue}' to '${value}'`,
        details: { oldValue, newValue: value },
      };
    }
    return {
      category: "catalog",
      path,
      operation: op,
      summary: `Modified products collection at ${path}`,
      details: { oldValue, newValue: value },
    };
  }

  // 3. Shipping Zones & Rates
  if (path.startsWith("/shippingZones")) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 2 && op === "add") {
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Added shipping zone '${value?.name || "New Zone"}' (${(value?.countries || []).join(", ")})`,
        details: { newValue: value },
      };
    }
    if (parts.length === 2 && op === "remove") {
      const zone = storeState.shippingZones[parseInt(parts[1], 10)];
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Removed shipping zone '${zone?.name || parts[1]}'`,
        details: { oldValue },
      };
    }
    if (parts[2] === "rates" && parts.length <= 4 && op === "add") {
      const zone = storeState.shippingZones[parseInt(parts[1], 10)];
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Added shipping rate '${value?.name || "Rate"}' (${value?.price ?? 0} ${storeState.currency}) to '${zone?.name || "Zone"}'`,
        details: { newValue: value },
      };
    }
    if (parts[2] === "rates" && parts.length === 4 && op === "remove") {
      const zone = storeState.shippingZones[parseInt(parts[1], 10)];
      const rate = zone?.rates?.[parseInt(parts[3], 10)];
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Removed shipping rate '${rate?.name || parts[3]}' from '${zone?.name || "Zone"}'`,
        details: { oldValue },
      };
    }
    if (parts[2] === "rates" && parts.length >= 5) {
      const zone = storeState.shippingZones[parseInt(parts[1], 10)];
      const rate = zone?.rates?.[parseInt(parts[3], 10)];
      const field = parts.slice(4).join(".");
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Updated ${field} for rate '${rate?.name || parts[3]}' in '${zone?.name || "Zone"}'`,
        details: { oldValue, newValue: value },
      };
    }
    if (parts.length >= 3) {
      const zone = storeState.shippingZones[parseInt(parts[1], 10)];
      const field = parts.slice(2).join(".");
      return {
        category: "shipping",
        path,
        operation: op,
        summary: `Updated ${field} for shipping zone '${zone?.name || parts[1]}'`,
        details: { oldValue, newValue: value },
      };
    }
    return {
      category: "shipping",
      path,
      operation: op,
      summary: `Adjusted shipping configuration at ${path}`,
      details: { oldValue, newValue: value },
    };
  }

  // 4. Payment Providers
  if (path.startsWith("/paymentProviders")) {
    const parts = path.split("/").filter(Boolean);
    const providerIndex = parts[1];
    const provider = storeState.paymentProviders[parseInt(providerIndex, 10)];
    const providerName = provider ? provider.name : `Provider #${providerIndex}`;
    const field = parts.slice(2).join(".");

    if (field === "enabled") {
      return {
        category: "payments",
        path,
        operation: op,
        summary: value ? `Enabled payment gateway '${providerName}'` : `Disabled payment gateway '${providerName}'`,
        details: { oldValue, newValue: value },
      };
    }
    return {
      category: "payments",
      path,
      operation: op,
      summary: `Updated ${field} for '${providerName}' to ${value}`,
      details: { oldValue, newValue: value },
    };
  }

  // 5. Navigation
  if (path.startsWith("/navigation")) {
    return {
      category: "navigation",
      path,
      operation: op,
      summary: `Updated store navigation structure at ${path}`,
      details: { oldValue, newValue: value },
    };
  }

  // General fallback
  return {
    category: "general",
    path,
    operation: op,
    summary: `${op.toUpperCase()} at ${path}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
    details: { oldValue, newValue: value },
  };
}

export function generateSemanticDiff(
  originalStore: MtajirStore,
  patches: JsonPatchOperation[]
): SemanticChangeItem[] {
  const items: SemanticChangeItem[] = [];
  const workingStore: MtajirStore = JSON.parse(JSON.stringify(originalStore));

  for (const patch of patches) {
    if (isNoOpPatch(workingStore, patch)) {
      continue;
    }

    items.push(buildSemanticDiffItem(workingStore, patch));

    try {
      applyPatch(workingStore, [patch as Operation], false, false);
    } catch {
      // Ignore synthetic path errors if generateSemanticDiff is called standalone
    }
  }

  return items;
}
