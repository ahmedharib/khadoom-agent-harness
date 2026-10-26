export { KhadoomAgent } from "./agent/khadoom.agent.js";
export type { AgentResponse, AgentTelemetry } from "./agent/khadoom.agent.js";

export {
  MtajirStoreSchema,
  StoreThemeSchema,
  ProductSchema,
  ShippingZoneSchema,
  ShippingRateSchema,
  PaymentProviderSchema,
  NavigationItemSchema,
  ColorSchema,
} from "./schema/store.schema.js";
export type {
  MtajirStore,
  StoreTheme,
  Product,
  ShippingZone,
  PaymentProvider,
  NavigationItem,
} from "./schema/store.schema.js";

export {
  JsonPatchOperationSchema,
  MutationPlanSchema,
} from "./schema/patch.schema.js";
export type { JsonPatchOperation, MutationPlan } from "./schema/patch.schema.js";

export { StagingService } from "./staging/staging.service.js";
export type { StagingSession, StagingResult } from "./staging/staging.service.js";

export { StoreRepository } from "./storage/store.repository.js";
export type { VersionChangelogEntry } from "./storage/store.repository.js";

export {
  DocsService,
  FileEmbeddingsStore,
  InMemoryEmbeddingsStore,
} from "./rag/docs.service.js";
export type {
  SearchDocsOptions,
  DocSearchResult,
  CachedDocAnswer,
  EmbeddingsStore,
  DocChunk,
  StoreConstraintContext,
} from "./rag/docs.service.js";
export { loadDocumentationCorpus } from "./rag/doc-loader.js";

export { generateSemanticDiff } from "./diff/semantic-diff.js";
export type { SemanticChangeItem } from "./diff/semantic-diff.js";

export {
  compilePredicatePatches,
  compilePredicatePath,
  expandSemanticPath,
  getValueAtPath,
} from "./patch/patch-compiler.js";

export { QueryLoggerService, calculateCost } from "./telemetry/query-logger.js";
export type {
  TokenUsage,
  CostBreakdown,
  QueryLogEntry,
  UsageSummary,
  QueryIntentType,
} from "./telemetry/query-logger.js";
