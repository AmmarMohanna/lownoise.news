import type { BriefingConfig, NormalizedMessage } from "@distilled/core";
import {
  buildGoogleNewsRssUrl,
  defaultActorIdForKind,
  detectSourceInput,
  normalizeApifyDatasetItems,
  parseGoogleNewsRssFeed,
  parseRssFeed,
  type DetectedSourceInput
} from "@distilled/connectors";
import { ingestPublicTelegramChannel, type PublicTelegramIngestResult } from "./publicTelegram";
import type {
  Env,
  ProcessingJobMessage,
  Repository,
  SourceRecord,
  SourceRefreshJobMessage,
  SourceRunRecord
} from "./types";

const RSS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const GOOGLE_NEWS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const GOOGLE_NEWS_ERROR_BACKOFF_MS = 6 * HOUR_MS;
// Apify rejects pay-per-result run-level caps below its minimum run charge.
// Actor input still keeps the requested product cap at 20 X tweets.
const APIFY_MINIMUM_RUN_CHARGE_USD = 0.02;
const GOOGLE_NEWS_APIFY_FALLBACK_ACTOR_ID = "groupoject/google-news-scraper";
const GOOGLE_NEWS_APIFY_FALLBACK_INTERVAL_MS = 3 * HOUR_MS;
const GOOGLE_NEWS_APIFY_FALLBACK_MAX_ITEMS = 20;
const GOOGLE_NEWS_APIFY_FALLBACK_ESTIMATED_COST_USD = APIFY_MINIMUM_RUN_CHARGE_USD;
const GOOGLE_NEWS_APIFY_FALLBACK_SOURCE_DAILY_COST_LIMIT_USD = 0.08;
const GOOGLE_NEWS_APIFY_FALLBACK_BRIEFING_DAILY_COST_LIMIT_USD = 0.40;
const PROCESSING_BACKLOG_REFRESH_PAUSE_LIMIT = 500;
const X_MAX_ITEMS = 20;
const X_PRICE_PER_1000_TWEETS_USD = 0.18;

export type SourceIngestResult = PublicTelegramIngestResult & {
  provider?: SourceRecord["provider"];
  kind?: SourceRecord["kind"];
  runStarted?: boolean;
};

export interface SourceRefreshInput {
  briefing: BriefingConfig;
  repo: Repository;
  bucket: { put(key: string, value: string, options?: unknown): Promise<unknown> };
  queue: { send(message: ProcessingJobMessage): Promise<unknown> };
  env?: Partial<Env>;
  fetcher?: typeof fetch;
  now?: Date;
  force?: boolean;
}

export interface SourceRefreshDispatchInput {
  briefing: BriefingConfig;
  repo: Repository;
  queue: { send(message: SourceRefreshJobMessage): Promise<unknown> };
  now?: Date;
  force?: boolean;
}

export async function addSourceFromInput(input: SourceRefreshInput & { sourceInput: string }): Promise<SourceIngestResult> {
  const detected = detectSourceInput(input.sourceInput);
  if (detected.provider === "telegram") {
    return ingestPublicTelegramChannel({ ...input, url: detected.sourceUrl, activateSource: true });
  }

  const source = await upsertDetectedSource(input.repo, input.briefing.id, detected, input.env ?? {}, input.now);
  if (detected.provider === "rss") {
    return ingestRssSource({ ...input, source });
  }

  const now = input.now ?? new Date();
  return (await startCappedApifySourceRun({ ...input, source, now })) ?? skippedApifySourceRun(source);
}

export async function refreshEnabledSources(input: SourceRefreshInput): Promise<SourceIngestResult[]> {
  if (input.briefing.paused) return [];

  const now = input.now ?? new Date();
  const sources = (await input.repo.listSources(input.briefing.id)).filter((source) => source.enabled);
  const results: SourceIngestResult[] = [];

  for (const source of sources) {
    if (!input.force && !isSourceRefreshDue(input.briefing, source, now)) continue;
    const result = await refreshSource({ ...input, source, now });
    if (result) results.push(result);
  }

  return results;
}

