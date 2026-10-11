import jsonpatch, { type Operation } from "fast-json-patch";
const applyPatch = jsonpatch.applyPatch;
import { JsonPatchOperation } from "../schema/patch.schema.js";
import { MtajirStore, MtajirStoreSchema } from "../schema/store.schema.js";
import { StoreRepository } from "../storage/store.repository.js";
import { generateSemanticDiff, SemanticChangeItem } from "../diff/semantic-diff.js";
import { compilePredicatePatches } from "../patch/patch-compiler.js";
import { z } from "zod";

export interface StagingSession {
  sessionId: string;
  storeId: string;
  baseVersion: number;
  explanation: string;
  patches: JsonPatchOperation[];
  semanticChanges: SemanticChangeItem[];
  stagedStore: MtajirStore;
  status: "pending" | "committed" | "rejected";
  createdAt: string;
}

export type StagingResult =
  | {
      success: true;
      session: StagingSession;
    }
  | {
      success: false;
      errorType: "NO_OP" | "CONCURRENCY_CONFLICT" | "PATCH_APPLICATION_ERROR" | "ZOD_VALIDATION_ERROR";
      errorMessage: string;
      zodIssues?: z.ZodIssue[];
      appliedPatches: JsonPatchOperation[];
    };

export class StagingService {
  private repository: StoreRepository;
  private activeSessions: Map<string, StagingSession> = new Map();

  constructor(repository: StoreRepository) {
    this.repository = repository;
  }

  async stageMutation(
    storeId: string,
    baseVersion: number,
    explanation: string,
    patches: JsonPatchOperation[]
  ): Promise<StagingResult> {
    const currentStore = await this.repository.getStore(storeId);
    if (!currentStore) {
      throw new Error(`Store '${storeId}' not found`);
    }

    // 1. Optimistic Concurrency Check
    if (currentStore.version !== baseVersion) {
      return {
        success: false,
        errorType: "CONCURRENCY_CONFLICT",
        errorMessage: `Store version conflict: base version was v${baseVersion}, but live store is now v${currentStore.version}.`,
        appliedPatches: patches,
      };
    }

    // 2. Clone store in-memory
    const cloned = JSON.parse(JSON.stringify(currentStore));

    // 3. Compile predicate paths (e.g. [id=cod]) to exact RFC 6902 index paths
    let compiledPatches: JsonPatchOperation[];
    try {
      compiledPatches = compilePredicatePatches(currentStore, patches);
    } catch (compileErr: any) {
      return {
        success: false,
        errorType: "PATCH_APPLICATION_ERROR",
        errorMessage: `Predicate path compilation failed: ${compileErr.message}`,
        appliedPatches: patches,
      };
    }

    // 4. Apply RFC 6902 JSON Patches
    try {
      applyPatch(cloned, compiledPatches as Operation[], true);
    } catch (patchErr: any) {
      return {
        success: false,
        errorType: "PATCH_APPLICATION_ERROR",
        errorMessage: `Failed to apply RFC 6902 JSON patch: ${patchErr.message}`,
        appliedPatches: compiledPatches,
      };
    }

    // 5. Validate post-patch state with Zod
    const validationResult = MtajirStoreSchema.safeParse(cloned);
    if (!validationResult.success) {
      return {
        success: false,
        errorType: "ZOD_VALIDATION_ERROR",
        errorMessage: "Staged store failed Zod schema validation",
        zodIssues: validationResult.error.issues,
        appliedPatches: compiledPatches,
      };
    }

    // 6. Build Semantic Diff
    const semanticChanges = generateSemanticDiff(currentStore, compiledPatches);

    // 7. Prevent No-Op / Redundant Modifications
    if (semanticChanges.length === 0) {
      return {
        success: false,
        errorType: "NO_OP",
        errorMessage: "No changes detected: the requested values match the current store state.",
        appliedPatches: compiledPatches,
      };
    }

    // 8. Create Staging Session
    const sessionId = `staging_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const session: StagingSession = {
      sessionId,
      storeId,
      baseVersion,
      explanation,
      patches: compiledPatches,
      semanticChanges,
      stagedStore: validationResult.data,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.activeSessions.set(sessionId, session);

    return {
      success: true,
      session,
    };
  }

  async commitSession(sessionId: string): Promise<MtajirStore> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Staging session '${sessionId}' not found`);
    }
    if (session.status !== "pending") {
      throw new Error(`Session '${sessionId}' is not pending (status: ${session.status})`);
    }

    const committed = await this.repository.commitNewVersion(
      session.storeId,
      session.stagedStore,
      session.explanation,
      session.patches
    );

    session.status = "committed";
    return committed;
  }

  rejectSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.status = "rejected";
    }
  }

  getSession(sessionId: string): StagingSession | undefined {
    return this.activeSessions.get(sessionId);
  }
}
