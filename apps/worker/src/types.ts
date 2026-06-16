import type {
  BriefingConfig,
  BriefingItem,
  NormalizedMessage,
  SourceType
} from "@lownoise/core";

export type ProcessingJobState = "queued" | "completed" | "failed";
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
  PROCESSING_QUEUE: Queue<ProcessingJobMessage>;
  EMAIL?: SendEmail;
  VECTORIZE?: VectorizeIndex;
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
  url?: string;
  enabled: boolean;
  lastSeenAt: string;
}

export interface HealthStatus {
  lastTelegramEventAt?: string;
  latestPublishedAt?: string;
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
  getBriefingById(id: string): Promise<BriefingConfig | null>;
  getBriefingBySlug(ownerAccountId: string, slug: string): Promise<BriefingConfig | null>;
  hasBriefingStar(briefingId: string, voterId: string): Promise<boolean>;
  setBriefingStar(briefingId: string, voterId: string, starred: boolean, now?: Date): Promise<number>;
  upsertBriefing(input: BriefingConfig, now?: Date): Promise<BriefingConfig>;
  deleteBriefing(id: string, now?: Date): Promise<void>;
  listSources(briefingId: string): Promise<TelegramSourceRecord[]>;
  getSource(sourceId: string): Promise<TelegramSourceRecord | null>;
  setSourceEnabled(sourceId: string, enabled: boolean, now?: Date): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
  upsertSourceFromMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<TelegramSourceRecord>;
  saveRawMessage(briefingId: string, message: NormalizedMessage, now?: Date): Promise<void>;
  getRawMessage(id: string): Promise<NormalizedMessage | null>;
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
  listFeedItems(ownerAccountId: string, slug: string, includePrivate: boolean, now?: Date): Promise<BriefingItem[]>;
  getHealth(briefingId?: string, now?: Date): Promise<HealthStatus>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, now?: Date): Promise<void>;
  deleteExpired(now?: Date): Promise<number>;
}