export async function enqueueDueSourceRefreshJobs(input: SourceRefreshDispatchInput): Promise<number> {
  if (input.briefing.paused) return 0;
  if (!input.force && await hasLargeProcessingBacklog(input.repo, input.briefing.id)) return 0;

  const now = input.now ?? new Date();
  const sources = (await input.repo.listSources(input.briefing.id)).filter((source) => source.enabled);
  let enqueued = 0;

  for (const source of sources) {
    if (!input.force && !isSourceRefreshDue(input.briefing, source, now)) continue;
    if ((source.provider === "apify" || source.kind === "google_news") && await hasActiveApifyRun(input.repo, source.id)) continue;

    await input.repo.updateSourceState({
      sourceId: source.id,
      lastCheckedAt: now.toISOString(),
      lastError: nullError()
    }, now);
    await input.queue.send({
      type: "refresh_source",
      briefingId: input.briefing.id,
      sourceId: source.id,
      force: input.force || undefined
    });
    enqueued += 1;
  }

  return enqueued;
}

export async function refreshSourceById(input: SourceRefreshInput & { sourceId: string }): Promise<SourceIngestResult | undefined> {
  const source = await input.repo.getSource(input.sourceId);
  if (!source) throw new Error("Source not found.");
  return refreshSource({ ...input, source });
}

async function refreshSource(input: SourceRefreshInput & { source: SourceRecord }): Promise<SourceIngestResult | undefined> {
  if (input.briefing.paused || !input.source.enabled) return undefined;
  const now = input.now ?? new Date();

  if (input.source.provider === "telegram") {
    if (!input.source.url) throw new Error("Telegram source URL is missing.");
    return ingestPublicTelegramChannel({ ...input, source: input.source, url: input.source.url, now });
  }

  if (input.source.kind === "google_news") {
    return ingestRssSource({ ...input, source: input.source, now });
  }

  if (input.source.provider === "rss") {
    if (!input.source.sourceUrl && !input.source.url) throw new Error("RSS source URL is missing.");
    return ingestRssSource({ ...input, source: input.source, now });
  }

  if (input.source.provider === "apify") {
    if (await hasActiveApifyRun(input.repo, input.source.id)) return undefined;
    return startCappedApifySourceRun({ ...input, source: input.source, now });
  }

  throw new Error(`Unsupported source provider: ${input.source.provider}`);
}

