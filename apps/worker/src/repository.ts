import {
  personalNewsBriefing,
  type BriefingConfig,
  type BriefingEvidence,
  type BriefingItem,
  type MediaReference,
  type NormalizedMessage
} from "@lownoise/core";
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
  TelegramSourceRecord,
  UsernameAliasRecord
} from "./types";

type DbValue = string | number | null;

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
  retention_days: number;
}

interface SourceRow {
  id: string;
  briefing_id: string;
  title: string;
  type: "channel" | "group";
  username: string | null;
  enabled: number;
  last_seen_at: string;
}

interface RawMessageRow {
  id: string;
  source_id: string;
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
  username: string | null;
}

interface BriefingItemRow {
  id: string;
  cluster_id: string;
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
  source_url: string | null;
  posted_at: string;
  text: string;
  links_json: string;
  media_json: string;
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
        ownerUsername: account.username
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
      " ORDER BY briefings.stars DESC, briefings.created_at ASC";
    const rows = accountId
      ? await all<BriefingRow>(this.db.prepare(sql).bind(accountId))
      : await all<BriefingRow>(this.db.prepare(sql));
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
          public_feed_enabled, paused, language, retention_days, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          title = excluded.title,
          stars = excluded.stars,
          interest_profile = excluded.interest_profile,
          style_instruction = excluded.style_instruction,
          public_feed_enabled = excluded.public_feed_enabled,
          paused = excluded.paused,
          language = excluded.language,
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
        input.retentionDays,
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

  async listSources(briefingId: string): Promise<TelegramSourceRecord[]> {
    const rows = await all<SourceRow>(
      this.db
        .prepare(
          "SELECT id, briefing_id, title, type, username, enabled, last_seen_at FROM telegram_sources WHERE briefing_id = ? ORDER BY last_seen_at DESC"
        )
        .bind(briefingId)
    );
    return rows.map(rowToSource);
  }

  async getSource(sourceId: string): Promise<TelegramSourceRecord | null> {
    const row = await first<SourceRow>(
      this.db
        .prepare(
          "SELECT id, briefing_id, title, type, username, enabled, last_seen_at FROM telegram_sources WHERE id = ?"
        )
        .bind(sourceId)
    );
    return row ? rowToSource(row) : null;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean, now = new Date()): Promise<void> {
    await this.db
      .prepare("UPDATE telegram_sources SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, now.toISOString(), sourceId)
      .run();
  }

  async deleteSource(sourceId: string): Promise<void> {
    await this.db.prepare("DELETE FROM telegram_sources WHERE id = ?").bind(sourceId).run();
  }

  async upsertSourceFromMessage(
    briefingId: string,
    message: NormalizedMessage,
    now = new Date()
  ): Promise<TelegramSourceRecord> {
    const existingSourceId = await first<{ id: string }>(
      this.db
        .prepare(
          `SELECT id
          FROM telegram_sources
          WHERE briefing_id = ?
            AND ((username IS NOT NULL AND username = ?) OR title = ?)
          LIMIT 1`
        )
        .bind(briefingId, message.source.username ?? null, message.source.title)
    );
    const sourceId = existingSourceId?.id ?? scopedSourceId(briefingId, message.source.id);
    const timestamp = now.toISOString();
    await this.db
      .prepare(
        `INSERT INTO telegram_sources (
          id, briefing_id, title, type, username, enabled, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          username = excluded.username,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        sourceId,
        briefingId,
        message.source.title,
        message.source.type,
        message.source.username ?? null,
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
          id, briefing_id, source_id, message_id, text, links_json, media_json, posted_at,
          received_at, source_url, raw_payload_key, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.id,
        briefingId,
        message.source.id,
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
          `SELECT raw_messages.*, telegram_sources.title, telegram_sources.type, telegram_sources.username
          FROM raw_messages
          JOIN telegram_sources ON telegram_sources.id = raw_messages.source_id
          WHERE raw_messages.id = ?`
        )
        .bind(id)
    );
    return row ? rowToRawMessage(row) : null;
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
    const rows = await all<BriefingItemRow>(
      this.db
        .prepare(
          "SELECT id, cluster_id, summary, item_at, updated_at, expires_at, merged_update_count FROM briefing_items WHERE briefing_id = ? AND expires_at > ? ORDER BY item_at DESC"
        )
        .bind(briefingId, now.toISOString())
    );
    const items: BriefingItem[] = [];
    for (const row of rows) {
      items.push({ ...rowToBriefingItem(row), evidence: await this.getEvidence(row.id) });
    }
    return items;
  }

  async saveBriefingItems(briefingId: string, items: BriefingItem[], now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    for (const item of items) {
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
            id, briefing_id, cluster_id, summary, item_at, updated_at, expires_at, merged_update_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            summary = excluded.summary,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at,
            merged_update_count = excluded.merged_update_count`
        )
        .bind(
          item.id,
          briefingId,
          item.clusterId,
          item.summary,
          item.itemAt,
          item.updatedAt,
          item.expiresAt,
          item.mergedUpdateCount
        )
        .run();

      for (const evidence of item.evidence) {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO briefing_item_evidence (
              id, briefing_item_id, raw_message_id, source_id, source_title, source_type,
              source_url, posted_at, text, links_json, media_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `evidence_${item.id}_${evidence.messageId}`,
            item.id,
            evidence.messageId,
            evidence.sourceId,
            evidence.sourceTitle,
            evidence.sourceType,
            evidence.sourceUrl ?? null,
            evidence.postedAt,
            evidence.text,
            JSON.stringify(evidence.links),
            JSON.stringify(evidence.media)
          )
          .run();
      }
    }

    await this.db
      .prepare("UPDATE raw_messages SET processed_at = ? WHERE id IN (SELECT raw_message_id FROM briefing_item_evidence)")
      .bind(timestamp)
      .run();
  }

