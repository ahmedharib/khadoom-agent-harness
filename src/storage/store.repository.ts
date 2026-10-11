import fs from "node:fs/promises";
import path from "node:path";
import { MtajirStore, MtajirStoreSchema } from "../schema/store.schema.js";
import { JsonPatchOperation } from "../schema/patch.schema.js";

export interface VersionChangelogEntry {
  version: number;
  timestamp: string;
  explanation: string;
  patches: JsonPatchOperation[];
}

export class StoreRepository {
  private baseDir: string;

  constructor(baseDir = path.join(process.cwd(), "data", "stores")) {
    this.baseDir = baseDir;
  }

  private getStoreFilePath(storeId: string): string {
    return path.join(this.baseDir, `${storeId}.json`);
  }

  private getStoreSnapshotsDir(storeId: string): string {
    return path.join(this.baseDir, storeId, "snapshots");
  }

  private getChangelogPath(storeId: string): string {
    return path.join(this.baseDir, storeId, "changelog.json");
  }

  async ensureDirectories(storeId: string): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(this.getStoreSnapshotsDir(storeId), { recursive: true });
  }

  async getStore(storeId: string): Promise<MtajirStore | null> {
    const filePath = this.getStoreFilePath(storeId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);
      return MtajirStoreSchema.parse(parsed);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async saveInitialStore(store: MtajirStore): Promise<MtajirStore> {
    const validated = MtajirStoreSchema.parse(store);
    await this.ensureDirectories(validated.id);

    // Save live store
    await fs.writeFile(
      this.getStoreFilePath(validated.id),
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    // Save v1 snapshot
    const snapshotPath = path.join(
      this.getStoreSnapshotsDir(validated.id),
      `v${validated.version}.json`
    );
    await fs.writeFile(snapshotPath, JSON.stringify(validated, null, 2), "utf-8");

    // Initialize changelog
    const initialChangelog: VersionChangelogEntry[] = [
      {
        version: validated.version,
        timestamp: validated.updatedAt,
        explanation: "Initial store creation (v1)",
        patches: [],
      },
    ];
    await fs.writeFile(
      this.getChangelogPath(validated.id),
      JSON.stringify(initialChangelog, null, 2),
      "utf-8"
    );

    return validated;
  }

  async commitNewVersion(
    storeId: string,
    updatedStore: MtajirStore,
    explanation: string,
    appliedPatches: JsonPatchOperation[]
  ): Promise<MtajirStore> {
    const current = await this.getStore(storeId);
    if (!current) {
      throw new Error(`Store with id '${storeId}' does not exist`);
    }

    // Load changelog to compute the high-water mark version
    let changelog: VersionChangelogEntry[] = [];
    try {
      const existingChangelog = await fs.readFile(this.getChangelogPath(storeId), "utf-8");
      changelog = JSON.parse(existingChangelog);
    } catch {
      changelog = [];
    }

    // High-water mark: strictly increment past the highest version number ever created
    const highestRecordedVersion = changelog.reduce(
      (max, entry) => Math.max(max, entry.version),
      current.version
    );
    const nextVersion = highestRecordedVersion + 1;

    updatedStore.version = nextVersion;
    updatedStore.updatedAt = new Date().toISOString();

    const validated = MtajirStoreSchema.parse(updatedStore);

    // Write updated live store
    await fs.writeFile(
      this.getStoreFilePath(storeId),
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    // Save snapshot for the new unique version
    const snapshotPath = path.join(
      this.getStoreSnapshotsDir(storeId),
      `v${validated.version}.json`
    );
    await fs.writeFile(snapshotPath, JSON.stringify(validated, null, 2), "utf-8");

    // Append to changelog (with base version reference if it diverged from latest)
    const baseNote =
      current.version !== highestRecordedVersion
        ? ` [based on rollback to v${current.version}]`
        : "";

    changelog.push({
      version: validated.version,
      timestamp: validated.updatedAt,
      explanation: `${explanation}${baseNote}`,
      patches: appliedPatches,
    });

    await fs.writeFile(
      this.getChangelogPath(storeId),
      JSON.stringify(changelog, null, 2),
      "utf-8"
    );

    return validated;
  }

  async rollbackToVersion(storeId: string, targetVersion: number): Promise<MtajirStore> {
    const snapshotPath = path.join(
      this.getStoreSnapshotsDir(storeId),
      `v${targetVersion}.json`
    );

    let snapshotData: string;
    try {
      snapshotData = await fs.readFile(snapshotPath, "utf-8");
    } catch {
      throw new Error(`Snapshot v${targetVersion} not found for store '${storeId}'`);
    }

    const current = await this.getStore(storeId);
    if (!current) {
      throw new Error(`Store '${storeId}' does not exist`);
    }

    const restoredStore: MtajirStore = JSON.parse(snapshotData);
    // Restore directly to targetVersion without creating a new version
    restoredStore.version = targetVersion;
    restoredStore.updatedAt = new Date().toISOString();

    const validated = MtajirStoreSchema.parse(restoredStore);

    // Overwrite the live store file
    await fs.writeFile(
      this.getStoreFilePath(storeId),
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    // Preserve full changelog history so past snapshots are never lost,
    // and record an audit log entry for the rollback event
    let changelog: VersionChangelogEntry[] = [];
    try {
      changelog = JSON.parse(await fs.readFile(this.getChangelogPath(storeId), "utf-8"));
    } catch {
      changelog = [];
    }

    changelog.push({
      version: targetVersion,
      timestamp: validated.updatedAt,
      explanation: `Rolled back live store to state of v${targetVersion}`,
      patches: [],
    });

    await fs.writeFile(
      this.getChangelogPath(storeId),
      JSON.stringify(changelog, null, 2),
      "utf-8"
    );

    return validated;
  }

  async getChangelog(storeId: string): Promise<VersionChangelogEntry[]> {
    try {
      const data = await fs.readFile(this.getChangelogPath(storeId), "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}
