import { createApp } from "./app";
import { createEventReviewAdapterFromEnv, createSummaryAdapterFromEnv } from "./ai";
import { publishDueBriefingEditions } from "./editions";
import { processQueueMessage } from "./processor";
import { D1Repository } from "./repository";
import { runRetentionCleanup } from "./retention";
import { enqueueDueSourceRefreshJobs, pollApifySourceRuns, refreshSourceById } from "./sources";
import type { DistilledQueueMessage, Env, ProcessingJobMessage, Repository, SourceRefreshJobMessage } from "./types";

const app = createApp();
const MAX_QUEUE_ATTEMPTS = 5;
const STALE_PROCESSING_JOB_REQUEUE_AGE_MS = 10 * 60 * 1000;
const STALE_PROCESSING_JOB_REQUEUE_LIMIT = 25;
const SLOW_QUEUE_JOB_MS = 10_000;

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
  async queue(batch: MessageBatch<DistilledQueueMessage>, env: Env): Promise<void> {
    const repo = new D1Repository(env.DB);
    const summaryAdapter = createSummaryAdapterFromEnv(env, repo);
    const reviewAdapter = createEventReviewAdapterFromEnv(env, repo);
    for (const message of batch.messages) {
      const startedAt = Date.now();
      const bodyType = queueBodyType(message.body);
      const bodyId = queueBodyId(message.body);
      try {
        await processDistilledQueueMessage(repo, env, message.body, summaryAdapter, reviewAdapter);
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_QUEUE_JOB_MS) {
          console.warn("Slow queue job completed", {
            messageId: message.id,
            attempts: message.attempts,
            bodyType,
            bodyId,
            durationMs
          });
        }
        message.ack();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const shouldQuarantine = shouldQuarantineQueueFailure(error, message.attempts);
        await recordQueueFailure(repo, message.body, errorMessage, shouldQuarantine);
        console.error(shouldQuarantine ? "Quarantined queue job" : "Retrying queue job", {
          messageId: message.id,
          attempts: message.attempts,
          bodyType,
          bodyId,
          durationMs: Date.now() - startedAt,
          permanent: isPermanentQueueError(error),
          quarantined: shouldQuarantine,
          error: errorMessage
        });
        if (shouldQuarantine) {
          message.ack();
        } else {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        }
      }
    }
  }
};

async function processDistilledQueueMessage(
  repo: Repository,
  env: Env,
  body: unknown,
  summaryAdapter: ReturnType<typeof createSummaryAdapterFromEnv>,
  reviewAdapter: ReturnType<typeof createEventReviewAdapterFromEnv>
): Promise<void> {
  if (isSourceRefreshJobMessage(body)) {
    const briefing = await repo.getBriefingById(body.briefingId);
    if (!briefing) throw new PermanentQueueError("Briefing not found.");
    await refreshSourceById({
      briefing,
      sourceId: body.sourceId,
      repo,
      bucket: env.RAW_ARCHIVE,
      queue: env.PROCESSING_QUEUE,
      env,
      now: new Date(),
      force: body.force
    });
    return;
  }

  if (isProcessingJobMessage(body)) {
    await processQueueMessage(repo, body, new Date(), summaryAdapter, reviewAdapter);
    return;
  }

  throw new PermanentQueueError("Invalid queue message.");
}

async function recordQueueFailure(
  repo: Repository,
  body: unknown,
  error: string,
  quarantined: boolean
): Promise<void> {
  const message = quarantined ? `Quarantined after repeated queue failures: ${error}` : error;
  if (isProcessingJobMessage(body)) {
    await repo.failProcessingJob(body.jobId, message);
    return;
  }
  if (isSourceRefreshJobMessage(body)) {
    await repo.updateSourceState({ sourceId: body.sourceId, lastError: sourceFailureMessage(error, quarantined) });
    if (quarantined) await repo.setSourceEnabled(body.sourceId, false);
  }
}

function sourceFailureMessage(error: string, quarantined: boolean): string {
  return quarantined ? `Paused after repeated source failures: ${error}` : error;
}