  async listFeedItems(ownerAccountId: string, slug: string, includePrivate: boolean, now = new Date()): Promise<BriefingItem[]> {
    const briefing = await this.getBriefingBySlug(ownerAccountId, slug);
    if (!briefing) return [];
    if (!includePrivate && !briefing.publicFeedEnabled) return [];
    return this.getExistingItems(briefing.id, now);
  }

  async getHealth(briefingId?: string): Promise<HealthStatus> {
    const lastTelegramEventAt =
      (briefingId
        ? await this.getSetting(`last_telegram_event_at:${briefingId}`)
        : null) ??
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
              "SELECT MAX(item_at) as latest_published_at FROM briefing_items WHERE briefing_id = ? AND expires_at > ?"
            )
            .bind(briefingId, new Date().toISOString())
        )
      : await first<{ latest_published_at: string | null }>(
          this.db
            .prepare("SELECT MAX(item_at) as latest_published_at FROM briefing_items WHERE expires_at > ?")
            .bind(new Date().toISOString())
        );
    return {
      lastTelegramEventAt,
      latestPublishedAt: latestPublishedRow?.latest_published_at ?? undefined,
      processing
    };
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

  async deleteExpired(now = new Date()): Promise<number> {
    const timestamp = now.toISOString();
    const result = await this.db
      .prepare("DELETE FROM raw_messages WHERE expires_at <= ?")
      .bind(timestamp)
      .run();
    await this.db.prepare("DELETE FROM briefing_items WHERE expires_at <= ?").bind(timestamp).run();
    await this.db.prepare("DELETE FROM clusters WHERE expires_at <= ?").bind(timestamp).run();
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
          `SELECT raw_message_id, source_id, source_title, source_type, source_url, posted_at, text, links_json, media_json
          FROM briefing_item_evidence
          WHERE briefing_item_id = ?
          ORDER BY posted_at ASC`
        )
        .bind(itemId)
    );
    return rows.map(rowToEvidence);
  }
}

export class InMemoryRepository implements Repository {
  accounts = new Map<string, AccountRecord & { passwordHash: string }>();
  aliases = new Map<string, UsernameAliasRecord>();
  tokens = new Map<string, AuthTokenRecord>();
  attempts: Array<{ key: string; action: string; createdAt: string }> = [];
  briefings = new Map<string, BriefingConfig>();
  sources = new Map<string, TelegramSourceRecord>();
  rawMessages = new Map<string, NormalizedMessage>();
  itemsByBriefing = new Map<string, Map<string, BriefingItem>>();
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

  async ensureDefaultBriefing(account: AccountRecord): Promise<BriefingConfig> {
    const existing = await this.getBriefingBySlug(account.id, personalNewsBriefing.slug);
    if (existing) return existing;
    const briefing = {
      ...personalNewsBriefing,
      id: `briefing_${account.id}_personal`,
      ownerAccountId: account.id,
      ownerUsername: account.username
    };
    this.briefings.set(briefing.id, briefing);
    return { ...briefing };
  }

  async listBriefings(accountId?: string): Promise<BriefingConfig[]> {
    return Array.from(this.briefings.values())
      .filter((briefing) => !accountId || briefing.ownerAccountId === accountId)
      .map((briefing) => ({ ...briefing }));
  }

  async getBriefingById(id: string): Promise<BriefingConfig | null> {
    return this.briefings.get(id) ?? null;
  }

