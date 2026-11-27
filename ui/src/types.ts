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

export interface ModelBenchmarkSummary {
  queries: number;
  providerType: "openai_api" | "custom_endpoint" | "mixed";
  avgPromptTokens: number;
  avgCompletionTokens: number;
  cacheHitRatePct: number;
  totalCostUsd: number;
  avgCostPerQueryUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgLlmLatencyMs: number;
  avgTokensPerSecond: number;
  avgMsPerOutputToken: number;
  avgLlmCallsPerQuery: number;
  retryRatePct: number;
  jsonParseErrorCount: number;
  errorRatePct: number;
  semanticCacheHits: number;
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
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  avgLlmLatencyMs?: number;
  avgTokensPerSecond?: number;
  avgMsPerOutputToken?: number;
  avgLlmCallsPerQuery?: number;
  totalRetries?: number;
  totalJsonParseErrors?: number;
  semanticCacheHits?: number;
  cacheHitRatePct?: number;
  byModel?: Record<string, ModelBenchmarkSummary>;
}

export interface ModelConfigInfo {
  model: string;
  baseURL?: string;
  isCustomEndpoint: boolean;
  disableThinking: boolean;
}

export type ModelPairId = "commercial" | "local";
export type RerankerMode = "none" | "local" | "commercial";

export interface RouterOptionStatus<T extends string = string> {
  id: T;
  label: string;
  subtitle: string;
  active: boolean;
  reason?: string;
}

export interface RouterState {
  selectedPair: ModelPairId;
  selectedReranker: RerankerMode;
  vectorDb: {
    mode: "qdrant" | "file";
    url?: string;
    activeCollection: string;
  };
  modelPairs: RouterOptionStatus<ModelPairId>[];
  rerankers: RouterOptionStatus<RerankerMode>[];
}

export interface CitationPassage {
  chunkId: string;
  sectionHeader: string;
  content: string;
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

export interface AgentStep {
  id: string;
  label: string;
  toolName?: string;
  detail?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
}

export interface AgentTurnTelemetry {
  model: string;
  providerType?: string;
  latencyMs: number;
  llmLatencyMs?: number;
  llmCallsCount?: number;
  tokensPerSecond?: number;
  msPerOutputToken?: number;
  executedTools?: string[];
  semanticCacheHit: boolean;
  usage: {
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
  };
  cost: {
    totalCostUsd: number;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  citationDetails?: CitationDetail[];
  stagedMutation?: StagingSession;
  navigationRoute?: string;
  steps?: AgentStep[];
  telemetry?: AgentTurnTelemetry;
  timestamp: string;
}