function isProcessingJobMessage(body: unknown): body is ProcessingJobMessage {
  if (!isRecord(body)) return false;
  return (!("type" in body) || body.type === undefined || body.type === "process_raw_message") &&
    typeof body.jobId === "string" &&
    typeof body.briefingId === "string" &&
    typeof body.rawMessageId === "string";
}

function isSourceRefreshJobMessage(body: unknown): body is SourceRefreshJobMessage {
  if (!isRecord(body)) return false;
  return body.type === "refresh_source" &&
    typeof body.briefingId === "string" &&
    typeof body.sourceId === "string";
}

class PermanentQueueError extends Error {}

function isPermanentQueueError(error: unknown): boolean {
  if (error instanceof PermanentQueueError) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/(not found|missing|not configured|unsupported source provider|invalid queue message)/i.test(message)) return true;
  const status = message.match(/:\s*(\d{3})\b/)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code >= 400 && code < 500 && ![408, 409, 425, 429].includes(code);
}

export function shouldQuarantineQueueFailure(error: unknown, attempts: number): boolean {
  return isPermanentQueueError(error) || attempts >= MAX_QUEUE_ATTEMPTS;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, Math.max(30, attempts * 60));
}

function queueBodyType(body: unknown): string {
  if (isRecord(body) && typeof body.type === "string") return body.type;
  return "process_raw_message";
}

function queueBodyId(body: unknown): string | undefined {
  if (isProcessingJobMessage(body)) return body.jobId;
  if (isSourceRefreshJobMessage(body)) return body.sourceId;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function runScheduledMaintenance(env: Env): Promise<void> {
  const repo = new D1Repository(env.DB);
  const now = new Date();
  try {
    await runRetentionCleanup(repo, env.RAW_ARCHIVE, now);
  } catch (error) {
    console.warn("Could not run retention cleanup", error);
  }

  try {
    await publishDueBriefingEditions({
      repo,
      briefings: await repo.listBriefings(),
      now,
      summaryAdapter: createSummaryAdapterFromEnv(env, repo)
    });
  } catch (error) {
    console.error("Could not publish briefing editions", error);
  }

  try {
    await pollApifySourceRuns({
      repo,
      bucket: env.RAW_ARCHIVE,
      queue: env.PROCESSING_QUEUE,
      env,
      now
    });
  } catch (error) {
    console.warn("Could not poll Apify source runs", error);
  }

  try {
    const rescued = await rescueStaleProcessingJobs(repo, env.PROCESSING_QUEUE, now);
    if (rescued > 0) console.log("Requeued stale processing jobs", { rescued });
  } catch (error) {
    console.warn("Could not requeue stale processing jobs", error);
  }

  const briefings = await repo.listBriefings();
  let enqueued = 0;

  for (const briefing of briefings) {
    try {
      enqueued += await enqueueDueSourceRefreshJobs({
        briefing,
        repo,
        queue: env.PROCESSING_QUEUE,
        now
      });
    } catch (error) {
      console.warn(`Could not enqueue source refreshes for briefing ${briefing.id}`, error);
    }
  }
  if (enqueued > 0) console.log("Enqueued scheduled source refresh jobs", { enqueued });
}

async function rescueStaleProcessingJobs(
  repo: Repository,
  queue: { send(message: ProcessingJobMessage): Promise<unknown> },
  now: Date
): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_JOB_REQUEUE_AGE_MS).toISOString();
  const jobs = await repo.listProcessingJobs({
    states: ["queued"],
    updatedBefore: staleBefore,
    order: "oldest",
    limit: STALE_PROCESSING_JOB_REQUEUE_LIMIT
  });
  let rescued = 0;

  for (const job of jobs) {
    await queue.send({
      type: "process_raw_message",
      jobId: job.id,
      briefingId: job.briefingId,
      rawMessageId: job.rawMessageId
    });
    await repo.requeueProcessingJob(job.id, now);
    rescued += 1;
  }

  return rescued;
}
