import { createApp } from "./app";
import { createSummaryAdapterFromEnv } from "./ai";
import { publishDueBriefingEditions } from "./editions";
import { D1Repository } from "./repository";
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
    for (const message of batch.messages) {
      try {
        await repo.completeProcessingJob(message.body.jobId, new Date());
        message.ack();
      } catch {
        message.ack();
      }
    }
  }
};

async function refreshEnabledPublicSources(env: Env): Promise<void> {
  const repo = new D1Repository(env.DB);
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
}
