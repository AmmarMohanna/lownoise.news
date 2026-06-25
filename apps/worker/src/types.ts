import type {
  BriefingConfig,
  BriefingEdition,
  BriefingEvidence,
  BriefingItem,
  NormalizedMessage,
  SourceKind,
  SourceProvider,
  SourceType
} from "@distilled/core";

export type ProcessingJobState = "queued" | "completed" | "failed";
export type SourceRunState = "queued" | "running" | "succeeded" | "failed";
export type AccountRole = "admin" | "user";
export type AuthTokenPurpose = "email_verification" | "password_reset";

export interface AccountRecord {
  id: string;
  email: string;
  username: string;
  role: AccountRole;
  emailVerifiedAt?: string;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountWithStats extends AccountRecord {
  briefingCount: number;
}

export interface UsernameAliasRecord {
  username: string;
  accountId: string;
  isCurrent: boolean;
  createdAt: string;
}

export interface AuthTokenRecord {
  id: string;
  accountId: string;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface ProcessingJobRecord {
  id: string;
  briefingId: string;
  rawMessageId: string;
  state: ProcessingJobState;
  error?: string;
  updatedAt: string;
}

export interface Env {
  DB: D1Database;
  RAW_ARCHIVE: R2Bucket;
  PROCESSING_QUEUE: Queue<DistilledQueueMessage>;
  EMAIL?: SendEmail;
  ASSETS?: Fetcher;
  ADMIN_SESSION_SECRET?: string;
  ADMIN_SETUP_TOKEN?: string;
  INTERNAL_MAINTENANCE_SECRET?: string;
  EMAIL_FROM?: string;
  PUBLIC_API_BASE_URL?: string;
  PUBLIC_WEB_BASE_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_INPUT_PRICE_USD_PER_MILLION_TOKENS?: string;
  OPENAI_OUTPUT_PRICE_USD_PER_MILLION_TOKENS?: string;
  APIFY_API_TOKEN?: string;
  APIFY_GOOGLE_NEWS_ACTOR_ID?: string;
  APIFY_X_ACTOR_ID?: string;
  APIFY_LINKEDIN_COMPANY_ACTOR_ID?: string;
  APIFY_LINKEDIN_PROFILE_ACTOR_ID?: string;
  APIFY_GOOGLE_NEWS_PRICE_USD_PER_1000_RESULTS?: string;
  APIFY_X_PRICE_USD_PER_1000_RESULTS?: string;
}

export interface ProcessingJobMessage {
  type?: "process_raw_message";
  jobId: string;
  briefingId: string;
  rawMessageId: string;
}

export interface SourceRefreshJobMessage {
  type: "refresh_source";
  briefingId: string;
  sourceId: string;
  force?: boolean;
}

export type DistilledQueueMessage = ProcessingJobMessage | SourceRefreshJobMessage;

export interface SourceRecord {
  id: string;
  briefingId: string;
  title: string;
  type: SourceType;
  provider: SourceProvider;
  kind: SourceKind;
  username?: string;
  input?: string;
  url?: string;
  sourceUrl?: string;
  actorId?: string;
  actorInput?: unknown;
  cursor?: unknown;
  enabled: boolean;
  lastSeenAt: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface SourceRunRecord {
  id: string;
  sourceId: string;
  briefingId: string;
  provider: SourceProvider;
  actorId?: string;
  actorRunId?: string;
  datasetId?: string;
  state: SourceRunState;
  itemCount: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  archiveKey?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface HealthStatus {
  lastSourceEventAt?: string;
  lastSourceFetchAt?: string;
  lastImportedMessageAt?: string;
  latestPublishedAt?: string;
  nextBriefingAt?: string;
  processing: {
    queued: number;
    completed: number;
    failed: number;
  };
}

export interface Repository {
  createAccount(input: {
    email: string;
    username: string;
    role: AccountRole;
    passwordHash: string;
    emailVerifiedAt?: string;
  }, now?: Date): Promise<AccountRecord>;
  deleteAccount(id: string, now?: Date): Promise<void>;
  listAccounts(): Promise<AccountWithStats[]>;
  getAccountById(id: string): Promise<AccountRecord | null>;
  getAccountByEmail(email: string): Promise<(AccountRecord & { passwordHash: string }) | null>;
  getAccountByUsername(username: string): Promise<AccountRecord | null>;
  resolveUsernameAlias(username: string): Promise<{ account: AccountRecord; alias: UsernameAliasRecord } | null>;
  updateAccount(input: {
    id: string;
    username?: string;
    role?: AccountRole;
    disabled?: boolean;
    emailVerifiedAt?: string;
    passwordHash?: string;
  }, now?: Date): Promise<AccountRecord>;
  countAdmins(): Promise<number>;
  createAuthToken(input: {
    accountId: string;
    purpose: AuthTokenPurpose;
    tokenHash: string;
    expiresAt: string;
  }, now?: Date): Promise<AuthTokenRecord>;
  getAuthToken(tokenHash: string, purpose: AuthTokenPurpose): Promise<AuthTokenRecord | null>;
  consumeAuthToken(id: string, now?: Date): Promise<void>;
  countRecentAuthAttempts(input: { key: string; action: string; since: string }): Promise<number>;
  recordAuthAttempt(input: { key: string; action: string }, now?: Date): Promise<void>;
  ensureDefaultBriefing(account: AccountRecord, now?: Date): Promise<BriefingConfig>;
  listBriefings(accountId?: string): Promise<BriefingConfig[]>;
  listExploreBriefings(limit: number): Promise<BriefingConfig[]>;
  getBriefingById(id: string): Promise<BriefingConfig | null>;
  getBriefingBySlug(ownerAccountId: string, slug: string): Promise<BriefingConfig | null>;
  hasBriefingStar(briefingId: string, voterId: string): Promise<boolean>;
  setBriefingStar(briefingId: string, voterId: string, starred: boolean, now?: Date): Promise<number>;
  upsertBriefing(input: BriefingConfig, now?: Date): Promise<BriefingConfig>;
  deleteBriefing(id: string, now?: Date): Promise<void>;
  listSources(briefingId: string): Promise<SourceRecord[]>;
  getSource(sourceId: string): Promise<SourceRecord | null>;
  setSourceEnabled(sourceId: string, enabled: boolean, now?: Date): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
  upsertConfiguredSource(input: {
    briefingId: string;
    title: string;
    type?: SourceType;
    provider: SourceProvider;
    kind: SourceKind;
    username?: string;
    input?: string;
    url?: string;
    sourceUrl?: string;
    actorId?: string;
    actorInput?: unknown;
    enabled?: boolean;
  }, now?: Date): Promise<SourceRecord>;
  updateSourceState(input: {
    sourceId: string;
    title?: string;
    username?: string;
    url?: string;
    sourceUrl?: string;
    lastSeenAt?: string;
    lastCheckedAt?: string;
    lastError?: string;
    cursor?: unknown;
  }, now?: Date): Promise<void>;
  upsertSourceFromMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<SourceRecord>;
  saveRawMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<void>;
  getRawMessage(id: string): Promise<NormalizedMessage | null>;
  listRecentRawMessages(briefingId: string, now?: Date, limit?: number): Promise<NormalizedMessage[]>;
  listRawMessagesForWindow(briefingId: string, windowStart: string, windowEnd: string, limit?: number): Promise<NormalizedMessage[]>;
  createProcessingJob(briefingId: string, rawMessageId: string, now?: Date): Promise<string>;
  completeProcessingJob(jobId: string, now?: Date): Promise<void>;
  failProcessingJob(jobId: string, error: string, now?: Date): Promise<void>;
  listProcessingJobs(input?: {
    briefingId?: string;
    states?: ProcessingJobState[];
    limit?: number;
  }): Promise<ProcessingJobRecord[]>;
  requeueProcessingJob(jobId: string, now?: Date): Promise<void>;
  getExistingItems(briefingId: string, now?: Date): Promise<BriefingItem[]>;
  saveBriefingItems(briefingId: string, items: BriefingItem[], now?: Date): Promise<void>;
  repairDuplicateBriefingItems(briefingId: string, now?: Date): Promise<number>;
  listFeedItems(ownerAccountId: string, slug: string, includeEvidence: boolean, now?: Date): Promise<BriefingItem[]>;
  getFeedItemEvidence(briefingId: string, itemId: string, now?: Date): Promise<BriefingEvidence[]>;
  saveBriefingEdition(edition: BriefingEdition, now?: Date): Promise<void>;
  listBriefingEditions(briefingId: string, includeSections: boolean, now?: Date, limit?: number): Promise<BriefingEdition[]>;
  getBriefingEdition(briefingId: string, editionId: string, now?: Date): Promise<BriefingEdition | null>;
  getHealth(briefingId?: string, now?: Date): Promise<HealthStatus>;
  createSourceRun(input: {
    sourceId: string;
    briefingId: string;
    provider: SourceProvider;
    actorId?: string;
    actorRunId?: string;
    datasetId?: string;
    state: SourceRunState;
    estimatedCostUsd?: number;
    startedAt?: string;
  }, now?: Date): Promise<SourceRunRecord>;
  updateSourceRun(input: {
    id: string;
    actorRunId?: string;
    datasetId?: string;
    state?: SourceRunState;
    itemCount?: number;
    estimatedCostUsd?: number;
    actualCostUsd?: number;
    archiveKey?: string;
    error?: string;
    completedAt?: string;
  }, now?: Date): Promise<void>;
  listSourceRuns(input?: {
    briefingId?: string;
    sourceId?: string;
    states?: SourceRunState[];
    limit?: number;
  }): Promise<SourceRunRecord[]>;
  sumSourceRunCosts(input: {
    briefingId: string;
    sourceId?: string;
    since: string;
  }): Promise<number>;
  recordLlmUsage(input: {
    briefingId: string;
    model: string;
    purpose: "summary" | "importance_review" | "event_review";
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }, now?: Date): Promise<void>;
  sumLlmUsageCost(input: {
    briefingId: string;
    since: string;
  }): Promise<number>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, now?: Date): Promise<void>;
  listExpiredRawPayloadKeys(now?: Date): Promise<string[]>;
  deleteExpired(now?: Date): Promise<number>;
}
