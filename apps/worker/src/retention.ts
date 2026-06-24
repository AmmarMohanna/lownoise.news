import type { Repository } from "./types";

export interface RetentionArchiveBucket {
  delete(key: string): Promise<unknown>;
}

export interface RetentionResult {
  deleted: number;
  archivesDeleted: number;
  archiveDeleteFailures: number;
}

export async function runRetentionCleanup(
  repo: Repository,
  bucket: RetentionArchiveBucket,
  now = new Date()
): Promise<RetentionResult> {
  const archiveKeys = await repo.listExpiredRawPayloadKeys(now);
  const deleted = await repo.deleteExpired(now);
  let archivesDeleted = 0;
  let archiveDeleteFailures = 0;

  for (const key of archiveKeys) {
    try {
      await bucket.delete(key);
      archivesDeleted += 1;
    } catch (error) {
      archiveDeleteFailures += 1;
      console.warn("Could not delete expired raw archive", { key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { deleted, archivesDeleted, archiveDeleteFailures };
}
