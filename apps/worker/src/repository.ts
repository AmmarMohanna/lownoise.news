import {
  collapseDuplicateBriefingItems,
  defaultNextBriefingAt,
  eventKeysForItem,
  mergeBriefingItem,
  personalNewsBriefing,
  primaryEventKeyForEvidence,
  sanitizeSummary,
  type BriefingConfig,
  type BriefingEvidence,
  type BriefingEdition,
  type BriefingEditionSection,
  type BriefingItem,
  type MediaReference,
  type NormalizedMessage,
  type SourceKind,
  type SourceProvider,
  type SourceType
} from "@distilled/core";
import type {
  AccountRecord,
  AccountRole,
  AccountWithStats,
  AuthTokenPurpose,
  AuthTokenRecord,
  HealthStatus,
  ProcessingJobRecord,
  ProcessingJobState,
  Repository,
  SourceRecord,
  SourceRunRecord,
  SourceRunState,
  UsernameAliasRecord
} from "./types";

type DbValue = string | number | null;

const FIXED_RETENTION_DAYS = 15;
const DEFAULT_DAILY_BUDGET_USD = 1;

interface AccountRow {
  id: string;
  email: string;
  normalized_email: string;
  username: string;
  role: AccountRole;
  password_hash: string;
  email_verified_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  briefing_count?: number;
}

interface UsernameAliasRow {
  username: string;
  account_id: string;
  is_current: number;
  created_at: string;
}

interface AuthTokenRow {
  id: string;
  account_id: string;
  purpose: AuthTokenPurpose;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface BriefingRow {
  id: string;
  owner_account_id: string;
  owner_username: string;
  slug: string;
  title: string;
  stars?: number;
  interest_profile: string;
  style_instruction: string | null;
  public_feed_enabled: number;
  paused?: number;
  language?: "en" | "ar" | "fr" | null;
  intensity?: "low" | "medium" | "high" | null;
  briefing_cadence?: "hourly" | "daily" | "weekly" | "monthly" | null;
  briefing_time_of_day?: string | null;
  briefing_timezone?: string | null;
  next_briefing_at?: string | null;
  retention_days: number;
  created_at?: string;
}

interface BriefingEditionRow {
  id: string;
  briefing_id: string;
  cadence: "hourly" | "daily" | "weekly" | "monthly";
  window_start: string;
  window_end: string;
  title: string;
  summary: string;
  sections_json: string;
  status: "published" | "empty";
  published_at: string;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  id: string;
  briefing_id: string;
  title: string;
  type: "channel" | "group";
  provider?: SourceProvider | null;
  kind?: SourceKind | null;
  username: string | null;
  input?: string | null;
  source_url?: string | null;
  actor_id?: string | null;
  actor_input_json?: string | null;
  cursor_json?: string | null;
  enabled: number;
  last_seen_at: string;
  last_checked_at?: string | null;
  last_error?: string | null;
}

interface RawMessageRow {
  id: string;
  source_id: string;
  message_source_title?: string | null;
  message_source_type?: "channel" | "group" | null;
  message_source_provider?: SourceProvider | null;
  message_source_kind?: SourceKind | null;
  message_source_username?: string | null;
  message_id: string;
  text: string;
  links_json: string;
  media_json: string;
  posted_at: string;
  received_at: string;
  source_url: string | null;
  raw_payload_key: string | null;
  expires_at: string;
  title: string;
  type: "channel" | "group";
  provider?: SourceProvider | null;
  kind?: SourceKind | null;
  username: string | null;
}

interface BriefingItemRow {
  id: string;
  cluster_id: string;
  event_key?: string | null;
  summary: string;
  item_at: string;
  updated_at: string;
  expires_at: string;
  merged_update_count: number;
}

interface EvidenceRow {
  raw_message_id: string;
  source_id: string;
  source_title: string;
  source_type: "channel" | "group";
  source_provider?: SourceProvider | null;
  source_kind?: SourceKind | null;
  source_url: string | null;
  posted_at: string;
  text: string;
  links_json: string;
  media_json: string;
}

interface EvidenceWithItemRow extends EvidenceRow {
  briefing_item_id: string;
}

interface SourceRunRow {
  id: string;
  source_id: string;
  briefing_id: string;
  provider: SourceProvider;
  actor_id: string | null;
  actor_run_id: string | null;
  dataset_id: string | null;
  state: SourceRunState;
  item_count: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  archive_key: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

interface ProcessingJobRow {
  id: string;
  briefing_id: string;
  raw_message_id: string;
  state: ProcessingJobState;
  error: string | null;
  updated_at: string;
}

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async createAccount(input: {
    email: string;
    username: string;
    role: AccountRole;
    passwordHash: string;
    emailVerifiedAt?: string;
  }, now = new Date()): Promise<AccountRecord> {
    const id = `account_${crypto.randomUUID()}`;
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO accounts (
          id, email, normalized_email, username, role, password_hash, email_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.email,
        input.email,
        input.username,
        input.role,
        input.passwordHash,
        input.emailVerifiedAt ?? null,
        timestamp,
        timestamp
      )
      .run();
    await this.db
      .prepare("INSERT INTO username_aliases (username, account_id, is_current, created_at) VALUES (?, ?, 1, ?)")
      .bind(input.username, id, timestamp)
      .run();
    const account = await this.getAccountById(id);
    if (!account) throw new Error("Failed to create account");
    return account;
  }

  async listAccounts(): Promise<AccountWithStats[]> {
    const rows = await all<AccountRow>(
      this.db.prepare(
        `SELECT accounts.*, COUNT(briefings.id) as briefing_count
        FROM accounts
        LEFT JOIN briefings ON briefings.owner_account_id = accounts.id
        GROUP BY accounts.id
        ORDER BY accounts.created_at ASC`
      )
    );
    return rows.map(rowToAccountWithStats);
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  }

  async getAccountById(id: string): Promise<AccountRecord | null> {
    const row = await first<AccountRow>(this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id));
    return row ? rowToAccount(row) : null;
  }

  async getAccountByEmail(email: string): Promise<(AccountRecord & { passwordHash: string }) | null> {
    const row = await first<AccountRow>(this.db.prepare("SELECT * FROM accounts WHERE normalized_email = ?").bind(email));
    return row ? { ...rowToAccount(row), passwordHash: row.password_hash } : null;
  }

  async getAccountByUsername(username: string): Promise<AccountRecord | null> {
    const row = await first<AccountRow>(this.db.prepare("SELECT * FROM accounts WHERE username = ?").bind(username));
    return row ? rowToAccount(row) : null;
  }

  async resolveUsernameAlias(username: string): Promise<{ account: AccountRecord; alias: UsernameAliasRecord } | null> {
    const row = await first<UsernameAliasRow>(
      this.db.prepare("SELECT * FROM username_aliases WHERE username = ?").bind(username)
    );
    if (!row) return null;
    const account = await this.getAccountById(row.account_id);
    if (!account) return null;
    return { account, alias: rowToUsernameAlias(row) };
  }

  async updateAccount(input: {
    id: string;
    username?: string;
    role?: AccountRole;
    disabled?: boolean;
    emailVerifiedAt?: string;
    passwordHash?: string;
  }, now = new Date()): Promise<AccountRecord> {
    const existing = await this.getAccountById(input.id);
    if (!existing) throw new Error("account not found");

    const timestamp = now.toISOString();
    const nextUsername = input.username ?? existing.username;
    if (input.username && input.username !== existing.username) {
      await this.db
        .prepare("UPDATE username_aliases SET is_current = 0 WHERE account_id = ? AND is_current = 1")
        .bind(input.id)
        .run();
      const existingAlias = await first<UsernameAliasRow>(
        this.db.prepare("SELECT * FROM username_aliases WHERE username = ?").bind(input.username)
      );
      if (existingAlias?.account_id === input.id) {
        await this.db
          .prepare("UPDATE username_aliases SET is_current = 1 WHERE username = ? AND account_id = ?")
          .bind(input.username, input.id)
          .run();
      } else {
        await this.db
          .prepare("INSERT INTO username_aliases (username, account_id, is_current, created_at) VALUES (?, ?, 1, ?)")
          .bind(input.username, input.id, timestamp)
          .run();
      }
    }

    await this.db
      .prepare(
        `UPDATE accounts
        SET username = ?,
          role = ?,
          disabled_at = ?,
          email_verified_at = COALESCE(?, email_verified_at),
          password_hash = COALESCE(?, password_hash),
          updated_at = ?
        WHERE id = ?`
      )
      .bind(
        nextUsername,
        input.role ?? existing.role,
        input.disabled === undefined ? existing.disabledAt ?? null : input.disabled ? timestamp : null,
        input.emailVerifiedAt ?? null,
        input.passwordHash ?? null,
        timestamp,
        input.id
      )
      .run();
    const account = await this.getAccountById(input.id);
    if (!account) throw new Error("account not found");
    return account;
  }

  async countAdmins(): Promise<number> {
    const row = await first<{ count: number }>(
      this.db.prepare("SELECT COUNT(*) as count FROM accounts WHERE role = 'admin' AND disabled_at IS NULL")
    );
    return Number(row?.count ?? 0);
  }

