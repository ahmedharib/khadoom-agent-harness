export interface DocArticle {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
}

export const MTAJIR_DOCUMENTATION: DocArticle[] = [
  {
    id: "doc_theme_customization",
    category: "Design & Themes",
    title: "Customizing Store Colors and Typography",
    content:
      "Mtajir stores support full hex code customization for Primary, Secondary, Background, and Text colors. The theme banner can be toggled on or off to announce flash sales or shipping notices. Fonts can be set for headings and body independently.",
    tags: ["theme", "colors", "font", "banner", "branding", "logo"],
  },
  {
    id: "doc_payment_providers",
    category: "Payments",
    title: "Configuring Payment Gateways in Mtajir",
    content:
      "Mtajir supports Mada, Apple Pay, Credit Card (Visa/Mastercard), Tabby, and Cash on Delivery (COD). Gateways can be enabled, disabled, or set into test mode before launching to the public.",
    tags: ["payment", "mada", "apple pay", "tabby", "credit card", "checkout"],
  },
  {
    id: "doc_shipping_zones",
    category: "Shipping",
    title: "Setting Up Shipping Zones and Rates",
    content:
      "Shipping is configured through geographical zones (e.g. Saudi Arabia, GCC, International). Each zone can contain multiple tiered rates (such as Standard and Express Delivery). You can also set free shipping thresholds (e.g., Free delivery on orders over 200 SAR).",
    tags: ["shipping", "delivery", "rates", "zones", "free shipping"],
  },
  {
    id: "doc_products_inventory",
    category: "Catalog",
    title: "Managing Products, SKUs, and Stock",
    content:
      "Every product in Mtajir requires a unique SKU, price, title, and initial stock count. Products can be categorized into collections and marked as 'active', 'draft', or 'archived'.",
    tags: ["products", "sku", "inventory", "stock", "catalog"],
  },
  {
    id: "doc_version_rollback",
    category: "System",
    title: "Store Versioning and Safe Rollbacks",
    content:
      "Every time a store update is accepted in the staging phase, Mtajir automatically snapshots the entire store state into an immutable version. If you make a mistake, you can roll back to any previous version in one click without data loss.",
    tags: ["versioning", "rollback", "snapshots", "history", "staging"],
  },
];

export class DocsService {
  private cache: Map<string, string> = new Map();

  searchDocs(query: string): DocArticle[] {
    const q = query.toLowerCase();
    const scored: { doc: DocArticle; score: number }[] = [];

    for (const doc of MTAJIR_DOCUMENTATION) {
      let score = 0;
      if (doc.title.toLowerCase().includes(q)) score += 10;
      if (doc.tags.some((tag) => tag.toLowerCase().includes(q))) score += 5;
      if (doc.content.toLowerCase().includes(q)) score += 1;

      if (score > 0) {
        scored.push({ doc, score });
      }
    }

    return scored.sort((a, b) => b.score - a.score).map((s) => s.doc);
  }

  getCachedAnswer(query: string): string | undefined {
    return this.cache.get(query.trim().toLowerCase());
  }

  setCachedAnswer(query: string, answer: string): void {
    this.cache.set(query.trim().toLowerCase(), answer);
  }
}
