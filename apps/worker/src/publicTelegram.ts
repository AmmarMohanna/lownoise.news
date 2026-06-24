import type { BriefingConfig } from "@distilled/core";
import {
  parsePublicTelegramChannelPage,
  parsePublicTelegramChannelUrl,
  publicTelegramSourceId
} from "@distilled/connectors";
import type { ProcessingJobMessage, Repository, SourceRecord } from "./types";

export interface PublicTelegramIngestResult {
  sourceId: string;
  title?: string;
  url: string;
  fetched: number;
  imported: number;
  queued: number;
  skipped: number;
}

export interface PublicTelegramIngestInput {
  briefing: BriefingConfig;
  url: string;
  repo: Repository;
  bucket: { put(key: string, value: string, options?: unknown): Promise<unknown> };
  queue: { send(message: ProcessingJobMessage): Promise<unknown> };
  activateSource?: boolean;
  fetcher?: typeof fetch;
  now?: Date;
}

export async function ingestPublicTelegramChannel(input: PublicTelegramIngestInput): Promise<PublicTelegramIngestResult> {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();
  const channel = parsePublicTelegramChannelUrl(input.url);
  const response = await fetcher(channel.widgetUrl, {
    headers: {
      "user-agent": "Distilled.news public Telegram source reader"
    }
  });

  if (!response.ok) {
    throw new Error(`Could not fetch ${channel.publicUrl}: ${response.status}`);
  }

  const html = await response.text();
  const rawPayloadKey = await archiveTelegramPageIfChanged(input, channel.username, html, now);

  const messages = parsePublicTelegramChannelPage(html, {
    username: channel.username,
    receivedAt: now,
    retentionDays: input.briefing.retentionDays
  }).map((message) => ({ ...message, rawPayloadKey }));

  let source: SourceRecord | undefined;
  let imported = 0;
  let queued = 0;
  let skipped = 0;

  for (const message of messages) {
    source = await input.repo.upsertSourceFromMessage(input.briefing.id, message);
    const persistedMessage = {
      ...message,
      id: scopedRawMessageId(input.briefing.id, message.id),
      source: {
        ...message.source,
        id: source.id
      }
    };
    if (input.activateSource) {
      await input.repo.setSourceEnabled(source.id, true, now);
      source = { ...source, enabled: true };
    }

    const existing = await input.repo.getRawMessage(persistedMessage.id);
    if (existing) {
      skipped += 1;
      continue;
    }

    await input.repo.saveRawMessage(input.briefing.id, persistedMessage, now);
    const jobId = await input.repo.createProcessingJob(input.briefing.id, persistedMessage.id, now);
    await input.queue.send({ jobId, briefingId: input.briefing.id, rawMessageId: persistedMessage.id });
    imported += 1;
    queued += 1;
  }

  await markSourceFetch(input.repo, input.briefing.id, now);
  if (imported > 0) {
    await markImportedMessage(input.repo, input.briefing.id, now);
    await input.repo.setSetting("last_telegram_event_at", now.toISOString(), now);
    await input.repo.setSetting(`last_telegram_event_at:${input.briefing.id}`, now.toISOString(), now);
  }
  if (source) {
    await input.repo.updateSourceState({
      sourceId: source.id,
      lastCheckedAt: now.toISOString(),
      lastError: undefined
    }, now);
  }

  return {
    sourceId: source?.id ?? publicTelegramSourceId(channel.username),
    title: source?.title,
    url: channel.publicUrl,
    fetched: messages.length,
    imported,
    queued,
    skipped
  };
}

export async function refreshPublicTelegramSources(input: Omit<PublicTelegramIngestInput, "url">): Promise<PublicTelegramIngestResult[]> {
  if (input.briefing.paused) return [];

  const sources = (await input.repo.listSources(input.briefing.id)).filter(
    (source) => source.enabled && source.provider === "telegram" && source.url
  );
  const results: PublicTelegramIngestResult[] = [];
  for (const source of sources) {
    results.push(await ingestPublicTelegramChannel({ ...input, url: source.url! }));
  }
  return results;
}

async function archiveTelegramPageIfChanged(
  input: PublicTelegramIngestInput,
  username: string,
  html: string,
  now: Date
): Promise<string | undefined> {
  const hash = await sha256Hex(html);
  const hashSetting = `raw_archive_hash:telegram:${input.briefing.id}:${username}`;
  const keySetting = `raw_archive_key:telegram:${input.briefing.id}:${username}`;
  const existingHash = await input.repo.getSetting(hashSetting);
  const existingKey = await input.repo.getSetting(keySetting);
  if (existingHash === hash && existingKey) return existingKey;

  const rawPayloadKey = `telegram-public/${input.briefing.id}/${username}/${now.getTime()}.html`;
  await input.bucket.put(rawPayloadKey, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" }
  });
  await input.repo.setSetting(hashSetting, hash, now);
  await input.repo.setSetting(keySetting, rawPayloadKey, now);
  return rawPayloadKey;
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

function scopedRawMessageId(briefingId: string, rawMessageId: string): string {
  return `${briefingId}::${rawMessageId}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