export async function pollApifySourceRuns(input: Omit<SourceRefreshInput, "briefing">): Promise<void> {
  const runs = await input.repo.listSourceRuns({ states: ["queued", "running"], limit: 25 });
  for (const run of runs) {
    const source = await input.repo.getSource(run.sourceId);
    const briefing = await input.repo.getBriefingById(run.briefingId);
    if (!source || !briefing) {
      await input.repo.updateSourceRun({ id: run.id, state: "failed", error: "Source or briefing not found", completedAt: new Date().toISOString() });
      continue;
    }

    try {
      await pollApifySourceRun({ ...input, briefing, source, run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Apify polling error";
      await input.repo.updateSourceRun({
        id: run.id,
        state: "failed",
        error: message,
        completedAt: new Date().toISOString()
      });
      await input.repo.updateSourceState({ sourceId: source.id, lastError: message });
    }
  }
}

async function upsertDetectedSource(
  repo: Repository,
  briefingId: string,
  detected: DetectedSourceInput,
  env: Partial<Env>,
  now = new Date()
): Promise<SourceRecord> {
  const actorId = detected.provider === "apify"
    ? ("actorId" in detected ? detected.actorId : undefined) ?? defaultActorIdForKind(detected.kind, env)
    : undefined;
  if (detected.provider === "apify" && !actorId) {
    throw new Error(`No Apify actor is configured for ${detected.kind}.`);
  }

  return repo.upsertConfiguredSource({
    briefingId,
    title: detected.title,
    provider: detected.provider,
    kind: detected.kind,
    username: "username" in detected ? detected.username : undefined,
    input: detected.input,
    url: "sourceUrl" in detected ? detected.sourceUrl : undefined,
    sourceUrl: "sourceUrl" in detected ? detected.sourceUrl : undefined,
    actorId,
    actorInput: "actorInput" in detected ? detected.actorInput : undefined,
    enabled: true
  }, now);
}

async function ingestRssSource(input: SourceRefreshInput & { source: SourceRecord }): Promise<SourceIngestResult> {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();
  const isGoogleNews = input.source.kind === "google_news";
  const url = isGoogleNews ? googleNewsSourceUrl(input.source) : input.source.sourceUrl ?? input.source.url;
  if (!url) throw new Error(isGoogleNews ? "Google News RSS source URL is missing." : "RSS source URL is missing.");

  const response = await fetcher(url, {
    headers: rssRequestHeaders(isGoogleNews)
  });
  if (!response.ok) {
    const message = `Could not fetch ${isGoogleNews ? "Google News RSS" : "RSS"} source: ${response.status}`;
    if (isGoogleNews && isRetryableGoogleNewsStatus(response.status)) {
      const fallback = await startGoogleNewsApifyFallback({ ...input, source: input.source, now, rssError: message });
      if (fallback) return fallback;
    }
    throw new Error(message);
  }

  const xml = await response.text();
  const rawPayloadKey = `${isGoogleNews ? "google-news" : "rss"}/${input.briefing.id}/${input.source.id}/${now.getTime()}.xml`;
  await input.bucket.put(rawPayloadKey, xml, {
    httpMetadata: { contentType: "application/rss+xml; charset=utf-8" }
  });

  const parser = isGoogleNews ? parseGoogleNewsRssFeed : parseRssFeed;
  const messages = parser(xml, {
    sourceId: input.source.id,
    sourceTitle: input.source.title,
    sourceUrl: url,
    receivedAt: now,
    retentionDays: input.briefing.retentionDays,
    rawPayloadKey
  });
  const result = await persistMessages({ ...input, messages, now });
  await markSourceFetch(input.repo, input.briefing.id, now);
  if (result.imported > 0) await markImportedMessage(input.repo, input.briefing.id, now);
  await input.repo.updateSourceState({
    sourceId: input.source.id,
    lastCheckedAt: now.toISOString(),
    lastError: nullError(),
    lastSeenAt: messages[0]?.receivedAt ?? now.toISOString(),
    sourceUrl: url
  }, now);

  return {
    ...result,
    sourceId: input.source.id,
    title: messages[0]?.source.title ?? input.source.title,
    url,
    provider: "rss",
    kind: isGoogleNews ? "google_news" : "rss_feed"
  };
}

async function startCappedApifySourceRun(input: SourceRefreshInput & {
  source: SourceRecord;
}): Promise<SourceIngestResult | undefined> {
  const maxItems = apifyRunMaxItems(input.source);
  if (maxItems === undefined) return undefined;
  return startApifySourceRun({
    ...input,
    maxItems
  });
}

async function startGoogleNewsApifyFallback(input: SourceRefreshInput & {
  source: SourceRecord;
  now: Date;
  rssError: string;
}): Promise<SourceIngestResult | undefined> {
  if (!input.env?.APIFY_API_TOKEN) return undefined;
  if (await hasActiveApifyRun(input.repo, input.source.id)) {
    return updateGoogleNewsFallbackState(input, undefined, true);
  }

  const actorInput = googleNewsApifyActorInput(input.source);
  if (!actorInput) return undefined;

  const skipReason = await googleNewsApifyFallbackSkipReason(input);
  if (skipReason) {
    return updateGoogleNewsFallbackState(input, `${input.rssError}; ${skipReason}`, skipReason === "Apify fallback recently started");
  }

  try {
    return await startApifySourceRun({
      ...input,
      actorId: input.source.actorId ?? input.env.APIFY_GOOGLE_NEWS_ACTOR_ID ?? GOOGLE_NEWS_APIFY_FALLBACK_ACTOR_ID,
      actorInput,
      estimatedCostUsd: GOOGLE_NEWS_APIFY_FALLBACK_ESTIMATED_COST_USD
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Apify fallback error";
    throw new Error(`${input.rssError}; Apify fallback failed: ${message}`);
  }
}

async function updateGoogleNewsFallbackState(input: SourceRefreshInput & {
  source: SourceRecord;
  now: Date;
}, lastError: string | undefined, runStarted: boolean): Promise<SourceIngestResult> {
  await input.repo.updateSourceState({
    sourceId: input.source.id,
    lastCheckedAt: input.now.toISOString(),
    lastError
  }, input.now);
  return {
    sourceId: input.source.id,
    title: input.source.title,
    url: googleNewsSourceUrl(input.source) ?? input.source.sourceUrl ?? input.source.url ?? input.source.input ?? input.source.id,
    fetched: 0,
    imported: 0,
    queued: 0,
    skipped: 0,
    provider: "apify",
    kind: "google_news",
    runStarted
  };
}

async function startApifySourceRun(input: SourceRefreshInput & {
  source: SourceRecord;
  actorId?: string;
  actorInput?: unknown;
  estimatedCostUsd?: number;
  maxItems?: number;
}): Promise<SourceIngestResult> {
  const now = input.now ?? new Date();
  if (!input.env?.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is not configured.");
  const actorId = input.actorId ?? input.source.actorId;
  const actorInput = input.actorInput ?? input.source.actorInput ?? {};
  if (!actorId) throw new Error("Apify actor is not configured for this source.");

  const actorRun = await runApifyActor(actorId, actorInput, input.env.APIFY_API_TOKEN, input.fetcher, {
    maxItems: input.maxItems
  });
  await input.repo.createSourceRun({
    sourceId: input.source.id,
    briefingId: input.briefing.id,
    provider: "apify",
    actorId,
    actorRunId: actorRun.id,
    datasetId: actorRun.defaultDatasetId,
    state: "running",
    estimatedCostUsd: input.estimatedCostUsd,
    startedAt: actorRun.startedAt ?? now.toISOString()
  }, now);
  await input.repo.updateSourceState({
    sourceId: input.source.id,
    lastCheckedAt: now.toISOString(),
    lastError: nullError()
  }, now);
  await markSourceFetch(input.repo, input.briefing.id, now);

  return {
    sourceId: input.source.id,
    title: input.source.title,
    url: input.source.sourceUrl ?? input.source.url ?? input.source.input ?? input.source.id,
    fetched: 0,
    imported: 0,
    queued: 0,
    skipped: 0,
    provider: "apify",
    kind: input.source.kind,
    runStarted: true
  };
}

async function pollApifySourceRun(input: SourceRefreshInput & {
  source: SourceRecord;
  run: SourceRunRecord;
}): Promise<void> {
  if (!input.env?.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is not configured.");
  if (!input.run.actorRunId) throw new Error("Apify run id is missing.");

  const now = input.now ?? new Date();
  const actorRun = await getApifyRun(input.run.actorRunId, input.env.APIFY_API_TOKEN, input.fetcher);
  if (actorRun.status === "READY" || actorRun.status === "RUNNING") {
    await input.repo.updateSourceRun({
      id: input.run.id,
      datasetId: actorRun.defaultDatasetId,
      state: "running"
    }, now);
    return;
  }

  if (actorRun.status !== "SUCCEEDED") {
    await input.repo.updateSourceRun({
      id: input.run.id,
      state: "failed",
      datasetId: actorRun.defaultDatasetId,
      actualCostUsd: actorRun.usageTotalUsd,
      error: `Apify run ${actorRun.status.toLowerCase()}`,
      completedAt: now.toISOString()
    }, now);
    await input.repo.updateSourceState({
      sourceId: input.source.id,
      lastError: `Apify run ${actorRun.status.toLowerCase()}`
    }, now);
    return;
  }

  const datasetId = actorRun.defaultDatasetId ?? input.run.datasetId;
  if (!datasetId) throw new Error("Apify run succeeded without a dataset id.");
  const items = await getApifyDatasetItems(datasetId, input.env.APIFY_API_TOKEN, input.fetcher);
  const rawPayloadKey = `apify/${input.briefing.id}/${input.source.id}/${actorRun.id}/items.json`;
  await input.bucket.put(rawPayloadKey, JSON.stringify(items), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });

  const messages = normalizeApifyDatasetItems(items, {
    sourceId: input.source.id,
    sourceTitle: input.source.title,
    kind: input.source.kind,
    receivedAt: now,
    retentionDays: input.briefing.retentionDays,
    rawPayloadKey
  });
  const unusableDataset = describeUnusableApifyDataset(items, messages.length);
  if (unusableDataset) {
    await input.repo.updateSourceRun({
      id: input.run.id,
      state: unusableDataset.failed ? "failed" : "succeeded",
      datasetId,
      itemCount: 0,
      archiveKey: rawPayloadKey,
      actualCostUsd: actorRun.usageTotalUsd,
      error: unusableDataset.message,
      completedAt: now.toISOString()
    }, now);
    await input.repo.updateSourceState({
      sourceId: input.source.id,
      lastError: unusableDataset.message
    }, now);
    return;
  }

  const result = await persistMessages({ ...input, messages, now });
  await input.repo.updateSourceRun({
    id: input.run.id,
    state: "succeeded",
    datasetId,
    itemCount: items.length,
    archiveKey: rawPayloadKey,
    actualCostUsd: actorRun.usageTotalUsd,
    error: nullError(),
    completedAt: now.toISOString()
  }, now);
  await input.repo.updateSourceState({
    sourceId: input.source.id,
    lastSeenAt: messages[0]?.receivedAt ?? now.toISOString(),
    lastError: nullError()
  }, now);
  await markSourceFetch(input.repo, input.briefing.id, now);
  if (result.imported > 0) await markImportedMessage(input.repo, input.briefing.id, now);
}

function describeUnusableApifyDataset(
  items: unknown[],
  normalizedCount: number
): { message: string; failed: boolean } | null {
  if (normalizedCount > 0 || items.length === 0) return null;
  const records = items
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  if (records.length === 0) return null;

  if (records.every((item) => item.demo === true)) {
    return {
      message: "Apify returned demo placeholders instead of live source records. The configured X actor requires a paid Apify plan for live data.",
      failed: true
    };
  }
  if (records.every((item) => item.noResults === true)) {
    return {
      message: "Apify returned no results for this source input.",
      failed: false
    };
  }

  return {
    message: "Apify returned items, but none matched the expected source schema.",
    failed: true
  };
}

async function persistMessages(input: SourceRefreshInput & {
  messages: NormalizedMessage[];
  now: Date;
}): Promise<Omit<SourceIngestResult, "sourceId" | "url">> {
  let imported = 0;
  let queued = 0;
  let skipped = 0;

  for (const message of input.messages) {
    const source = await input.repo.upsertSourceFromMessage(input.briefing.id, message);
    const persistedMessage = {
      ...message,
      id: scopedRawMessageId(input.briefing.id, message.id),
      source: {
        ...message.source,
        id: source.id
      }
    };
    const existing = await input.repo.getRawMessage(persistedMessage.id);
    if (existing) {
      skipped += 1;
      continue;
    }

    await input.repo.saveRawMessage(input.briefing.id, persistedMessage, input.now);
    const jobId = await input.repo.createProcessingJob(input.briefing.id, persistedMessage.id, input.now);
    await input.queue.send({ jobId, briefingId: input.briefing.id, rawMessageId: persistedMessage.id });
    imported += 1;
    queued += 1;
  }

  return {
    fetched: input.messages.length,
    imported,
    queued,
    skipped,
    title: input.messages[0]?.source.title
  };
}

async function markSourceFetch(repo: Repository, briefingId: string, now: Date): Promise<void> {
  await repo.setSetting("last_source_fetch_at", now.toISOString(), now);
  await repo.setSetting(`last_source_fetch_at:${briefingId}`, now.toISOString(), now);
}

async function markImportedMessage(repo: Repository, briefingId: string, now: Date): Promise<void> {
  await repo.setSetting("last_imported_message_at", now.toISOString(), now);
  await repo.setSetting(`last_imported_message_at:${briefingId}`, now.toISOString(), now);
  await repo.setSetting("last_source_event_at", now.toISOString(), now);
  await repo.setSetting(`last_source_event_at:${briefingId}`, now.toISOString(), now);
}

async function runApifyActor(
  actorId: string,
  actorInput: unknown,
  token: string,
  fetcher = fetch,
  options: { maxItems?: number } = {}
): Promise<ApifyRunPayload> {
  const url = new URL(`https://api.apify.com/v2/actors/${encodeApifyActorId(actorId)}/runs`);
  if (options.maxItems !== undefined) url.searchParams.set("maxItems", String(options.maxItems));
  const response = await fetcher(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(actorInput ?? {})
  });
  const payload = await response.json().catch(() => ({})) as { data?: ApifyRunPayload; error?: { message?: string } };
  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `Apify actor run failed to start: ${response.status}`);
  }
  return payload.data;
}

async function getApifyRun(runId: string, token: string, fetcher = fetch): Promise<ApifyRunPayload> {
  const response = await fetcher(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => ({})) as { data?: ApifyRunPayload; error?: { message?: string } };
  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `Could not fetch Apify run: ${response.status}`);
  }
  return payload.data;
}

