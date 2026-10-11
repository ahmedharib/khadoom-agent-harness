import { JsonPatchOperation } from "../schema/patch.schema.js";
import { MtajirStore } from "../schema/store.schema.js";

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

export function generateSemanticDiff(
  originalStore: MtajirStore,
  patches: JsonPatchOperation[]
): SemanticChangeItem[] {
  const items: SemanticChangeItem[] = [];

  for (const patch of patches) {
    if (isNoOpPatch(originalStore, patch)) {
      continue;
    }

    const { op, path, value } = patch;
    const oldValue = getValueAtPath(originalStore, path);

    // 1. Theme / Branding changes
    if (path.startsWith("/theme/colors/")) {
      const colorKey = path.split("/")[3];
      items.push({
        category: "branding",
        path,
        operation: op,
        summary: `Changed ${colorKey} theme color from '${oldValue}' to '${value}'`,
        details: { oldValue, newValue: value },
      });
      continue;
    }

    if (path.startsWith("/theme/banner/")) {
      const bannerKey = path.split("/")[3];
      if (bannerKey === "enabled") {
        items.push({
          category: "branding",
          path,
          operation: op,
          summary: value ? "Enabled promotional announcement banner" : "Disabled announcement banner",
          details: { oldValue, newValue: value },
        });
      } else {
        items.push({
          category: "branding",
          path,
          operation: op,
          summary: `Updated banner ${bannerKey} to '${value}'`,
          details: { oldValue, newValue: value },
        });
      }
      continue;
    }

    if (path.startsWith("/theme/typography/")) {
      const typeKey = path.split("/")[3];
      items.push({
        category: "branding",
        path,
        operation: op,
        summary: `Updated ${typeKey} font to '${value}'`,
        details: { oldValue, newValue: value },
      });
      continue;
    }

    // 2. Catalog / Products
    if (path.startsWith("/products")) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 1 && op === "add") {
        items.push({
          category: "catalog",
          path,
          operation: op,
          summary: `Added new product '${value?.title || "Item"}' (Price: ${value?.price || 0})`,
          details: { newValue: value },
        });
      } else if (parts.length >= 3) {
        const prodIndex = parts[1];
        const field = parts.slice(2).join(".");
        const prod = originalStore.products[parseInt(prodIndex, 10)];
        const prodTitle = prod ? prod.title : `Product #${prodIndex}`;
        items.push({
          category: "catalog",
          path,
          operation: op,
          summary: `Updated ${field} for '${prodTitle}' from '${oldValue}' to '${value}'`,
          details: { oldValue, newValue: value },
        });
      } else {
        items.push({
          category: "catalog",
          path,
          operation: op,
          summary: `Modified products collection at ${path}`,
          details: { oldValue, newValue: value },
        });
      }
      continue;
    }

    // 3. Shipping Zones & Rates
    if (path.startsWith("/shippingZones")) {
      items.push({
        category: "shipping",
        path,
        operation: op,
        summary: `Adjusted shipping configuration at ${path} to ${JSON.stringify(value)}`,
        details: { oldValue, newValue: value },
      });
      continue;
    }

    // 4. Payment Providers
    if (path.startsWith("/paymentProviders")) {
      const parts = path.split("/").filter(Boolean);
      const providerIndex = parts[1];
      const provider = originalStore.paymentProviders[parseInt(providerIndex, 10)];
      const providerName = provider ? provider.name : `Provider #${providerIndex}`;
      const field = parts.slice(2).join(".");

      if (field === "enabled") {
        items.push({
          category: "payments",
          path,
          operation: op,
          summary: value ? `Enabled payment gateway '${providerName}'` : `Disabled payment gateway '${providerName}'`,
          details: { oldValue, newValue: value },
        });
      } else {
        items.push({
          category: "payments",
          path,
          operation: op,
          summary: `Updated ${field} for '${providerName}' to ${value}`,
          details: { oldValue, newValue: value },
        });
      }
      continue;
    }

    // 5. Navigation
    if (path.startsWith("/navigation")) {
      items.push({
        category: "navigation",
        path,
        operation: op,
        summary: `Updated store navigation structure at ${path}`,
        details: { oldValue, newValue: value },
      });
      continue;
    }

    // General fallback
    items.push({
      category: "general",
      path,
      operation: op,
      summary: `${op.toUpperCase()} at ${path}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
      details: { oldValue, newValue: value },
    });
  }

  return items;
}