  async getBriefingBySlug(ownerAccountId: string, slug: string): Promise<BriefingConfig | null> {
    return Array.from(this.briefings.values()).find(
      (briefing) => briefing.ownerAccountId === ownerAccountId && briefing.slug === slug
    ) ?? null;
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

  async upsertBriefing(input: BriefingConfig): Promise<BriefingConfig> {
    const account = this.accounts.get(input.ownerAccountId);
    this.briefings.set(input.id, {
      ...input,
      ownerUsername: account?.username ?? input.ownerUsername
    });
    return { ...this.briefings.get(input.id)! };
  }

  async deleteBriefing(id: string): Promise<void> {
    this.briefings.delete(id);

    for (const [sourceId, source] of this.sources) {
      if (source.briefingId === id) this.sources.delete(sourceId);
    }

    for (const [rawMessageId, message] of this.rawMessages) {
      if (message.id.startsWith(`${id}::`)) this.rawMessages.delete(rawMessageId);
    }

    this.itemsByBriefing.delete(id);
    this.starsByBriefing.delete(id);

    for (const [jobId, job] of this.jobs) {
      if (job.briefingId === id) this.jobs.delete(jobId);
    }
  }

  async listSources(briefingId: string): Promise<TelegramSourceRecord[]> {
    return Array.from(this.sources.values()).filter((source) => source.briefingId === briefingId);
  }

  async getSource(sourceId: string): Promise<TelegramSourceRecord | null> {
    const source = this.sources.get(sourceId);
    return source ? { ...source } : null;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.sources.get(sourceId);
    if (source) source.enabled = enabled;
  }

  async deleteSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
    for (const [id, message] of this.rawMessages) {
      if (message.source.id === sourceId) this.rawMessages.delete(id);
    }
  }

  async upsertSourceFromMessage(briefingId: string, message: NormalizedMessage): Promise<TelegramSourceRecord> {
    const existing = Array.from(this.sources.values()).find(
      (source) =>
        source.briefingId === briefingId &&
        ((source.username && source.username === message.source.username) || source.title === message.source.title)
    );
    const source: TelegramSourceRecord = {
      id: existing?.id ?? scopedSourceId(briefingId, message.source.id),
      briefingId,
      title: message.source.title,
      type: message.source.type,
      username: message.source.username,
      url: message.source.username ? `https://t.me/${message.source.username}` : undefined,
      enabled: existing?.enabled ?? false,
      lastSeenAt: message.receivedAt
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
    return Array.from(this.itemsByBriefing.get(briefingId)?.values() ?? []).filter(
      (item) => new Date(item.expiresAt).getTime() > now.getTime()
    );
  }

  async saveBriefingItems(briefingId: string, items: BriefingItem[]): Promise<void> {
    const scoped = this.itemsByBriefing.get(briefingId) ?? new Map<string, BriefingItem>();
    for (const item of items) scoped.set(item.id, structuredClone(item));
    this.itemsByBriefing.set(briefingId, scoped);
  }

  async listFeedItems(ownerAccountId: string, slug: string, includePrivate: boolean, now = new Date()): Promise<BriefingItem[]> {
    const briefing = await this.getBriefingBySlug(ownerAccountId, slug);
    if (!briefing) return [];
    if (!includePrivate && !briefing.publicFeedEnabled) return [];
    return this.getExistingItems(briefing.id, now);
  }

  async getHealth(briefingId?: string): Promise<HealthStatus> {
    const processing = { queued: 0, completed: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      if (!briefingId || job.briefingId === briefingId) processing[job.state] += 1;
    }
    return {
      lastTelegramEventAt:
        (briefingId ? this.settings.get(`last_telegram_event_at:${briefingId}`) : undefined) ??
        this.settings.get("last_telegram_event_at"),
      latestPublishedAt: latestPublishedAt(this.itemsByBriefing, briefingId),
      processing
    };
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
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
    retentionDays: row.retention_days
  };
}

function rowToSource(row: SourceRow): TelegramSourceRecord {
  return {
    id: row.id,
    briefingId: row.briefing_id,
    title: row.title,
    type: row.type,
    username: row.username ?? undefined,
    url: row.username ? `https://t.me/${row.username}` : undefined,
    enabled: row.enabled === 1,
    lastSeenAt: row.last_seen_at
  };
}

function rowToRawMessage(row: RawMessageRow): NormalizedMessage {
  return {
    id: row.id,
    source: {
      id: row.source_id,
      title: row.title,
      type: row.type,
      username: row.username ?? undefined
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
    summary: row.summary,
    itemAt: row.item_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    mergedUpdateCount: row.merged_update_count
  };
}

function rowToEvidence(row: EvidenceRow): BriefingEvidence {
  return {
    messageId: row.raw_message_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
    postedAt: row.posted_at,
    text: row.text,
    links: parseJson<string[]>(row.links_json, []),
    media: parseJson<MediaReference[]>(row.media_json, [])
  };
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

async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  return (await statement.first<T>()) ?? null;
}

async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}