async function getApifyDatasetItems(datasetId: string, token: string, fetcher = fetch): Promise<unknown[]> {
  const response = await fetcher(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Could not fetch Apify dataset items: ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function encodeApifyActorId(actorId: string): string {
  return encodeURIComponent(actorId.replace("/", "~"));
}

function isDue(lastCheckedAt: string | undefined, now: Date, intervalMs: number): boolean {
  if (!lastCheckedAt) return true;
  return now.getTime() - new Date(lastCheckedAt).getTime() >= intervalMs;
}

function isSourceRefreshDue(briefing: BriefingConfig, source: SourceRecord, now: Date): boolean {
  if (source.kind === "google_news") {
    if (isQuarantinedSourceError(source.lastError)) return false;
    const interval = isGoogleNewsFetchError(source.lastError) ? GOOGLE_NEWS_ERROR_BACKOFF_MS : GOOGLE_NEWS_REFRESH_INTERVAL_MS;
    return isDue(source.lastCheckedAt, now, interval);
  }
  if (source.provider === "telegram") return Boolean(source.url) && isDue(source.lastCheckedAt, now, TELEGRAM_REFRESH_INTERVAL_MS);
  if (source.provider === "rss") return Boolean(source.sourceUrl ?? source.url) && isDue(source.lastCheckedAt, now, RSS_REFRESH_INTERVAL_MS);
  if (source.provider === "apify") return isDue(source.lastCheckedAt, now, apifyRefreshIntervalMs(briefing));
  return false;
}

async function hasActiveApifyRun(repo: Repository, sourceId: string): Promise<boolean> {
  const active = await repo.listSourceRuns({
    sourceId,
    states: ["queued", "running"],
    limit: 1
  });
  return active.length > 0;
}

async function hasLargeProcessingBacklog(repo: Repository, briefingId: string): Promise<boolean> {
  const jobs = await repo.listProcessingJobs({
    briefingId,
    states: ["queued"],
    limit: PROCESSING_BACKLOG_REFRESH_PAUSE_LIMIT
  });
  return jobs.length >= PROCESSING_BACKLOG_REFRESH_PAUSE_LIMIT;
}

async function googleNewsApifyFallbackSkipReason(input: SourceRefreshInput & {
  source: SourceRecord;
  now: Date;
}): Promise<string | null> {
  const recentRuns = await input.repo.listSourceRuns({ sourceId: input.source.id, limit: 10 });
  const recentCutoff = input.now.getTime() - GOOGLE_NEWS_APIFY_FALLBACK_INTERVAL_MS;
  if (recentRuns.some((run) => new Date(run.startedAt).getTime() >= recentCutoff)) {
    return "Apify fallback recently started";
  }

  const since = startOfUtcDay(input.now).toISOString();
  const sourceCost = await input.repo.sumSourceRunCosts({
    briefingId: input.briefing.id,
    sourceId: input.source.id,
    since
  });
  if (sourceCost + GOOGLE_NEWS_APIFY_FALLBACK_ESTIMATED_COST_USD > GOOGLE_NEWS_APIFY_FALLBACK_SOURCE_DAILY_COST_LIMIT_USD) {
    return "Apify fallback daily source cap reached";
  }

  const briefingCost = await input.repo.sumSourceRunCosts({
    briefingId: input.briefing.id,
    since
  });
  if (briefingCost + GOOGLE_NEWS_APIFY_FALLBACK_ESTIMATED_COST_USD > GOOGLE_NEWS_APIFY_FALLBACK_BRIEFING_DAILY_COST_LIMIT_USD) {
    return "Apify fallback daily feed cap reached";
  }

  return null;
}

function apifyRefreshIntervalMs(briefing: BriefingConfig): number {
  if (briefing.briefingCadence === "daily") return 6 * HOUR_MS;
  if (briefing.briefingCadence === "weekly" || briefing.briefingCadence === "monthly") return 24 * HOUR_MS;
  return HOUR_MS;
}

function apifyRunMaxItems(source: SourceRecord): number | undefined {
  const input = recordValue(source.actorInput);
  if (source.kind === "x_profile" || source.kind === "x_search") {
    return Math.max(
      minimumApifyRunItems(X_PRICE_PER_1000_TWEETS_USD),
      Math.max(1, Math.floor(Math.min(numberValue(input.maxItems, X_MAX_ITEMS), X_MAX_ITEMS)))
    );
  }
  return undefined;
}

function minimumApifyRunItems(pricePer1000ItemsUsd: number): number {
  return Math.ceil((APIFY_MINIMUM_RUN_CHARGE_USD / pricePer1000ItemsUsd) * 1000);
}

function scopedRawMessageId(briefingId: string, rawMessageId: string): string {
  return `${briefingId}::${rawMessageId}`;
}

function skippedApifySourceRun(source: SourceRecord): SourceIngestResult {
  return {
    sourceId: source.id,
    title: source.title,
    url: source.sourceUrl ?? source.url ?? source.input ?? source.id,
    fetched: 0,
    imported: 0,
    queued: 0,
    skipped: 0,
    provider: "apify",
    kind: source.kind
  };
}

function nullError(): undefined {
  return undefined;
}

function rssRequestHeaders(isGoogleNews: boolean): HeadersInit {
  if (!isGoogleNews) {
    return {
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "user-agent": "Distilled.news RSS source reader"
    };
  }
  return {
    accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (compatible; DistilledNewsBot/1.0; +https://distilled.news)"
  };
}

function isRetryableGoogleNewsStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isGoogleNewsFetchError(error: string | undefined): boolean {
  return Boolean(error && /Google News RSS source: (?:429|5\d\d)/i.test(error));
}

function isQuarantinedSourceError(error: string | undefined): boolean {
  return Boolean(error && /^(Quarantined after repeated queue failures|Paused after repeated source failures):/i.test(error));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function googleNewsSourceUrl(source: SourceRecord): string | undefined {
  const existingUrl = source.sourceUrl ?? source.url;
  if (existingUrl && isGoogleNewsSearchUrl(existingUrl)) return existingUrl;

  const actorInput = recordValue(source.actorInput);
  const query = googleNewsQueryFromSource(source);
  if (!query) return undefined;

  return buildGoogleNewsRssUrl(query, {
    geo: stringValue(actorInput.geo),
    language: stringValue(actorInput.language)
  });
}

function googleNewsApifyActorInput(source: SourceRecord): Record<string, unknown> | null {
  const input = recordValue(source.actorInput);
  const query = googleNewsQueryFromSource(source);
  if (!query) return null;

  return {
    ...input,
    queries: [query],
    geo: stringValue(input.geo) ?? "US",
    language: stringValue(input.language) ?? "en",
    maxItemsPerQuery: Math.max(
      1,
      Math.floor(Math.min(numberValue(input.maxItemsPerQuery, GOOGLE_NEWS_APIFY_FALLBACK_MAX_ITEMS), GOOGLE_NEWS_APIFY_FALLBACK_MAX_ITEMS))
    )
  };
}

function googleNewsQueryFromSource(source: SourceRecord): string | undefined {
  const actorInput = recordValue(source.actorInput);
  return firstString(Array.isArray(actorInput.queries) ? actorInput.queries : undefined) ??
    stringValue(actorInput.query) ??
    googleNewsQueryFromUrl(source.sourceUrl ?? source.url) ??
    source.input?.replace(/^news:\s*/i, "").trim();
}

function googleNewsQueryFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname !== "news.google.com" || url.pathname !== "/rss/search") return undefined;
    return stringValue(url.searchParams.get("q") ?? undefined);
  } catch {
    return undefined;
  }
}

function isGoogleNewsSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "news.google.com" && url.pathname === "/rss/search";
  } catch {
    return false;
  }
}

function firstString(values: unknown[] | undefined): string | undefined {
  return values?.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface ApifyRunPayload {
  id: string;
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED-OUT" | "ABORTED";
  defaultDatasetId?: string;
  startedAt?: string;
  usageTotalUsd?: number;
}
