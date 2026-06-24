import { createApp } from "./app";
import { createEventReviewAdapterFromEnv, createSummaryAdapterFromEnv } from "./ai";
import { publishDueBriefingEditions } from "./editions";
import { processQueueMessage } from "./processor";
import { D1Repository } from "./repository";
import { runRetentionCleanup } from "./retention";
import { pollApifySourceRuns, refreshEnabledSources } from "./sources";
import type { Env, ProcessingJobMessage } from "./types";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshEnabledPublicSources(env));
  },
  async queue(batch: MessageBatch<ProcessingJobMessage>, env: Env): Promise<void> {
    const repo = new D1Repository(env.DB);
    const summaryAdapter = createSummaryAdapterFromEnv(env, repo);
    const reviewAdapter = createEventReviewAdapterFromEnv(env, repo);
    for (const message of batch.messages) {
      try {
        await processQueueMessage(repo, message.body, new Date(), summaryAdapter, reviewAdapter);
        message.ack();
      } catch (error) {
        console.error("Could not process queue job", {
          jobId: message.body.jobId,
          error: error instanceof Error ? error.message : String(error)
        });
        message.retry();
      }
    }
  }
};

async function refreshEnabledPublicSources(env: Env): Promise<void> {
  const repo = new D1Repository(env.DB);
  try {
    await runRetentionCleanup(repo, env.RAW_ARCHIVE, new Date());
  } catch (error) {
    console.warn("Could not run retention cleanup", error);
  }

  try {
    await publishDueBriefingEditions({
      repo,
      briefings: await repo.listBriefings(),
      now: new Date(),
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
      env
    });
  } catch (error) {
    console.warn("Could not poll Apify source runs", error);
  }

  const briefings = await repo.listBriefings();

  for (const briefing of briefings) {
    try {
      await refreshEnabledSources({
        briefing,
        repo,
        bucket: env.RAW_ARCHIVE,
        queue: env.PROCESSING_QUEUE,
        env
      });
    } catch (error) {
      console.warn(`Could not refresh sources for briefing ${briefing.id}`, error);
    }
  }
}
