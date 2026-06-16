import type {
  BriefingConfig,
  BriefingItem,
  NormalizedMessage,
  SourceType
} from "@lownoise/core";

export interface Env {
  DB: D1Database;
  RAW_ARCHIVE: R2Bucket;
  PROCESSING_QUEUE: Queue<ProcessingJobMessage>;
  VECTORIZE?: VectorizeIndex;
  ASSETS?: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_SESSION_SECRET?: string;
  ADMIN_SETUP_TOKEN?: string;
  INTERNAL_MAINTENANCE_SECRET?: string;
  PUBLIC_API_BASE_URL?: string;
  PUBLIC_WEB_BASE_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
}

export interface ProcessingJobMessage {
  jobId: string;
  briefingId: string;
  rawMessageId: string;
}

export interface TelegramSourceRecord {
  id: string;
  briefingId: string;
  title: string;
  type: SourceType;
  username?: string;
  enabled: boolean;
  lastSeenAt: string;
}

export interface HealthStatus {
  tokenConfigured: boolean;
  webhookRegistered: boolean;
  lastTelegramEventAt?: string;
  processing: {
    queued: number;
    completed: number;
    failed: number;
  };
}

export interface Repository {
  ensureDefaultBriefing(now?: Date): Promise<BriefingConfig>;
  listBriefings(): Promise<BriefingConfig[]>;
  getBriefingById(id: string): Promise<BriefingConfig | null>;
  getBriefingBySlug(slug: string): Promise<BriefingConfig | null>;
  upsertBriefing(input: BriefingConfig, now?: Date): Promise<BriefingConfig>;
  listSources(briefingId: string): Promise<TelegramSourceRecord[]>;
  setSourceEnabled(sourceId: string, enabled: boolean, now?: Date): Promise<void>;
  upsertSourceFromMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<TelegramSourceRecord>;
  saveRawMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<void>;
  getRawMessage(id: string): Promise<NormalizedMessage | null>;
  createProcessingJob(briefingId: string, rawMessageId: string, now?: Date): Promise<string>;
  completeProcessingJob(jobId: string, now?: Date): Promise<void>;
  failProcessingJob(jobId: string, error: string, now?: Date): Promise<void>;
  getExistingItems(briefingId: string, now?: Date): Promise<BriefingItem[]>;
  saveBriefingItems(briefingId: string, items: BriefingItem[], now?: Date): Promise<void>;
  listFeedItems(slug: string, includePrivate: boolean, now?: Date): Promise<BriefingItem[]>;
  getHealth(env: Pick<Env, "TELEGRAM_BOT_TOKEN">, now?: Date): Promise<HealthStatus>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, now?: Date): Promise<void>;
  deleteExpired(now?: Date): Promise<number>;
}
