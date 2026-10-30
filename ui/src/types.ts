export interface MtajirProduct {
  id: string;
  title: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  sku: string;
  inventory: number;
  status: "active" | "draft" | "archived";
  categories: string[];
}

export interface MtajirShippingRate {
  id: string;
  name: string;
  price: number;
  freeAboveAmount?: number;
}

export interface MtajirShippingZone {
  id: string;
  name: string;
  countries: string[];
  rates: MtajirShippingRate[];
}

export interface MtajirPaymentProvider {
  id: string;
  name: string;
  enabled: boolean;
  testMode: boolean;
}

export interface MtajirStore {
  id: string;
  name: string;
  slug: string;
  description: string;
  currency: string;
  locale: string;
  version: number;
  status: "active" | "draft" | "maintenance";
  theme: {
    logoUrl?: string;
    colors: {
      primary: string;
      secondary: string;
      background: string;
      text: string;
    };
    typography: {
      fontFamily: string;
      headingFont: string;
    };
    banner: {
      enabled: boolean;
      text: string;
      backgroundColor: string;
      linkUrl?: string;
    };
  };
  navigation: Array<{
    id: string;
    label: string;
    url: string;
    order: number;
    children?: any[];
  }>;
  products: MtajirProduct[];
  shippingZones: MtajirShippingZone[];
  paymentProviders: MtajirPaymentProvider[];
  policies?: {
    refundPolicy: string;
    shippingPolicy: string;
    termsOfService: string;
  };
  updatedAt: string;
}

export type SemanticChangeCategory =
  | "branding"
  | "catalog"
  | "shipping"
  | "payments"
  | "navigation"
  | "general";

export interface SemanticChangeItem {
  category: SemanticChangeCategory;
  path: string;
  operation: string;
  summary: string;
  details?: {
    oldValue?: any;
    newValue?: any;
  };
}

export interface JsonPatchOp {
  op: string;
  path: string;
  value?: any;
}

export interface StagingSession {
  sessionId: string;
  storeId: string;
  baseVersion: number;
  explanation: string;
  patches: JsonPatchOp[];
  semanticChanges: SemanticChangeItem[];
  stagedStore: MtajirStore;
  status: "pending" | "committed" | "rejected";
  createdAt: string;
}

export interface ChangelogEntry {
  version: number;
  timestamp: string;
  explanation: string;
  patches: JsonPatchOp[];
}

export interface TelemetrySummary {
  totalQueries: number;
  mutationsCount: number;
  questionsCount: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  stagedMutation?: StagingSession;
  navigationRoute?: string;
  timestamp: string;
}