  async createAuthToken(input: {
    accountId: string;
    purpose: AuthTokenPurpose;
    tokenHash: string;
    expiresAt: string;
  }, now = new Date()): Promise<AuthTokenRecord> {
    const id = `token_${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO auth_tokens (id, account_id, purpose, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.accountId, input.purpose, input.tokenHash, input.expiresAt, now.toISOString())
      .run();
    const token = await this.getAuthToken(input.tokenHash, input.purpose);
    if (!token) throw new Error("Failed to create auth token");
    return token;
  }

  async getAuthToken(tokenHash: string, purpose: AuthTokenPurpose): Promise<AuthTokenRecord | null> {
    const row = await first<AuthTokenRow>(
      this.db
        .prepare("SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?")
        .bind(tokenHash, purpose)
    );
    return row ? rowToAuthToken(row) : null;
  }

  async consumeAuthToken(id: string, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE auth_tokens SET consumed_at = ? WHERE id = ?")
      .bind(now.toISOString(), id)
      .run();
  }

  async countRecentAuthAttempts(input: { key: string; action: string; since: string }): Promise<number> {
    const row = await first<{ count: number }>(
      this.db
        .prepare("SELECT COUNT(*) as count FROM auth_attempts WHERE key = ? AND action = ? AND created_at >= ?")
        .bind(input.key, input.action, input.since)
    );
    return Number(row?.count ?? 0);
  }

  async recordAuthAttempt(input: { key: string; action: string }, now = new Date()): Promise<void> {
    await this.db
      .prepare("INSERT INTO auth_attempts (id, key, action, created_at) VALUES (?, ?, ?, ?)")
      .bind(`attempt_${crypto.randomUUID()}`, input.key, input.action, now.toISOString())
      .run();
  }

  async ensureDefaultBriefing(account: AccountRecord, now = new Date()): Promise<BriefingConfig> {
    const existing = await this.getBriefingBySlug(account.id, personalNewsBriefing.slug);
    if (existing) return existing;
    return this.upsertBriefing(
      {
        ...personalNewsBriefing,
        id: `briefing_${account.id}_personal`,
        ownerAccountId: account.id,
        ownerUsername: account.username,
        nextBriefingAt: defaultNextBriefingAt({ now })
      },
      now
    );
  }

  async listBriefings(accountId?: string): Promise<BriefingConfig[]> {
    const sql =
      `SELECT briefings.*, accounts.username as owner_username
      FROM briefings
      JOIN accounts ON accounts.id = briefings.owner_account_id` +
      (accountId ? " WHERE briefings.owner_account_id = ?" : "") +
      " ORDER BY briefings.stars DESC, briefings.created_at ASC, briefings.id ASC";
    const rows = accountId
      ? await all<BriefingRow>(this.db.prepare(sql).bind(accountId))
      : await all<BriefingRow>(this.db.prepare(sql));
    return rows.map(rowToBriefing);
  }

  async listExploreBriefings(limit: number): Promise<BriefingConfig[]> {
    if (limit <= 0) return [];
    const rows = await all<BriefingRow>(
      this.db
        .prepare(
          `SELECT briefings.*, accounts.username as owner_username
          FROM briefings
          JOIN accounts ON accounts.id = briefings.owner_account_id
          WHERE accounts.disabled_at IS NULL AND briefings.stars > 0
          ORDER BY briefings.stars DESC, briefings.created_at ASC, briefings.id ASC
          LIMIT ?`
        )
        .bind(limit)
    );
    return rows.map(rowToBriefing);
  }

  async getBriefingById(id: string): Promise<BriefingConfig | null> {
    const row = await first<BriefingRow>(
      this.db
        .prepare(
          `SELECT briefings.*, accounts.username as owner_username
          FROM briefings
          JOIN accounts ON accounts.id = briefings.owner_account_id
          WHERE briefings.id = ?`
        )
        .bind(id)
    );
    return row ? rowToBriefing(row) : null;
  }

  async getBriefingBySlug(ownerAccountId: string, slug: string): Promise<BriefingConfig | null> {
    const row = await first<BriefingRow>(
      this.db
        .prepare(
          `SELECT briefings.*, accounts.username as owner_username
          FROM briefings
          JOIN accounts ON accounts.id = briefings.owner_account_id
          WHERE briefings.owner_account_id = ? AND briefings.slug = ?`
        )
        .bind(ownerAccountId, slug)
    );
    return row ? rowToBriefing(row) : null;
  }

  async hasBriefingStar(briefingId: string, voterId: string): Promise<boolean> {
    const row = await first<{ voter_id: string }>(
      this.db
        .prepare("SELECT voter_id FROM briefing_stars WHERE briefing_id = ? AND voter_id = ?")
        .bind(briefingId, voterId)
    );
    return Boolean(row?.voter_id);
  }

  async setBriefingStar(briefingId: string, voterId: string, starred: boolean, now = new Date()): Promise<number> {
    if (starred) {
      await this.db
        .prepare("INSERT OR IGNORE INTO briefing_stars (briefing_id, voter_id, created_at) VALUES (?, ?, ?)")
        .bind(briefingId, voterId, now.toISOString())
        .run();
    } else {
      await this.db
        .prepare("DELETE FROM briefing_stars WHERE briefing_id = ? AND voter_id = ?")
        .bind(briefingId, voterId)
        .run();
    }

    const countRow = await first<{ count: number }>(
      this.db
        .prepare("SELECT COUNT(*) as count FROM briefing_stars WHERE briefing_id = ?")
        .bind(briefingId)
    );
    const nextStars = Number(countRow?.count ?? 0);

    await this.db
      .prepare("UPDATE briefings SET stars = ?, updated_at = ? WHERE id = ?")
      .bind(nextStars, now.toISOString(), briefingId)
      .run();

    return nextStars;
  }

  async upsertBriefing(input: BriefingConfig, now = new Date()): Promise<BriefingConfig> {
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO briefings (
          id, owner_account_id, slug, title, stars, interest_profile, style_instruction,
          public_feed_enabled, paused, language, intensity, briefing_cadence, briefing_time_of_day,
          briefing_timezone, next_briefing_at, retention_days, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          title = excluded.title,
          stars = excluded.stars,
          interest_profile = excluded.interest_profile,
          style_instruction = excluded.style_instruction,
          public_feed_enabled = excluded.public_feed_enabled,
          paused = excluded.paused,
          language = excluded.language,
          intensity = excluded.intensity,
          briefing_cadence = excluded.briefing_cadence,
          briefing_time_of_day = excluded.briefing_time_of_day,
          briefing_timezone = excluded.briefing_timezone,
          next_briefing_at = excluded.next_briefing_at,
          retention_days = excluded.retention_days,
          updated_at = excluded.updated_at`
      )
      .bind(
        input.id,
        input.ownerAccountId,
        input.slug,
        input.title,
        input.stars,
        input.interestProfile,
        input.styleInstruction ?? null,
        input.publicFeedEnabled ? 1 : 0,
        input.paused ? 1 : 0,
        input.language,
        input.intensity,
        normalizedBriefingCadence(input.briefingCadence),
        normalizedTimeOfDay(input.briefingTimeOfDay),
        input.briefingTimezone || "UTC",
        input.nextBriefingAt ?? null,
        FIXED_RETENTION_DAYS,
        timestamp,
        timestamp
      )
      .run();
    const saved = await this.getBriefingById(input.id);
    return saved ?? input;
  }

  async deleteBriefing(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM briefings WHERE id = ?").bind(id).run();
  }

  async listSources(briefingId: string): Promise<SourceRecord[]> {
    const rows = await all<SourceRow>(
      this.db
        .prepare(
          `SELECT id, briefing_id, title, type, provider, kind, username, input, source_url,
            actor_id, actor_input_json, cursor_json, enabled, last_seen_at, last_checked_at, last_error
          FROM sources
          WHERE briefing_id = ?
          ORDER BY last_seen_at DESC`
        )
        .bind(briefingId)
    );
    return rows.map(rowToSource);
  }

  async getSource(sourceId: string): Promise<SourceRecord | null> {
    const row = await first<SourceRow>(
      this.db
        .prepare(
          `SELECT id, briefing_id, title, type, provider, kind, username, input, source_url,
            actor_id, actor_input_json, cursor_json, enabled, last_seen_at, last_checked_at, last_error
          FROM sources
          WHERE id = ?`
        )
        .bind(sourceId)
    );
    return row ? rowToSource(row) : null;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, now.toISOString(), sourceId)
      .run();
  }

  async deleteSource(sourceId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId).run();
  }

  async upsertConfiguredSource(input: {
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
  }, now = new Date()): Promise<SourceRecord> {
    const sourceId = scopedSourceId(
      input.briefingId,
      stableSourceKey(input.provider, input.kind, input.username ?? input.sourceUrl ?? input.input ?? input.title)
    );
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO sources (
          id, briefing_id, title, type, provider, kind, username, input, source_url,
          actor_id, actor_input_json, enabled, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          provider = excluded.provider,
          kind = excluded.kind,
          username = excluded.username,
          input = excluded.input,
          source_url = excluded.source_url,
          actor_id = excluded.actor_id,
          actor_input_json = excluded.actor_input_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at`
      )
      .bind(
        sourceId,
        input.briefingId,
        input.title,
        input.type ?? "channel",
        input.provider,
        input.kind,
        input.username ?? null,
        input.input ?? null,
        input.sourceUrl ?? input.url ?? null,
        input.actorId ?? null,
        input.actorInput === undefined ? null : JSON.stringify(input.actorInput),
        input.enabled === false ? 0 : 1,
        timestamp,
        timestamp,
        timestamp
      )
      .run();
    const source = await this.getSource(sourceId);
    if (!source) throw new Error("Failed to upsert source");
    return source;
  }

  async updateSourceState(input: {
    sourceId: string;
    title?: string;
    username?: string;
    url?: string;
    sourceUrl?: string;
    lastSeenAt?: string;
    lastCheckedAt?: string;
    lastError?: string;
    cursor?: unknown;
  }, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sources
        SET title = COALESCE(?, title),
          username = COALESCE(?, username),
          source_url = COALESCE(?, source_url),
          last_seen_at = COALESCE(?, last_seen_at),
          last_checked_at = COALESCE(?, last_checked_at),
          last_error = ?,
          cursor_json = COALESCE(?, cursor_json),
          updated_at = ?
        WHERE id = ?`
      )
      .bind(
        input.title ?? null,
        input.username ?? null,
        input.sourceUrl ?? input.url ?? null,
        input.lastSeenAt ?? null,
        input.lastCheckedAt ?? null,
        input.lastError ?? null,
        input.cursor === undefined ? null : JSON.stringify(input.cursor),
        now.toISOString(),
        input.sourceId
      )
      .run();
  }

  async upsertSourceFromMessage(
    briefingId: string,
    message: NormalizedMessage,
    now = new Date()
  ): Promise<SourceRecord> {
    const existingSourceId = await first<{ id: string }>(
      this.db
        .prepare(
          `SELECT id
          FROM sources
          WHERE briefing_id = ?
            AND (id = ? OR (
              provider = ?
              AND kind = ?
              AND ((username IS NOT NULL AND username = ?) OR source_url = ? OR title = ?)
            ))
          LIMIT 1`
        )
        .bind(
          briefingId,
          message.source.id,
          message.source.provider ?? "telegram",
          message.source.kind ?? (message.source.type === "group" ? "telegram_group" : "telegram_channel"),
          message.source.username ?? null,
          message.sourceUrl ?? null,
          message.source.title
        )
    );
    const sourceId = existingSourceId?.id ?? scopedSourceId(briefingId, message.source.id);
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO sources (
          id, briefing_id, title, type, provider, kind, username, input, source_url,
          enabled, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = CASE WHEN sources.provider = 'apify' THEN sources.title ELSE excluded.title END,
          type = excluded.type,
          provider = excluded.provider,
          kind = excluded.kind,
          username = CASE WHEN sources.provider = 'apify' THEN sources.username ELSE excluded.username END,
          source_url = COALESCE(excluded.source_url, source_url),
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        sourceId,
        briefingId,
        message.source.title,
        message.source.type,
        message.source.provider ?? "telegram",
        message.source.kind ?? (message.source.type === "group" ? "telegram_group" : "telegram_channel"),
        message.source.username ?? null,
        message.source.username ? `https://t.me/${message.source.username}` : message.sourceUrl ?? message.source.title,
        message.sourceUrl ?? (message.source.username ? `https://t.me/${message.source.username}` : null),
        message.receivedAt,
        timestamp,
        timestamp
      )
      .run();

    const source = (await this.listSources(briefingId)).find((item) => item.id === sourceId);
    if (!source) throw new Error("Failed to upsert source");
    return source;
  }

  async saveRawMessage(briefingId: string, message: NormalizedMessage, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO raw_messages (
          id, briefing_id, source_id, source_title, source_type, source_provider, source_kind, source_username,
          message_id, text, links_json, media_json, posted_at,
          received_at, source_url, raw_payload_key, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.id,
        briefingId,
        message.source.id,
        message.source.title,
        message.source.type,
        message.source.provider ?? null,
        message.source.kind ?? null,
        message.source.username ?? null,
        message.messageId,
        message.text,
        JSON.stringify(message.links),
        JSON.stringify(message.media),
        message.postedAt,
        message.receivedAt,
        message.sourceUrl ?? null,
        message.rawPayloadKey ?? null,
        message.expiresAt,
        now.toISOString()
      )
      .run();
  }

  async getRawMessage(id: string): Promise<NormalizedMessage | null> {
    const row = await first<RawMessageRow>(
      this.db
        .prepare(
          `SELECT raw_messages.*,
            COALESCE(raw_messages.source_title, sources.title) as message_source_title,
            COALESCE(raw_messages.source_type, sources.type) as message_source_type,
            COALESCE(raw_messages.source_provider, sources.provider) as message_source_provider,
            COALESCE(raw_messages.source_kind, sources.kind) as message_source_kind,
            COALESCE(raw_messages.source_username, sources.username) as message_source_username,
            sources.title, sources.type, sources.provider, sources.kind, sources.username
          FROM raw_messages
          JOIN sources ON sources.id = raw_messages.source_id
          WHERE raw_messages.id = ?`
        )
        .bind(id)
    );
    return row ? rowToRawMessage(row) : null;
  }

  async listRecentRawMessages(briefingId: string, now = new Date(), limit = 50): Promise<NormalizedMessage[]> {
    const rows = await all<RawMessageRow>(
      this.db
        .prepare(
          `SELECT raw_messages.*,
            COALESCE(raw_messages.source_title, sources.title) as message_source_title,
            COALESCE(raw_messages.source_type, sources.type) as message_source_type,
            COALESCE(raw_messages.source_provider, sources.provider) as message_source_provider,
            COALESCE(raw_messages.source_kind, sources.kind) as message_source_kind,
            COALESCE(raw_messages.source_username, sources.username) as message_source_username,
            sources.title, sources.type, sources.provider, sources.kind, sources.username
          FROM raw_messages
          JOIN sources ON sources.id = raw_messages.source_id
          WHERE raw_messages.briefing_id = ? AND raw_messages.expires_at > ?
          ORDER BY raw_messages.posted_at DESC
          LIMIT ?`
        )
        .bind(briefingId, now.toISOString(), limit)
    );
    return rows.map(rowToRawMessage);
  }

  async listRawMessagesForWindow(
    briefingId: string,
    windowStart: string,
    windowEnd: string,
    limit = 500
  ): Promise<NormalizedMessage[]> {
    const rows = await all<RawMessageRow>(
      this.db
        .prepare(
          `SELECT raw_messages.*,
            COALESCE(raw_messages.source_title, sources.title) as message_source_title,
            COALESCE(raw_messages.source_type, sources.type) as message_source_type,
            COALESCE(raw_messages.source_provider, sources.provider) as message_source_provider,
            COALESCE(raw_messages.source_kind, sources.kind) as message_source_kind,
            COALESCE(raw_messages.source_username, sources.username) as message_source_username,
            sources.title, sources.type, sources.provider, sources.kind, sources.username
          FROM raw_messages
          JOIN sources ON sources.id = raw_messages.source_id
          WHERE raw_messages.briefing_id = ?
            AND raw_messages.posted_at >= ?
            AND raw_messages.posted_at < ?
            AND raw_messages.expires_at > ?
          ORDER BY raw_messages.posted_at ASC
          LIMIT ?`
        )
        .bind(briefingId, windowStart, windowEnd, new Date().toISOString(), limit)
    );
    return rows.map(rowToRawMessage);
  }

  async createProcessingJob(briefingId: string, rawMessageId: string, now = new Date()): Promise<string> {
    const id = `job_${crypto.randomUUID()}`;
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        "INSERT INTO processing_jobs (id, briefing_id, raw_message_id, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)"
      )
      .bind(id, briefingId, rawMessageId, timestamp, timestamp)
      .run();
    return id;
  }

  async completeProcessingJob(jobId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE processing_jobs SET state = 'completed', updated_at = ? WHERE id = ?")
      .bind(now.toISOString(), jobId)
      .run();
  }

  async failProcessingJob(jobId: string, error: string, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE processing_jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(error, now.toISOString(), jobId)
      .run();
  }

  async listProcessingJobs(input?: {
    briefingId?: string;
    states?: ProcessingJobState[];
    limit?: number;
  }): Promise<ProcessingJobRecord[]> {
    const states = input?.states?.length ? input.states : ["queued", "completed", "failed"];
    const placeholders = states.map(() => "?").join(", ");
    const values: DbValue[] = [...states];
    let sql =
      `SELECT id, briefing_id, raw_message_id, state, error, updated_at
       FROM processing_jobs
       WHERE state IN (${placeholders})`;

    if (input?.briefingId) {
      sql += " AND briefing_id = ?";
      values.push(input.briefingId);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    values.push(input?.limit ?? 50);

    const rows = await all<ProcessingJobRow>(this.db.prepare(sql).bind(...values));
    return rows.map(rowToProcessingJob);
  }

  async requeueProcessingJob(jobId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE processing_jobs SET state = 'queued', error = NULL, updated_at = ? WHERE id = ?")
      .bind(now.toISOString(), jobId)
      .run();
  }

  async getExistingItems(briefingId: string, now = new Date()): Promise<BriefingItem[]> {
    return this.listBriefingItems(briefingId, true, now);
  }

  private async listBriefingItems(
    briefingId: string,
    includeEvidence: boolean,
    now = new Date(),
    collapseDuplicates = true
  ): Promise<BriefingItem[]> {
    const rows = await all<BriefingItemRow>(
      this.db
        .prepare(
          "SELECT id, cluster_id, event_key, summary, item_at, updated_at, expires_at, merged_update_count FROM briefing_items WHERE briefing_id = ? AND expires_at > ? ORDER BY item_at DESC"
        )
        .bind(briefingId, now.toISOString())
    );
    if (!includeEvidence) {
      return collapseBriefingItemsByStoredEventKey(rows.map((row) => ({ ...rowToBriefingItem(row), evidence: [] })));
    }

    const evidenceByItemId =
      includeEvidence || collapseDuplicates ? await this.getEvidenceByItemIds(rows.map((row) => row.id)) : new Map<string, BriefingEvidence[]>();
    const items: BriefingItem[] = [];
    for (const row of rows) {
      items.push({ ...rowToBriefingItem(row), evidence: evidenceByItemId.get(row.id) ?? [] });
    }
    const briefing = collapseDuplicates ? await this.getBriefingById(briefingId) : null;
    const nextItems = briefing ? collapseDuplicateBriefingItems(items, briefing) : items;
    return includeEvidence ? nextItems : nextItems.map((item) => ({ ...item, evidence: [] }));
  }

  async saveBriefingItems(briefingId: string, items: BriefingItem[], now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    const briefing = await this.getBriefingById(briefingId);
    const collapsedItems = collapseDuplicateBriefingItems(items, briefing ?? undefined);
    const processedRawMessageIds = Array.from(new Set(
      collapsedItems.flatMap((item) => item.evidence.map((entry) => entry.messageId))
    ));
    for (const inputItem of collapsedItems) {
      const item = await this.resolveDuplicateTarget(briefingId, inputItem, briefing ?? undefined, now);
      await this.writeBriefingItem(briefingId, item, timestamp);
    }

    for (const batch of chunk(processedRawMessageIds, 50)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      await this.db
        .prepare(`UPDATE raw_messages SET processed_at = ? WHERE id IN (${placeholders})`)
        .bind(timestamp, ...batch)
        .run();
    }
  }

  async repairDuplicateBriefingItems(briefingId: string, now = new Date()): Promise<number> {
    const briefing = await this.getBriefingById(briefingId);
    const items = await this.listBriefingItems(briefingId, true, now, false);
    const survivors: BriefingItem[] = [];
    const loserIds: string[] = [];

    for (const item of items) {
      const existing = survivors.find((candidate) =>
        eventKeysForItem(candidate).some((key) => eventKeysForItem(item).includes(key))
      );
      const match = existing ?? survivors.find((candidate) => collapseDuplicateBriefingItems([candidate, item], briefing ?? undefined).length === 1);
      if (match) {
        mergeBriefingItem(match, item, briefing ?? undefined);
        loserIds.push(item.id);
      } else {
        survivors.push(item);
      }
    }

    if (loserIds.length === 0) return 0;
    await this.deleteBriefingItems(loserIds);
    const timestamp = now.toISOString();
    for (const survivor of survivors) await this.writeBriefingItem(briefingId, survivor, timestamp);
    return loserIds.length;
  }

  async listFeedItems(ownerAccountId: string, slug: string, includeEvidence: boolean, now = new Date()): Promise<BriefingItem[]> {
    const briefing = await this.getBriefingBySlug(ownerAccountId, slug);
    if (!briefing) return [];
    return this.listBriefingItems(briefing.id, includeEvidence, now);
  }

  async getFeedItemEvidence(briefingId: string, itemId: string, now = new Date()): Promise<BriefingEvidence[]> {
    const rows = await all<EvidenceRow>(
      this.db
        .prepare(
          `SELECT raw_message_id, source_id, source_title, source_type, source_provider, source_kind,
            source_url, posted_at, text, links_json, media_json
          FROM briefing_item_evidence
          JOIN briefing_items ON briefing_items.id = briefing_item_evidence.briefing_item_id
          WHERE briefing_item_evidence.briefing_item_id = ?
            AND briefing_items.briefing_id = ?
            AND briefing_items.expires_at > ?
          ORDER BY posted_at ASC`
        )
        .bind(itemId, briefingId, now.toISOString())
    );
    return rows.map(rowToEvidence);
  }

  async saveBriefingEdition(edition: BriefingEdition, now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO briefing_editions (
          id, briefing_id, cadence, window_start, window_end, title, summary,
          sections_json, status, published_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(briefing_id, cadence, window_start, window_end) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          sections_json = excluded.sections_json,
          status = excluded.status,
          published_at = excluded.published_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        edition.id,
        edition.briefingId,
        edition.cadence,
        edition.windowStart,
        edition.windowEnd,
        edition.title,
        edition.summary,
        JSON.stringify(edition.sections),
        edition.status,
        edition.publishedAt,
        edition.createdAt,
        timestamp
      )
      .run();
  }

  async listBriefingEditions(
    briefingId: string,
    includeSections: boolean,
    now = new Date(),
    limit = 50
  ): Promise<BriefingEdition[]> {
    const rows = await all<BriefingEditionRow>(
      this.db
        .prepare(
          `SELECT id, briefing_id, cadence, window_start, window_end, title, summary,
            sections_json, status, published_at, created_at, updated_at
          FROM briefing_editions
          WHERE briefing_id = ?
            AND published_at <= ?
          ORDER BY published_at DESC
          LIMIT ?`
        )
        .bind(briefingId, now.toISOString(), limit)
    );
    return rows.map((row) => rowToBriefingEdition(row, includeSections));
  }

  async getBriefingEdition(briefingId: string, editionId: string, now = new Date()): Promise<BriefingEdition | null> {
    const row = await first<BriefingEditionRow>(
      this.db
        .prepare(
          `SELECT id, briefing_id, cadence, window_start, window_end, title, summary,
            sections_json, status, published_at, created_at, updated_at
          FROM briefing_editions
          WHERE briefing_id = ?
            AND id = ?
            AND published_at <= ?`
        )
        .bind(briefingId, editionId, now.toISOString())
    );
    return row ? rowToBriefingEdition(row, true) : null;
  }

  async getHealth(briefingId?: string): Promise<HealthStatus> {
    const lastImportedMessageAt =
      (briefingId
        ? await this.getSetting(`last_imported_message_at:${briefingId}`)
        : null) ??
      (await this.getSetting("last_imported_message_at")) ??
      undefined;
    const lastSourceFetchAt =
      (briefingId
        ? await this.getSetting(`last_source_fetch_at:${briefingId}`)
        : null) ??
      (await this.getSetting("last_source_fetch_at")) ??
      undefined;
    const lastSourceEventAt =
      lastImportedMessageAt ??
      (briefingId
        ? await this.getSetting(`last_source_event_at:${briefingId}`)
        : null) ??
      (briefingId
        ? await this.getSetting(`last_telegram_event_at:${briefingId}`)
        : null) ??
      (await this.getSetting("last_source_event_at")) ??
      (await this.getSetting("last_telegram_event_at")) ??
      undefined;
    const rows = briefingId
      ? await all<{ state: "queued" | "completed" | "failed"; count: number }>(
          this.db
            .prepare("SELECT state, COUNT(*) as count FROM processing_jobs WHERE briefing_id = ? GROUP BY state")
            .bind(briefingId)
        )
      : await all<{ state: "queued" | "completed" | "failed"; count: number }>(
          this.db.prepare("SELECT state, COUNT(*) as count FROM processing_jobs GROUP BY state")
        );
    const processing = { queued: 0, completed: 0, failed: 0 };
    for (const row of rows) processing[row.state] = row.count;
    const latestPublishedRow = briefingId
      ? await first<{ latest_published_at: string | null }>(
          this.db
            .prepare(
              `SELECT MAX(published_at) as latest_published_at
              FROM briefing_editions
              WHERE briefing_id = ?
                AND published_at <= ?`
            )
            .bind(briefingId, new Date().toISOString())
        )
      : await first<{ latest_published_at: string | null }>(
          this.db
            .prepare("SELECT MAX(published_at) as latest_published_at FROM briefing_editions WHERE published_at <= ?")
            .bind(new Date().toISOString())
        );
    const briefing = briefingId ? await this.getBriefingById(briefingId) : null;
    return {
      lastSourceEventAt,
      lastSourceFetchAt,
      lastImportedMessageAt,
      latestPublishedAt: latestPublishedRow?.latest_published_at ?? undefined,
      nextBriefingAt: briefing?.nextBriefingAt,
      processing
    };
  }

  async createSourceRun(input: {
    sourceId: string;
    briefingId: string;
    provider: SourceProvider;
    actorId?: string;
    actorRunId?: string;
    datasetId?: string;
    state: SourceRunState;
    estimatedCostUsd?: number;
    startedAt?: string;
  }, now = new Date()): Promise<SourceRunRecord> {
    const id = `source_run_${crypto.randomUUID()}`;
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO source_runs (
          id, source_id, briefing_id, provider, actor_id, actor_run_id, dataset_id,
          state, estimated_cost_usd, started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.sourceId,
        input.briefingId,
        input.provider,
        input.actorId ?? null,
        input.actorRunId ?? null,
        input.datasetId ?? null,
        input.state,
        input.estimatedCostUsd ?? null,
        input.startedAt ?? timestamp,
        timestamp,
        timestamp
      )
      .run();
    const run = (await this.listSourceRuns({ sourceId: input.sourceId, limit: 1 })).find((item) => item.id === id);
    if (!run) throw new Error("Failed to create source run");
    return run;
  }

  async updateSourceRun(input: {
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
  }, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE source_runs
        SET actor_run_id = COALESCE(?, actor_run_id),
          dataset_id = COALESCE(?, dataset_id),
          state = COALESCE(?, state),
          item_count = COALESCE(?, item_count),
          estimated_cost_usd = COALESCE(?, estimated_cost_usd),
          actual_cost_usd = COALESCE(?, actual_cost_usd),
          archive_key = COALESCE(?, archive_key),
          error = ?,
          completed_at = COALESCE(?, completed_at),
          updated_at = ?
        WHERE id = ?`
      )
      .bind(
        input.actorRunId ?? null,
        input.datasetId ?? null,
        input.state ?? null,
        input.itemCount ?? null,
        input.estimatedCostUsd ?? null,
        input.actualCostUsd ?? null,
        input.archiveKey ?? null,
        input.error ?? null,
        input.completedAt ?? null,
        now.toISOString(),
        input.id
      )
      .run();
  }

  async listSourceRuns(input?: {
    briefingId?: string;
    sourceId?: string;
    states?: SourceRunState[];
    limit?: number;
  }): Promise<SourceRunRecord[]> {
    const values: DbValue[] = [];
    let sql =
      `SELECT id, source_id, briefing_id, provider, actor_id, actor_run_id, dataset_id,
        state, item_count, estimated_cost_usd, actual_cost_usd, archive_key, error, started_at, completed_at, updated_at
      FROM source_runs
      WHERE 1 = 1`;

    if (input?.briefingId) {
      sql += " AND briefing_id = ?";
      values.push(input.briefingId);
    }
    if (input?.sourceId) {
      sql += " AND source_id = ?";
      values.push(input.sourceId);
    }
    if (input?.states?.length) {
      sql += ` AND state IN (${input.states.map(() => "?").join(", ")})`;
      values.push(...input.states);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    values.push(input?.limit ?? 50);

    const rows = await all<SourceRunRow>(this.db.prepare(sql).bind(...values));
    return rows.map(rowToSourceRun);
  }

  async sumSourceRunCosts(input: {
    briefingId: string;
    sourceId?: string;
    since: string;
  }): Promise<number> {
    const values: DbValue[] = [input.briefingId, input.since];
    let sql =
      `SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) as total
      FROM source_runs
      WHERE briefing_id = ?
        AND started_at >= ?`;
    if (input.sourceId) {
      sql += " AND source_id = ?";
      values.push(input.sourceId);
    }
    const row = await first<{ total: number | null }>(this.db.prepare(sql).bind(...values));
    return Number(row?.total ?? 0);
  }

  async recordLlmUsage(input: {
    briefingId: string;
    model: string;
    purpose: "summary" | "importance_review" | "event_review";
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO llm_usage_events (
          id, briefing_id, model, purpose, input_tokens, output_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        `llm_usage_${crypto.randomUUID()}`,
        input.briefingId,
        input.model,
        input.purpose,
        input.inputTokens,
        input.outputTokens,
        input.estimatedCostUsd,
        now.toISOString()
      )
      .run();
  }

  async sumLlmUsageCost(input: {
    briefingId: string;
    since: string;
  }): Promise<number> {
    const row = await first<{ total: number | null }>(
      this.db
        .prepare("SELECT SUM(estimated_cost_usd) as total FROM llm_usage_events WHERE briefing_id = ? AND created_at >= ?")
        .bind(input.briefingId, input.since)
    );
    return Number(row?.total ?? 0);
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await first<{ value: string }>(this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key));
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .bind(key, value, now.toISOString())
      .run();
  }

  async listExpiredRawPayloadKeys(now = new Date()): Promise<string[]> {
    const rows = await all<{ raw_payload_key: string }>(
      this.db
        .prepare(
          `SELECT raw_payload_key
          FROM raw_messages
          WHERE raw_payload_key IS NOT NULL
            AND raw_payload_key != ''
          GROUP BY raw_payload_key
          HAVING MAX(expires_at) <= ?`
        )
        .bind(now.toISOString())
    );
    return rows.map((row) => row.raw_payload_key);
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const timestamp = now.toISOString();
    const result = await this.db
      .prepare("DELETE FROM raw_messages WHERE expires_at <= ?")
      .bind(timestamp)
      .run();
    await this.db.prepare("DELETE FROM briefing_items WHERE expires_at <= ?").bind(timestamp).run();
    await this.db.prepare("DELETE FROM clusters WHERE expires_at <= ?").bind(timestamp).run();
    await this.db
      .prepare("DELETE FROM briefing_item_event_keys WHERE briefing_item_id NOT IN (SELECT id FROM briefing_items)")
      .run();
    await this.db.prepare("DELETE FROM auth_tokens WHERE expires_at <= ?").bind(timestamp).run();
    await this.db
      .prepare("DELETE FROM auth_attempts WHERE created_at <= ?")
      .bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .run();
    return Number(result.meta.changes ?? 0);
  }

  private async getEvidence(itemId: string): Promise<BriefingEvidence[]> {
    const rows = await all<EvidenceRow>(
      this.db
        .prepare(
          `SELECT raw_message_id, source_id, source_title, source_type, source_provider, source_kind,
            source_url, posted_at, text, links_json, media_json
          FROM briefing_item_evidence
          WHERE briefing_item_id = ?
          ORDER BY posted_at ASC`
        )
        .bind(itemId)
    );
    return rows.map(rowToEvidence);
  }

  private async getEvidenceByItemIds(itemIds: string[]): Promise<Map<string, BriefingEvidence[]>> {
    const evidenceByItemId = new Map<string, BriefingEvidence[]>();
    const uniqueItemIds = Array.from(new Set(itemIds));
    for (const itemId of uniqueItemIds) evidenceByItemId.set(itemId, []);

    const batchSize = 100;
    for (let index = 0; index < uniqueItemIds.length; index += batchSize) {
      const batch = uniqueItemIds.slice(index, index + batchSize);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      const rows = await all<EvidenceWithItemRow>(
        this.db
          .prepare(
            `SELECT briefing_item_id, raw_message_id, source_id, source_title, source_type, source_provider, source_kind,
              source_url, posted_at, text, links_json, media_json
            FROM briefing_item_evidence
            WHERE briefing_item_id IN (${placeholders})
            ORDER BY briefing_item_id ASC, posted_at ASC`
          )
          .bind(...batch)
      );

      for (const row of rows) evidenceByItemId.get(row.briefing_item_id)?.push(rowToEvidence(row));
    }

    return evidenceByItemId;
  }

  private async resolveDuplicateTarget(
    briefingId: string,
    inputItem: BriefingItem,
    briefing: BriefingConfig | undefined,
    now: Date
  ): Promise<BriefingItem> {
    const item = {
      ...inputItem,
      eventKey: inputItem.eventKey ?? primaryEventKeyForEvidence(inputItem.evidence)
    };
    const targetId = await this.findDuplicateItemId(briefingId, item);
    if (!targetId || targetId === item.id) return item;
    const target = await this.getBriefingItemById(briefingId, targetId, now);
    return target ? mergeBriefingItem(target, item, briefing) : item;
  }

  private async findDuplicateItemId(briefingId: string, item: BriefingItem): Promise<string | undefined> {
    const rawMessageIds = Array.from(new Set(item.evidence.map((entry) => entry.messageId)));
    if (rawMessageIds.length > 0) {
      const placeholders = rawMessageIds.map(() => "?").join(", ");
      const row = await first<{ briefing_item_id: string }>(
        this.db
          .prepare(
            `SELECT briefing_item_evidence.briefing_item_id
             FROM briefing_item_evidence
             JOIN briefing_items ON briefing_items.id = briefing_item_evidence.briefing_item_id
             WHERE briefing_items.briefing_id = ?
               AND briefing_item_evidence.raw_message_id IN (${placeholders})
             ORDER BY briefing_items.item_at DESC
             LIMIT 1`
          )
          .bind(briefingId, ...rawMessageIds)
      );
      if (row?.briefing_item_id) return row.briefing_item_id;
    }

    const eventKeys = eventKeysForItem(item);
    if (eventKeys.length === 0) return undefined;
    const placeholders = eventKeys.map(() => "?").join(", ");
    const row = await first<{ briefing_item_id: string }>(
      this.db
        .prepare(
          `SELECT briefing_item_id
           FROM briefing_item_event_keys
           WHERE briefing_id = ?
             AND event_key IN (${placeholders})
           LIMIT 1`
        )
        .bind(briefingId, ...eventKeys)
    );
    return row?.briefing_item_id;
  }

  private async getBriefingItemById(
    briefingId: string,
    itemId: string,
    now = new Date()
  ): Promise<BriefingItem | null> {
    const row = await first<BriefingItemRow>(
      this.db
        .prepare(
          `SELECT id, cluster_id, event_key, summary, item_at, updated_at, expires_at, merged_update_count
           FROM briefing_items
           WHERE briefing_id = ?
             AND id = ?
             AND expires_at > ?`
        )
        .bind(briefingId, itemId, now.toISOString())
    );
    return row ? { ...rowToBriefingItem(row), evidence: await this.getEvidence(row.id) } : null;
  }

  private async writeBriefingItem(
    briefingId: string,
    inputItem: BriefingItem,
    timestamp: string
  ): Promise<void> {
    const item = {
      ...inputItem,
      eventKey: inputItem.eventKey ?? primaryEventKeyForEvidence(inputItem.evidence),
      mergedUpdateCount: Math.max(0, inputItem.evidence.length - 1)
    };

    await this.db
      .prepare(
        `INSERT INTO clusters (id, briefing_id, status, first_seen_at, last_updated_at, expires_at)
        VALUES (?, ?, 'published', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = 'published',
          last_updated_at = excluded.last_updated_at,
          expires_at = excluded.expires_at`
      )
      .bind(item.clusterId, briefingId, item.itemAt, item.updatedAt, item.expiresAt)
      .run();

    await this.db
      .prepare(
        `INSERT INTO briefing_items (
          id, briefing_id, cluster_id, event_key, summary, item_at, updated_at, expires_at, merged_update_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cluster_id = excluded.cluster_id,
          event_key = excluded.event_key,
          summary = excluded.summary,
          item_at = excluded.item_at,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          merged_update_count = excluded.merged_update_count`
      )
      .bind(
        item.id,
        briefingId,
        item.clusterId,
        item.eventKey,
        item.summary,
        item.itemAt,
        item.updatedAt,
        item.expiresAt,
        item.mergedUpdateCount
      )
      .run();

    await this.db
      .prepare("DELETE FROM briefing_item_event_keys WHERE briefing_item_id = ?")
      .bind(item.id)
      .run();

    for (const eventKey of eventKeysForItem(item)) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO briefing_item_event_keys (briefing_id, event_key, briefing_item_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(briefingId, eventKey, item.id, timestamp)
        .run();
    }

    for (const evidence of item.evidence) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO briefing_item_evidence (
            id, briefing_item_id, raw_message_id, source_id, source_title, source_type,
            source_provider, source_kind, source_url, posted_at, text, links_json, media_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          `evidence_${item.id}_${evidence.messageId}`,
          item.id,
          evidence.messageId,
          evidence.sourceId,
          evidence.sourceTitle,
          evidence.sourceType,
          evidence.sourceProvider ?? null,
          evidence.sourceKind ?? null,
          evidence.sourceUrl ?? null,
          evidence.postedAt,
          evidence.text,
          JSON.stringify(evidence.links),
          JSON.stringify(evidence.media)
        )
        .run();
    }
  }

  private async deleteBriefingItems(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const placeholders = itemIds.map(() => "?").join(", ");
    await this.db.prepare(`DELETE FROM briefing_item_event_keys WHERE briefing_item_id IN (${placeholders})`).bind(...itemIds).run();
    await this.db.prepare(`DELETE FROM briefing_item_evidence WHERE briefing_item_id IN (${placeholders})`).bind(...itemIds).run();
    await this.db.prepare(`DELETE FROM briefing_items WHERE id IN (${placeholders})`).bind(...itemIds).run();
  }
}

export class InMemoryRepository implements Repository {
  accounts = new Map<string, AccountRecord & { passwordHash: string }>();
  aliases = new Map<string, UsernameAliasRecord>();
  tokens = new Map<string, AuthTokenRecord>();
  attempts: Array<{ key: string; action: string; createdAt: string }> = [];
  briefings = new Map<string, BriefingConfig>();
  briefingCreatedAt = new Map<string, string>();
  sources = new Map<string, SourceRecord>();
  sourceRuns = new Map<string, SourceRunRecord>();
  llmUsageEvents: Array<{
    briefingId: string;
    model: string;
    purpose: "summary" | "importance_review" | "event_review";
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    createdAt: string;
  }> = [];
  rawMessages = new Map<string, NormalizedMessage>();
  itemsByBriefing = new Map<string, Map<string, BriefingItem>>();
  editionsByBriefing = new Map<string, Map<string, BriefingEdition>>();
  starsByBriefing = new Map<string, Set<string>>();
  jobs = new Map<string, {
    id: string;
    briefingId: string;
    rawMessageId: string;
    state: "queued" | "completed" | "failed";
    error?: string;
    updatedAt: string;
  }>();
  settings = new Map<string, string>();

  async createAccount(input: {
    email: string;
    username: string;
    role: AccountRole;
    passwordHash: string;
    emailVerifiedAt?: string;
  }, now = new Date()): Promise<AccountRecord> {
    const id = `account_${this.accounts.size + 1}`;
    const timestamp = now.toISOString();
    const account = {
      id,
      email: input.email,
      username: input.username,
      role: input.role,
      passwordHash: input.passwordHash,
      emailVerifiedAt: input.emailVerifiedAt,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.accounts.set(id, account);
    this.aliases.set(input.username, { username: input.username, accountId: id, isCurrent: true, createdAt: timestamp });
    return rowlessAccount(account);
  }

  async listAccounts(): Promise<AccountWithStats[]> {
    return Array.from(this.accounts.values()).map((account) => ({
      ...rowlessAccount(account),
      briefingCount: Array.from(this.briefings.values()).filter((briefing) => briefing.ownerAccountId === account.id).length
    }));
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);

    for (const [username, alias] of this.aliases) {
      if (alias.accountId === id) this.aliases.delete(username);
    }

    for (const [tokenId, token] of this.tokens) {
      if (token.accountId === id) this.tokens.delete(tokenId);
    }

    for (const briefing of Array.from(this.briefings.values())) {
      if (briefing.ownerAccountId === id) await this.deleteBriefing(briefing.id);
    }
  }

  async getAccountById(id: string): Promise<AccountRecord | null> {
    const account = this.accounts.get(id);
    return account ? rowlessAccount(account) : null;
  }

  async getAccountByEmail(email: string): Promise<(AccountRecord & { passwordHash: string }) | null> {
    const account = Array.from(this.accounts.values()).find((item) => item.email === email);
    return account ? { ...rowlessAccount(account), passwordHash: account.passwordHash } : null;
  }

  async getAccountByUsername(username: string): Promise<AccountRecord | null> {
    const account = Array.from(this.accounts.values()).find((item) => item.username === username);
    return account ? rowlessAccount(account) : null;
  }

  async resolveUsernameAlias(username: string): Promise<{ account: AccountRecord; alias: UsernameAliasRecord } | null> {
    const alias = this.aliases.get(username);
    if (!alias) return null;
    const account = await this.getAccountById(alias.accountId);
    if (!account) return null;
    return { account, alias: { ...alias } };
  }

  async updateAccount(input: {
    id: string;
    username?: string;
    role?: AccountRole;
    disabled?: boolean;
    emailVerifiedAt?: string;
    passwordHash?: string;
  }, now = new Date()): Promise<AccountRecord> {
    const account = this.accounts.get(input.id);
    if (!account) throw new Error("account not found");
    const timestamp = now.toISOString();
    if (input.username && input.username !== account.username) {
      for (const alias of this.aliases.values()) {
        if (alias.accountId === input.id && alias.isCurrent) alias.isCurrent = false;
      }
      this.aliases.set(input.username, { username: input.username, accountId: input.id, isCurrent: true, createdAt: timestamp });
      account.username = input.username;
    }
    if (input.role) account.role = input.role;
    if (input.disabled !== undefined) account.disabledAt = input.disabled ? timestamp : undefined;
    if (input.emailVerifiedAt) account.emailVerifiedAt = input.emailVerifiedAt;
    if (input.passwordHash) account.passwordHash = input.passwordHash;
    account.updatedAt = timestamp;
    return rowlessAccount(account);
  }

  async countAdmins(): Promise<number> {
    return Array.from(this.accounts.values()).filter((account) => account.role === "admin" && !account.disabledAt).length;
  }

  async createAuthToken(input: {
    accountId: string;
    purpose: AuthTokenPurpose;
    tokenHash: string;
    expiresAt: string;
  }, now = new Date()): Promise<AuthTokenRecord> {
    const token = {
      id: `token_${this.tokens.size + 1}`,
      accountId: input.accountId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: now.toISOString()
    };
    this.tokens.set(token.id, token);
    return { ...token };
  }

  async getAuthToken(tokenHash: string, purpose: AuthTokenPurpose): Promise<AuthTokenRecord | null> {
    const token = Array.from(this.tokens.values()).find((item) => item.tokenHash === tokenHash && item.purpose === purpose);
    return token ? { ...token } : null;
  }

  async consumeAuthToken(id: string, now = new Date()): Promise<void> {
    const token = this.tokens.get(id);
    if (token) token.consumedAt = now.toISOString();
  }

  async countRecentAuthAttempts(input: { key: string; action: string; since: string }): Promise<number> {
    return this.attempts.filter(
      (attempt) => attempt.key === input.key && attempt.action === input.action && attempt.createdAt >= input.since
    ).length;
  }

  async recordAuthAttempt(input: { key: string; action: string }, now = new Date()): Promise<void> {
    this.attempts.push({ ...input, createdAt: now.toISOString() });
  }

  async ensureDefaultBriefing(account: AccountRecord, now = new Date()): Promise<BriefingConfig> {
    const existing = await this.getBriefingBySlug(account.id, personalNewsBriefing.slug);
    if (existing) return existing;
    const briefing = {
      ...personalNewsBriefing,
      id: `briefing_${account.id}_personal`,
      ownerAccountId: account.id,
      ownerUsername: account.username,
      nextBriefingAt: defaultNextBriefingAt({ now })
    };
    return this.upsertBriefing(briefing, now);
  }

  async listBriefings(accountId?: string): Promise<BriefingConfig[]> {
    return Array.from(this.briefings.values())
      .filter((briefing) => !accountId || briefing.ownerAccountId === accountId)
      .map((briefing) => this.withCurrentBriefingOwner(briefing))
      .sort((a, b) => compareBriefingsByStarsAndAge(a, b, this.briefingCreatedAt))
      .map((briefing) => briefing);
  }

  async listExploreBriefings(limit: number): Promise<BriefingConfig[]> {
    if (limit <= 0) return [];
    return Array.from(this.briefings.values())
      .filter((briefing) => briefing.stars > 0 && !this.accounts.get(briefing.ownerAccountId)?.disabledAt)
      .map((briefing) => this.withCurrentBriefingOwner(briefing))
      .sort((a, b) => compareBriefingsByStarsAndAge(a, b, this.briefingCreatedAt))
      .slice(0, limit);
  }

  async getBriefingById(id: string): Promise<BriefingConfig | null> {
    const briefing = this.briefings.get(id);
    return briefing ? this.withCurrentBriefingOwner(briefing) : null;
  }

  async getBriefingBySlug(ownerAccountId: string, slug: string): Promise<BriefingConfig | null> {
    const briefing = Array.from(this.briefings.values()).find(
      (briefing) => briefing.ownerAccountId === ownerAccountId && briefing.slug === slug
    );
    return briefing ? this.withCurrentBriefingOwner(briefing) : null;
  }

  async hasBriefingStar(briefingId: string, voterId: string): Promise<boolean> {
    return this.starsByBriefing.get(briefingId)?.has(voterId) ?? false;
  }

  async setBriefingStar(briefingId: string, voterId: string, starred: boolean): Promise<number> {
    const votes = this.starsByBriefing.get(briefingId) ?? new Set<string>();
    if (starred) votes.add(voterId);
    else votes.delete(voterId);
    this.starsByBriefing.set(briefingId, votes);

    const briefing = this.briefings.get(briefingId);
    if (briefing) briefing.stars = votes.size;
    return votes.size;
  }

  async upsertBriefing(input: BriefingConfig, now = new Date()): Promise<BriefingConfig> {
    const account = this.accounts.get(input.ownerAccountId);
    if (!this.briefingCreatedAt.has(input.id)) this.briefingCreatedAt.set(input.id, now.toISOString());
    this.briefings.set(input.id, {
      ...input,
      briefingCadence: normalizedBriefingCadence(input.briefingCadence),
      briefingTimeOfDay: normalizedTimeOfDay(input.briefingTimeOfDay),
      briefingTimezone: input.briefingTimezone || "UTC",
      retentionDays: FIXED_RETENTION_DAYS,
      ownerUsername: account?.username ?? input.ownerUsername
    });
    return { ...this.briefings.get(input.id)! };
  }

  private withCurrentBriefingOwner(briefing: BriefingConfig): BriefingConfig {
    const account = this.accounts.get(briefing.ownerAccountId);
    return { ...briefing, ownerUsername: account?.username ?? briefing.ownerUsername };
  }

  async deleteBriefing(id: string): Promise<void> {
    this.briefings.delete(id);
    this.briefingCreatedAt.delete(id);

    for (const [sourceId, source] of this.sources) {
      if (source.briefingId === id) this.sources.delete(sourceId);
    }

    for (const [rawMessageId, message] of this.rawMessages) {
      if (message.id.startsWith(`${id}::`)) this.rawMessages.delete(rawMessageId);
    }

    this.itemsByBriefing.delete(id);
    this.editionsByBriefing.delete(id);
    this.starsByBriefing.delete(id);

    for (const [jobId, job] of this.jobs) {
      if (job.briefingId === id) this.jobs.delete(jobId);
    }
  }

  async listSources(briefingId: string): Promise<SourceRecord[]> {
    return Array.from(this.sources.values()).filter((source) => source.briefingId === briefingId);
  }

  async getSource(sourceId: string): Promise<SourceRecord | null> {
    const source = this.sources.get(sourceId);
    return source ? { ...source } : null;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.sources.get(sourceId);
    if (source) source.enabled = enabled;
  }

  async deleteSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
    for (const [runId, run] of this.sourceRuns) {
      if (run.sourceId === sourceId) this.sourceRuns.delete(runId);
    }
    for (const [id, message] of this.rawMessages) {
      if (message.source.id === sourceId) this.rawMessages.delete(id);
    }
  }

  async upsertConfiguredSource(input: {
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
  }, now = new Date()): Promise<SourceRecord> {
    const id = scopedSourceId(
      input.briefingId,
      stableSourceKey(input.provider, input.kind, input.username ?? input.sourceUrl ?? input.input ?? input.title)
    );
    const existing = this.sources.get(id);
    const source: SourceRecord = {
      id,
      briefingId: input.briefingId,
      title: input.title,
      type: input.type ?? "channel",
      provider: input.provider,
      kind: input.kind,
      username: input.username,
      input: input.input,
      url: input.url ?? input.sourceUrl,
      sourceUrl: input.sourceUrl ?? input.url,
      actorId: input.actorId,
      actorInput: input.actorInput,
      enabled: input.enabled ?? true,
      lastSeenAt: existing?.lastSeenAt ?? now.toISOString(),
      lastCheckedAt: existing?.lastCheckedAt,
      lastError: existing?.lastError,
      cursor: existing?.cursor
    };
    this.sources.set(id, source);
    return { ...source };
  }

  async updateSourceState(input: {
    sourceId: string;
    title?: string;
    username?: string;
    url?: string;
    sourceUrl?: string;
    lastSeenAt?: string;
    lastCheckedAt?: string;
    lastError?: string;
    cursor?: unknown;
  }): Promise<void> {
    const source = this.sources.get(input.sourceId);
    if (!source) return;
    if (input.title) source.title = input.title;
    if (input.username) source.username = input.username;
    if (input.url || input.sourceUrl) {
      source.url = input.url ?? input.sourceUrl;
      source.sourceUrl = input.sourceUrl ?? input.url;
    }
    if (input.lastSeenAt) source.lastSeenAt = input.lastSeenAt;
    if (input.lastCheckedAt) source.lastCheckedAt = input.lastCheckedAt;
    source.lastError = input.lastError;
    if (input.cursor !== undefined) source.cursor = input.cursor;
  }

  async upsertSourceFromMessage(briefingId: string, message: NormalizedMessage): Promise<SourceRecord> {
    const existing = Array.from(this.sources.values()).find(
      (source) =>
        source.briefingId === briefingId &&
        (source.id === message.source.id ||
          (source.provider === (message.source.provider ?? "telegram") &&
            source.kind === (message.source.kind ?? (message.source.type === "group" ? "telegram_group" : "telegram_channel")) &&
            ((source.username && source.username === message.source.username) || source.sourceUrl === message.sourceUrl || source.title === message.source.title)))
    );
    const source: SourceRecord = {
      id: existing?.id ?? scopedSourceId(briefingId, message.source.id),
      briefingId,
      title: existing?.provider === "apify" ? existing.title : message.source.title,
      type: message.source.type,
      provider: message.source.provider ?? "telegram",
      kind: message.source.kind ?? (message.source.type === "group" ? "telegram_group" : "telegram_channel"),
      username: existing?.provider === "apify" ? existing.username : message.source.username,
      input: message.source.username ? `https://t.me/${message.source.username}` : message.sourceUrl ?? message.source.title,
      url: message.sourceUrl ?? (message.source.username ? `https://t.me/${message.source.username}` : undefined),
      sourceUrl: message.sourceUrl ?? (message.source.username ? `https://t.me/${message.source.username}` : undefined),
      actorId: existing?.actorId,
      actorInput: existing?.actorInput,
      cursor: existing?.cursor,
      enabled: existing?.enabled ?? false,
      lastSeenAt: message.receivedAt,
      lastCheckedAt: existing?.lastCheckedAt,
      lastError: existing?.lastError
    };
    this.sources.set(source.id, source);
    return source;
  }

  async saveRawMessage(_briefingId: string, message: NormalizedMessage): Promise<void> {
    this.rawMessages.set(message.id, message);
  }

  async getRawMessage(id: string): Promise<NormalizedMessage | null> {
    return this.rawMessages.get(id) ?? null;
  }

  async listRecentRawMessages(briefingId: string, now = new Date(), limit = 50): Promise<NormalizedMessage[]> {
    return Array.from(this.rawMessages.values())
      .filter((message) => message.id.startsWith(`${briefingId}::`) && new Date(message.expiresAt).getTime() > now.getTime())
      .sort((left, right) => right.postedAt.localeCompare(left.postedAt))
      .slice(0, limit);
  }

  async listRawMessagesForWindow(
    briefingId: string,
    windowStart: string,
    windowEnd: string,
    limit = 500
  ): Promise<NormalizedMessage[]> {
    return Array.from(this.rawMessages.values())
      .filter((message) =>
        message.id.startsWith(`${briefingId}::`) &&
        message.postedAt >= windowStart &&
        message.postedAt < windowEnd &&
        new Date(message.expiresAt).getTime() > new Date(windowEnd).getTime()
      )
      .sort((left, right) => left.postedAt.localeCompare(right.postedAt))
      .slice(0, limit);
  }

  async createProcessingJob(briefingId: string, rawMessageId: string, now = new Date()): Promise<string> {
    const id = `job_${this.jobs.size + 1}`;
    this.jobs.set(id, { id, briefingId, rawMessageId, state: "queued", updatedAt: now.toISOString() });
    return id;
  }

  async completeProcessingJob(jobId: string, now = new Date()): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.state = "completed";
      job.updatedAt = now.toISOString();
    }
  }

  async failProcessingJob(jobId: string, error: string, now = new Date()): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.state = "failed";
      job.error = error;
      job.updatedAt = now.toISOString();
    }
  }

  async listProcessingJobs(input?: {
    briefingId?: string;
    states?: ProcessingJobState[];
    limit?: number;
  }): Promise<ProcessingJobRecord[]> {
    const allowed = new Set(input?.states ?? ["queued", "completed", "failed"]);
    return Array.from(this.jobs.values())
      .filter((job) => (!input?.briefingId || job.briefingId === input.briefingId) && allowed.has(job.state))
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input?.limit ?? 50)
      .map((job) => ({
        id: job.id,
        briefingId: job.briefingId,
        rawMessageId: job.rawMessageId,
        state: job.state,
        error: job.error,
        updatedAt: job.updatedAt
      }));
  }

  async requeueProcessingJob(jobId: string, now = new Date()): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.state = "queued";
      delete job.error;
      job.updatedAt = now.toISOString();
    }
  }

  async getExistingItems(briefingId: string, now = new Date()): Promise<BriefingItem[]> {
    const briefing = await this.getBriefingById(briefingId);
    const items = Array.from(this.itemsByBriefing.get(briefingId)?.values() ?? []).filter(
      (item) => new Date(item.expiresAt).getTime() > now.getTime()
    );
    return collapseDuplicateBriefingItems(items, briefing ?? undefined);
  }

  async saveBriefingItems(briefingId: string, items: BriefingItem[], _now = new Date()): Promise<void> {
    const briefing = await this.getBriefingById(briefingId);
    const scoped = this.itemsByBriefing.get(briefingId) ?? new Map<string, BriefingItem>();
    for (const item of collapseDuplicateBriefingItems(items, briefing ?? undefined)) {
      const match = Array.from(scoped.values()).find((candidate) =>
        eventKeysForItem(candidate).some((key) => eventKeysForItem(item).includes(key))
      );
      if (match && match.id !== item.id) {
        scoped.set(match.id, structuredClone(mergeBriefingItem(match, item, briefing ?? undefined)));
      } else {
        scoped.set(item.id, structuredClone({
          ...item,
          eventKey: item.eventKey ?? primaryEventKeyForEvidence(item.evidence),
          mergedUpdateCount: Math.max(0, item.evidence.length - 1)
        }));
      }
    }
    this.itemsByBriefing.set(briefingId, scoped);
  }

  async repairDuplicateBriefingItems(briefingId: string, now = new Date()): Promise<number> {
    const briefing = await this.getBriefingById(briefingId);
    const scoped = this.itemsByBriefing.get(briefingId) ?? new Map<string, BriefingItem>();
    const active = Array.from(scoped.values()).filter((item) => new Date(item.expiresAt).getTime() > now.getTime());
    const collapsed = collapseDuplicateBriefingItems(active, briefing ?? undefined);
    const collapsedIds = new Set(collapsed.map((item) => item.id));
    let deleted = 0;
    for (const id of Array.from(scoped.keys())) {
      const item = scoped.get(id);
      if (item && new Date(item.expiresAt).getTime() > now.getTime() && !collapsedIds.has(id)) {
        scoped.delete(id);
        deleted += 1;
      }
    }
    for (const item of collapsed) scoped.set(item.id, structuredClone(item));
    this.itemsByBriefing.set(briefingId, scoped);
    return deleted;
  }

  async listFeedItems(ownerAccountId: string, slug: string, includeEvidence: boolean, now = new Date()): Promise<BriefingItem[]> {
    const briefing = await this.getBriefingBySlug(ownerAccountId, slug);
    if (!briefing) return [];
    const items = await this.getExistingItems(briefing.id, now);
    return includeEvidence ? items : items.map((item) => ({ ...item, evidence: [] }));
  }

  async getFeedItemEvidence(briefingId: string, itemId: string, now = new Date()): Promise<BriefingEvidence[]> {
    const item = this.itemsByBriefing.get(briefingId)?.get(itemId);
    if (!item || new Date(item.expiresAt).getTime() <= now.getTime()) return [];
    return structuredClone(item.evidence);
  }

  async saveBriefingEdition(edition: BriefingEdition): Promise<void> {
    const scoped = this.editionsByBriefing.get(edition.briefingId) ?? new Map<string, BriefingEdition>();
    const existing = Array.from(scoped.values()).find((candidate) =>
      candidate.cadence === edition.cadence &&
      candidate.windowStart === edition.windowStart &&
      candidate.windowEnd === edition.windowEnd
    );
    scoped.set(existing?.id ?? edition.id, structuredClone({ ...edition, id: existing?.id ?? edition.id }));
    this.editionsByBriefing.set(edition.briefingId, scoped);
  }

  async listBriefingEditions(
    briefingId: string,
    includeSections: boolean,
    now = new Date(),
    limit = 50
  ): Promise<BriefingEdition[]> {
    return Array.from(this.editionsByBriefing.get(briefingId)?.values() ?? [])
      .filter((edition) => new Date(edition.publishedAt).getTime() <= now.getTime())
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, limit)
      .map((edition) => includeSections ? structuredClone(edition) : { ...structuredClone(edition), sections: [] });
  }

  async getBriefingEdition(briefingId: string, editionId: string, now = new Date()): Promise<BriefingEdition | null> {
    const edition = this.editionsByBriefing.get(briefingId)?.get(editionId);
    if (!edition || new Date(edition.publishedAt).getTime() > now.getTime()) return null;
    return structuredClone(edition);
  }

  async getHealth(briefingId?: string): Promise<HealthStatus> {
    const processing = { queued: 0, completed: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      if (!briefingId || job.briefingId === briefingId) processing[job.state] += 1;
    }
    return {
      lastSourceEventAt:
        (briefingId ? this.settings.get(`last_imported_message_at:${briefingId}`) : undefined) ??
        this.settings.get("last_imported_message_at") ??
        (briefingId ? this.settings.get(`last_source_event_at:${briefingId}`) : undefined) ??
        (briefingId ? this.settings.get(`last_telegram_event_at:${briefingId}`) : undefined) ??
        this.settings.get("last_source_event_at") ??
        this.settings.get("last_telegram_event_at"),
      lastSourceFetchAt:
        (briefingId ? this.settings.get(`last_source_fetch_at:${briefingId}`) : undefined) ??
        this.settings.get("last_source_fetch_at"),
      lastImportedMessageAt:
        (briefingId ? this.settings.get(`last_imported_message_at:${briefingId}`) : undefined) ??
        this.settings.get("last_imported_message_at"),
      latestPublishedAt: latestEditionPublishedAt(this.editionsByBriefing, briefingId),
      nextBriefingAt: briefingId ? this.briefings.get(briefingId)?.nextBriefingAt : undefined,
      processing
    };
  }

  async createSourceRun(input: {
    sourceId: string;
    briefingId: string;
    provider: SourceProvider;
    actorId?: string;
    actorRunId?: string;
    datasetId?: string;
    state: SourceRunState;
    estimatedCostUsd?: number;
    startedAt?: string;
  }, now = new Date()): Promise<SourceRunRecord> {
    const run: SourceRunRecord = {
      id: `source_run_${this.sourceRuns.size + 1}`,
      sourceId: input.sourceId,
      briefingId: input.briefingId,
      provider: input.provider,
      actorId: input.actorId,
      actorRunId: input.actorRunId,
      datasetId: input.datasetId,
      state: input.state,
      itemCount: 0,
      estimatedCostUsd: input.estimatedCostUsd,
      startedAt: input.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.sourceRuns.set(run.id, run);
    return { ...run };
  }

  async updateSourceRun(input: {
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
  }, now = new Date()): Promise<void> {
    const run = this.sourceRuns.get(input.id);
    if (!run) return;
    if (input.actorRunId) run.actorRunId = input.actorRunId;
    if (input.datasetId) run.datasetId = input.datasetId;
    if (input.state) run.state = input.state;
    if (input.itemCount !== undefined) run.itemCount = input.itemCount;
    if (input.estimatedCostUsd !== undefined) run.estimatedCostUsd = input.estimatedCostUsd;
    if (input.actualCostUsd !== undefined) run.actualCostUsd = input.actualCostUsd;
    if (input.archiveKey) run.archiveKey = input.archiveKey;
    run.error = input.error;
    if (input.completedAt) run.completedAt = input.completedAt;
    run.updatedAt = now.toISOString();
  }

  async listSourceRuns(input?: {
    briefingId?: string;
    sourceId?: string;
    states?: SourceRunState[];
    limit?: number;
  }): Promise<SourceRunRecord[]> {
    const states = input?.states ? new Set(input.states) : null;
    return Array.from(this.sourceRuns.values())
      .filter((run) => !input?.briefingId || run.briefingId === input.briefingId)
      .filter((run) => !input?.sourceId || run.sourceId === input.sourceId)
      .filter((run) => !states || states.has(run.state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input?.limit ?? 50)
      .map((run) => ({ ...run }));
  }

  async sumSourceRunCosts(input: {
    briefingId: string;
    sourceId?: string;
    since: string;
  }): Promise<number> {
    return Array.from(this.sourceRuns.values())
      .filter((run) => run.briefingId === input.briefingId)
      .filter((run) => !input.sourceId || run.sourceId === input.sourceId)
      .filter((run) => run.startedAt >= input.since)
      .reduce((total, run) => total + (run.actualCostUsd ?? run.estimatedCostUsd ?? 0), 0);
  }

  async recordLlmUsage(input: {
    briefingId: string;
    model: string;
    purpose: "summary" | "importance_review" | "event_review";
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }, now = new Date()): Promise<void> {
    this.llmUsageEvents.push({ ...input, createdAt: now.toISOString() });
  }

  async sumLlmUsageCost(input: {
    briefingId: string;
    since: string;
  }): Promise<number> {
    return this.llmUsageEvents
      .filter((event) => event.briefingId === input.briefingId && event.createdAt >= input.since)
      .reduce((total, event) => total + event.estimatedCostUsd, 0);
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async listExpiredRawPayloadKeys(now = new Date()): Promise<string[]> {
    const latestExpiryByKey = new Map<string, number>();
    for (const message of this.rawMessages.values()) {
      if (!message.rawPayloadKey) continue;
      const current = latestExpiryByKey.get(message.rawPayloadKey) ?? Number.NEGATIVE_INFINITY;
      latestExpiryByKey.set(message.rawPayloadKey, Math.max(current, new Date(message.expiresAt).getTime()));
    }
    return Array.from(latestExpiryByKey)
      .filter(([, latestExpiry]) => latestExpiry <= now.getTime())
      .map(([key]) => key);
  }

  async deleteExpired(now = new Date()): Promise<number> {
    let deleted = 0;
    for (const [id, message] of this.rawMessages) {
      if (new Date(message.expiresAt).getTime() <= now.getTime()) {
        this.rawMessages.delete(id);
        deleted += 1;
      }
    }
    for (const items of this.itemsByBriefing.values()) {
      for (const [id, item] of items) {
        if (new Date(item.expiresAt).getTime() <= now.getTime()) items.delete(id);
      }
    }
    return deleted;
  }
}

function scopedSourceId(briefingId: string, sourceId: string): string {
  return `${briefingId}::${sourceId}`;
}

function stableSourceKey(provider: SourceProvider, kind: SourceKind, value: string): string {
  return `${provider}_${kind}_${stableHash(value.toLowerCase().trim())}`;
}

function compareBriefingsByStarsAndAge(
  left: BriefingConfig,
  right: BriefingConfig,
  createdAt: Map<string, string>
): number {
  if (left.stars !== right.stars) return right.stars - left.stars;
  const leftCreatedAt = createdAt.get(left.id) ?? "";
  const rightCreatedAt = createdAt.get(right.id) ?? "";
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt.localeCompare(rightCreatedAt);
  return left.id.localeCompare(right.id);
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    emailVerifiedAt: row.email_verified_at ?? undefined,
    disabledAt: row.disabled_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToAccountWithStats(row: AccountRow): AccountWithStats {
  return {
    ...rowToAccount(row),
    briefingCount: Number(row.briefing_count ?? 0)
  };
}

function rowToUsernameAlias(row: UsernameAliasRow): UsernameAliasRecord {
  return {
    username: row.username,
    accountId: row.account_id,
    isCurrent: row.is_current === 1,
    createdAt: row.created_at
  };
}

function rowToAuthToken(row: AuthTokenRow): AuthTokenRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    purpose: row.purpose,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
    createdAt: row.created_at
  };
}

function rowToBriefing(row: BriefingRow): BriefingConfig {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    ownerUsername: row.owner_username,
    slug: row.slug,
    title: row.title,
    stars: row.stars ?? 0,
    interestProfile: row.interest_profile,
    styleInstruction: row.style_instruction ?? undefined,
    publicFeedEnabled: row.public_feed_enabled === 1,
    paused: row.paused === 1,
    language: row.language === "ar" || row.language === "fr" ? row.language : "en",
    intensity: row.intensity === "low" || row.intensity === "high" ? row.intensity : "medium",
    briefingCadence: normalizedBriefingCadence(row.briefing_cadence ?? undefined),
    briefingTimeOfDay: normalizedTimeOfDay(row.briefing_time_of_day ?? undefined),
    briefingTimezone: row.briefing_timezone || "UTC",
    nextBriefingAt: row.next_briefing_at ?? undefined,
    retentionDays: FIXED_RETENTION_DAYS
  };
}

function rowToBriefingEdition(row: BriefingEditionRow, includeSections: boolean): BriefingEdition {
  return {
    id: row.id,
    briefingId: row.briefing_id,
    cadence: row.cadence,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    title: row.title,
    summary: row.summary,
    sections: includeSections ? parseJson<BriefingEditionSection[]>(row.sections_json, []) : [],
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSource(row: SourceRow): SourceRecord {
  const provider = row.provider ?? "telegram";
  const kind = row.kind ?? (row.type === "group" ? "telegram_group" : "telegram_channel");
  return {
    id: row.id,
    briefingId: row.briefing_id,
    title: row.title,
    type: row.type,
    provider,
    kind,
    username: row.username ?? undefined,
    input: row.input ?? undefined,
    url: row.source_url ?? (row.username ? `https://t.me/${row.username}` : undefined),
    sourceUrl: row.source_url ?? (row.username ? `https://t.me/${row.username}` : undefined),
    actorId: row.actor_id ?? undefined,
    actorInput: parseJson<unknown | undefined>(row.actor_input_json ?? "", undefined),
    cursor: parseJson<unknown | undefined>(row.cursor_json ?? "", undefined),
    enabled: row.enabled === 1,
    lastSeenAt: row.last_seen_at,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastError: row.last_error ?? undefined
  };
}

function rowToRawMessage(row: RawMessageRow): NormalizedMessage {
  return {
    id: row.id,
    source: {
      id: row.source_id,
      title: row.message_source_title ?? row.title,
      type: row.message_source_type ?? row.type,
      provider: row.message_source_provider ?? row.provider ?? "telegram",
      kind: row.message_source_kind ?? row.kind ?? (row.type === "group" ? "telegram_group" : "telegram_channel"),
      username: row.message_source_username ?? row.username ?? undefined
    },
    messageId: row.message_id,
    text: row.text,
    links: parseJson<string[]>(row.links_json, []),
    media: parseJson<MediaReference[]>(row.media_json, []),
    postedAt: row.posted_at,
    receivedAt: row.received_at,
    sourceUrl: row.source_url ?? undefined,
    rawPayloadKey: row.raw_payload_key ?? undefined,
    expiresAt: row.expires_at
  };
}

function rowToBriefingItem(row: BriefingItemRow): Omit<BriefingItem, "evidence"> {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    eventKey: row.event_key ?? undefined,
    summary: sanitizeSummary(row.summary) || row.summary,
    itemAt: row.item_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    mergedUpdateCount: row.merged_update_count
  };
}

function collapseBriefingItemsByStoredEventKey(items: BriefingItem[]): BriefingItem[] {
  const seen = new Set<string>();
  const collapsed: BriefingItem[] = [];
  for (const item of items) {
    const key = item.eventKey ? `event:${item.eventKey}` : `item:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(item);
  }
  return collapsed;
}

function rowToEvidence(row: EvidenceRow): BriefingEvidence {
  return {
    messageId: row.raw_message_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceType: row.source_type,
    sourceProvider: row.source_provider ?? undefined,
    sourceKind: row.source_kind ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    postedAt: row.posted_at,
    text: row.text,
    links: parseJson<string[]>(row.links_json, []),
    media: parseJson<MediaReference[]>(row.media_json, [])
  };
}

function rowToSourceRun(row: SourceRunRow): SourceRunRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    briefingId: row.briefing_id,
    provider: row.provider,
    actorId: row.actor_id ?? undefined,
    actorRunId: row.actor_run_id ?? undefined,
    datasetId: row.dataset_id ?? undefined,
    state: row.state,
    itemCount: row.item_count,
    estimatedCostUsd: row.estimated_cost_usd ?? undefined,
    actualCostUsd: row.actual_cost_usd ?? undefined,
    archiveKey: row.archive_key ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at
  };
}

function normalizedBriefingCadence(value: string | undefined): BriefingConfig["briefingCadence"] {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "hourly";
}

function normalizedTimeOfDay(value: string | undefined): string {
  return typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value) ? value : "00:00";
}

function rowToProcessingJob(row: ProcessingJobRow): ProcessingJobRecord {
  return {
    id: row.id,
    briefingId: row.briefing_id,
    rawMessageId: row.raw_message_id,
    state: row.state,
    error: row.error ?? undefined,
    updatedAt: row.updated_at
  };
}

function latestPublishedAt(
  itemsByBriefing: Map<string, Map<string, BriefingItem>>,
  briefingId?: string
): string | undefined {
  const values = briefingId
    ? Array.from(itemsByBriefing.get(briefingId)?.values() ?? [])
    : Array.from(itemsByBriefing.values()).flatMap((items) => Array.from(items.values()));
  const latest = values.map((item) => item.itemAt).sort().at(-1);
  return latest ?? undefined;
}

function latestEditionPublishedAt(
  editionsByBriefing: Map<string, Map<string, BriefingEdition>>,
  briefingId?: string
): string | undefined {
  const values = briefingId
    ? Array.from(editionsByBriefing.get(briefingId)?.values() ?? [])
    : Array.from(editionsByBriefing.values()).flatMap((editions) => Array.from(editions.values()));
  return values.map((edition) => edition.publishedAt).sort().at(-1);
}

function rowlessAccount(account: AccountRecord & { passwordHash: string }): AccountRecord {
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    role: account.role,
    emailVerifiedAt: account.emailVerifiedAt,
    disabledAt: account.disabledAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  return (await statement.first<T>()) ?? null;
}

async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}
