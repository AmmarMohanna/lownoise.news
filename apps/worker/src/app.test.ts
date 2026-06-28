import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { hashPassword } from "./auth";
import { publishDueBriefingEditions, publishManualBriefingEdition } from "./editions";
import { processQueueMessage } from "./processor";
import { ingestPublicTelegramChannel } from "./publicTelegram";
import { InMemoryRepository } from "./repository";
import { enqueueDueSourceRefreshJobs, pollApifySourceRuns, refreshSourceById } from "./sources";
import type { BriefingEdition, BriefingItem, EventReviewAdapter, NormalizedMessage, SummaryAdapter } from "@distilled/core";
import type { DistilledQueueMessage, Env, ProcessingJobMessage } from "./types";

class FakeBucket {
  objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeQueue {
  messages: ProcessingJobMessage[] = [];

  async send(message: ProcessingJobMessage): Promise<void> {
    this.messages.push(message);
  }
}

class FakeDistilledQueue {
  messages: DistilledQueueMessage[] = [];

  async send(message: DistilledQueueMessage): Promise<void> {
    this.messages.push(message);
  }
}

class FakeEmail {
  messages: Array<{ to: string; from?: string | { email: string; name?: string }; subject: string; text?: string; html?: string }> = [];

  async send(message: { to: string; from?: string | { email: string; name?: string }; subject: string; text?: string; html?: string }): Promise<void> {
    this.messages.push(message);
  }
}

class FailingEmail {
  async send(): Promise<void> {
    const error = new Error("Domain not available for sending") as Error & { code: string };
    error.code = "E_SENDER_DOMAIN_NOT_AVAILABLE";
    throw error;
  }
}

function env(email = new FakeEmail()): Env {
  return {
    ADMIN_SESSION_SECRET: "admin-secret",
    ADMIN_SETUP_TOKEN: "setup-token",
    INTERNAL_MAINTENANCE_SECRET: "internal-secret",
    PUBLIC_WEB_BASE_URL: "https://distilled.news",
    EMAIL_FROM: "Distilled.news <noreply@distilled.news>",
    EMAIL: email
  } as unknown as Env;
}

const publicTelegramHtml = `
  <meta property="og:title" content="Lebanon Updates">
  <main>
    <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="LebUpdate/10">
      <div class="tgme_widget_message_text js-message_text" dir="auto">Electricite du Liban announced two extra hours of power supply tonight.</div>
      <a class="tgme_widget_message_date" href="https://t.me/LebUpdate/10"><time datetime="2026-06-15T18:16:37+00:00" class="time">18:16</time></a>
    </div></div>
  </main>`;

describe("worker app accounts", () => {
  it("sets up the first verified admin account and session", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });

    const response = await app.request(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "Admin@Example.com",
          username: "Ammar Mohanna",
          password: "password123",
          setupToken: "setup-token"
        })
      },
      env()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("dn_session=");
    expect(await response.json()).toMatchObject({
      account: {
        email: "admin@example.com",
        username: "ammar-mohanna",
        role: "admin"
      }
    });
    expect(await repo.countAdmins()).toBe(1);
  });

  it("prevents multiple accounts for the same email and reserves usernames", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const email = new FakeEmail();

    const first = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "User@Test.com", username: "User One", password: "password123" })
      },
      env(email)
    );
    expect(first.status).toBe(200);

    const duplicateEmail = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", username: "Other User", password: "password123" })
      },
      env(email)
    );
    expect(duplicateEmail.status).toBe(409);

    const duplicateUsername = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "other@test.com", username: "User One", password: "password123" })
      },
      env(email)
    );
    expect(duplicateUsername.status).toBe(409);
  });

  it("returns JSON validation errors for invalid signup payloads", async () => {
    const app = createApp({ repository: new InMemoryRepository() });

    const response = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", username: "Bad User", password: "short" })
      },
      env()
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("error");
  });

  it("rolls back signup accounts when verification email sending fails", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await app.request(
        "/api/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "failed@test.com", username: "Failed User", password: "password123" })
        },
        env(new FailingEmail() as unknown as FakeEmail)
      );

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "could not send verification email" });
      expect(await repo.getAccountByEmail("failed@test.com")).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith("Could not send verification email", {
        accountId: "account_1",
        emailDomain: "test.com",
        senderDomain: "distilled.news",
        errorCode: "E_SENDER_DOMAIN_NOT_AVAILABLE",
        error: "Domain not available for sending"
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("verifies email before login and supports password reset", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const email = new FakeEmail();

    await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", username: "User One", password: "password123" })
      },
      env(email)
    );
    expect(email.messages[0].from).toEqual({ email: "noreply@distilled.news", name: "Distilled.news" });

    const rejectedLogin = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "password123" })
      },
      env(email)
    );
    expect(rejectedLogin.status).toBe(403);

    const verifyToken = tokenFromMessage(email.messages[0].text);
    const verifyResponse = await app.request(
      "/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: verifyToken })
      },
      env(email)
    );
    expect(verifyResponse.status).toBe(200);

    const repeatedVerifyResponse = await app.request(
      "/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: verifyToken })
      },
      env(email)
    );
    expect(repeatedVerifyResponse.status).toBe(200);
    expect(await repeatedVerifyResponse.json()).toMatchObject({
      account: {
        email: "user@test.com",
        emailVerifiedAt: expect.any(String)
      }
    });

    await app.request(
      "/api/auth/password/forgot",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com" })
      },
      env(email)
    );
    const resetToken = tokenFromMessage(email.messages[1].text);
    const resetResponse = await app.request(
      "/api/auth/password/reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, password: "newpass123" })
      },
      env(email)
    );
    expect(resetResponse.status).toBe(200);

    const loginResponse = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "newpass123" })
      },
      env(email)
    );
    expect(loginResponse.status).toBe(200);
  });

  it("scopes user feed management to the logged-in account", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const first = await createVerifiedUser(app, repo, "first@test.com", "First User");
    const second = await createVerifiedUser(app, repo, "second@test.com", "Second User");

    const firstBriefings = await app.request("/api/me/briefings", { headers: { cookie: first.cookie } }, env());
    const firstPayload = (await firstBriefings.json()) as { briefings: Array<{ id: string }> };

    const forbidden = await app.request(
      `/api/me/sources?briefingId=${encodeURIComponent(firstPayload.briefings[0].id)}`,
      { headers: { cookie: second.cookie } },
      env()
    );
    expect(forbidden.status).toBe(404);
  });

  it("rejects cross-account source changes and duplicate owner feed slugs", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const first = await createVerifiedUser(app, repo, "first@test.com", "First User");
    const second = await createVerifiedUser(app, repo, "second@test.com", "Second User");

    const firstBriefingsResponse = await app.request("/api/me/briefings", { headers: { cookie: first.cookie } }, env());
    const secondBriefingsResponse = await app.request("/api/me/briefings", { headers: { cookie: second.cookie } }, env());
    const firstBriefings = (await firstBriefingsResponse.json()) as { briefings: Array<{ id: string }> };
    const secondBriefings = (await secondBriefingsResponse.json()) as { briefings: Array<{ id: string }> };
    const firstSource = await repo.upsertSourceFromMessage(firstBriefings.briefings[0].id, {
      id: "message_1",
      source: { id: "source_1", title: "First Source", type: "channel", username: "FirstSource" },
      messageId: "1",
      text: "first owner message",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:00:00.000Z",
      receivedAt: "2026-06-16T08:00:00.000Z",
      sourceUrl: "https://t.me/FirstSource/1",
      expiresAt: "2026-07-01T08:00:00.000Z"
    });

    const toggleOtherSource = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: second.cookie },
        body: JSON.stringify({
          briefingId: secondBriefings.briefings[0].id,
          sourceId: firstSource.id,
          enabled: true
        })
      },
      env()
    );
    expect(toggleOtherSource.status).toBe(404);

    const deleteOtherSource = await app.request(
      `/api/me/sources/${encodeURIComponent(firstSource.id)}?briefingId=${encodeURIComponent(secondBriefings.briefings[0].id)}`,
      { method: "DELETE", headers: { cookie: second.cookie } },
      env()
    );
    expect(deleteOtherSource.status).toBe(404);
    expect(await repo.getSource(firstSource.id)).not.toBeNull();

    const createCollision = await app.request(
      "/api/me/briefings",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: first.cookie },
        body: JSON.stringify({
          id: "briefing_collision",
          slug: "personal",
          title: "Another Feed",
          interestProfile: "Track infrastructure",
          publicFeedEnabled: false,
          paused: false,
          language: "en",
          retentionDays: 15,
          stars: 0
        })
      },
      env()
    );
    expect(createCollision.status).toBe(409);
  });

  it("ingests enabled sources into the owner-scoped public feed", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async () => new Response(publicTelegramHtml, { status: 200 }));
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");

    const briefingsResponse = await app.request("/api/me/briefings", { headers: { cookie: user.cookie } }, env());
    const { briefings } = (await briefingsResponse.json()) as { briefings: Array<{ id: string; slug: string }> };
    const briefingId = briefings[0].id;

    await app.request(
      "/api/me/briefings",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ ...briefings[0], title: "Personal Briefing", interestProfile: "Track Lebanese infrastructure", publicFeedEnabled: true, paused: false, language: "en", intensity: "medium", retentionDays: 15, stars: 0 })
      },
      env()
    );

    const sourceResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId, url: "https://t.me/LebUpdate" })
      },
      env()
    );
    expect(sourceResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);
    const savedBriefing = await repo.getBriefingById(briefingId);
    expect(savedBriefing).not.toBeNull();
    await publishDueBriefingEditions({
      repo,
      briefings: [{ ...savedBriefing!, nextBriefingAt: "2026-06-15T19:00:00.000Z" }],
      now: new Date("2026-06-15T19:08:00.000Z")
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as {
      briefing: { nextBriefingAt?: string };
      editions: Array<{ id: string; summary: string; sections: unknown[] }>;
    };
    expect(feed.briefing.nextBriefingAt).toBe("2026-06-15T20:00:00.000Z");
    expect(feed.editions[0].summary).toContain("Verified updates:");
    expect(feed.editions[0].summary).toContain("[1]");
    expect(feed.editions[0].sections).toEqual([]);

    const editionResponse = await app.request(`/api/feed/feed-owner/personal/editions/${feed.editions[0].id}`, {}, env());
    expect(editionResponse.status).toBe(200);
    const edition = (await editionResponse.json()) as { edition: { sections: Array<{ evidence: Array<{ sourceUrl: string }> }> } };
    expect(edition.edition.sections[0].evidence[0].sourceUrl).toBe("https://t.me/LebUpdate/10");

    const oldRoute = await app.request("/api/feed/personal", {}, env());
    expect(oldRoute.status).toBe(404);
  });

  it("advances scheduled windows without publishing empty feed rows", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const published = await publishDueBriefingEditions({
      repo,
      briefings: [{ ...briefing!, nextBriefingAt: "2026-06-16T09:00:00.000Z" }],
      now: new Date("2026-06-16T09:08:00.000Z")
    });

    expect(published).toBe(0);
    expect(await repo.listBriefingEditions(briefing!.id, true)).toEqual([]);
    const saved = await repo.getBriefingById(briefing!.id);
    expect(saved?.nextBriefingAt).toBe("2026-06-16T10:00:00.000Z");
  });

  it("closes a scheduled window at the briefing boundary", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const scheduledBriefing = await repo.upsertBriefing({
      ...briefing!,
      nextBriefingAt: "2026-06-16T09:00:00.000Z"
    });

    await repo.saveRawMessage(scheduledBriefing.id, {
      id: `${scheduledBriefing.id}::power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "power-update",
      text: "Electricite du Liban confirmed two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:30:00.000Z",
      receivedAt: "2026-06-16T09:04:00.000Z",
      sourceUrl: "https://t.me/power/1",
      expiresAt: "2026-07-01T08:30:00.000Z"
    });

    const published = await publishDueBriefingEditions({
      repo,
      briefings: [scheduledBriefing],
      now: new Date("2026-06-16T09:00:00.000Z")
    });
    expect(published).toBe(1);
    expect((await repo.getBriefingById(scheduledBriefing.id))?.nextBriefingAt).toBe("2026-06-16T10:00:00.000Z");
  });

  it("lets public feed readers request a manual brief without moving the cadence", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({
      repository: repo,
      now: () => new Date("2026-06-16T09:30:00.000Z")
    });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const scheduledBriefing = await repo.upsertBriefing({
      ...briefing!,
      interestProfile: "Track Lebanese infrastructure and public service updates.",
      nextBriefingAt: "2026-06-16T10:00:00.000Z"
    });

    await repo.saveBriefingEdition({
      id: "edition_previous",
      briefingId: scheduledBriefing.id,
      cadence: "hourly",
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      title: "Verified updates",
      summary: "Verified updates: Earlier public service update [1].",
      sections: [
        {
          title: "Infrastructure",
          summary: "Earlier public service update.",
          evidence: []
        }
      ],
      status: "published",
      publishedAt: "2026-06-16T09:00:00.000Z",
      createdAt: "2026-06-16T09:00:00.000Z",
      updatedAt: "2026-06-16T09:00:00.000Z"
    });
    await repo.saveRawMessage(scheduledBriefing.id, {
      id: `${scheduledBriefing.id}::manual_power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "manual-power-update",
      text: "Electricite du Liban confirmed two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T09:15:00.000Z",
      receivedAt: "2026-06-16T09:15:10.000Z",
      sourceUrl: "https://t.me/power/2",
      expiresAt: "2026-07-01T09:15:00.000Z"
    });

    const response = await app.request(
      "/api/feed/feed-owner/personal/request-summary",
      { method: "POST" },
      env()
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      edition: { windowStart: string; windowEnd: string; summary: string; sections: unknown[] } | null;
      message: string;
    };
    expect(payload.message).toBe("new brief published");
    expect(payload.edition?.windowStart).toBe("2026-06-16T09:00:00.000Z");
    expect(payload.edition?.windowEnd).toBe("2026-06-16T09:30:00.000Z");
    expect(payload.edition?.summary).toContain("Electricite du Liban");
    expect(payload.edition?.sections).toEqual([]);
    expect((await repo.getBriefingById(scheduledBriefing.id))?.nextBriefingAt).toBe("2026-06-16T10:00:00.000Z");
  });

  it("starts the next scheduled brief after a manual brief without shifting the scheduled time", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const scheduledBriefing = await repo.upsertBriefing({
      ...briefing!,
      interestProfile: "Track Lebanese infrastructure and public service updates.",
      nextBriefingAt: "2026-06-16T10:00:00.000Z"
    });

    await repo.saveBriefingEdition({
      id: "edition_previous",
      briefingId: scheduledBriefing.id,
      cadence: "hourly",
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      title: "Verified updates",
      summary: "Verified updates: Earlier public service update [1].",
      sections: [
        {
          title: "Infrastructure",
          summary: "Earlier public service update.",
          evidence: []
        }
      ],
      status: "published",
      publishedAt: "2026-06-16T09:00:00.000Z",
      createdAt: "2026-06-16T09:00:00.000Z",
      updatedAt: "2026-06-16T09:00:00.000Z"
    });

    await repo.saveRawMessage(scheduledBriefing.id, {
      id: `${scheduledBriefing.id}::manual_power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "manual-power-update",
      text: "Electricite du Liban confirmed two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T09:15:00.000Z",
      receivedAt: "2026-06-16T09:15:10.000Z",
      sourceUrl: "https://t.me/power/2",
      expiresAt: "2026-07-01T09:15:00.000Z"
    });
    await repo.saveRawMessage(scheduledBriefing.id, {
      id: `${scheduledBriefing.id}::scheduled_water_update`,
      source: { id: "src_water", title: "Water Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "scheduled-water-update",
      text: "Beirut Water Authority announced a maintenance outage from 10 p.m. tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T09:45:00.000Z",
      receivedAt: "2026-06-16T09:45:10.000Z",
      sourceUrl: "https://t.me/water/3",
      expiresAt: "2026-07-01T09:45:00.000Z"
    });

    const manual = await publishManualBriefingEdition({
      repo,
      briefing: scheduledBriefing,
      now: new Date("2026-06-16T09:30:00.000Z")
    });
    expect(manual?.windowStart).toBe("2026-06-16T09:00:00.000Z");
    expect(manual?.windowEnd).toBe("2026-06-16T09:30:00.000Z");

    const published = await publishDueBriefingEditions({
      repo,
      briefings: [(await repo.getBriefingById(scheduledBriefing.id))!],
      now: new Date("2026-06-16T10:00:00.000Z")
    });
    expect(published).toBe(1);

    const editions = await repo.listBriefingEditions(
      scheduledBriefing.id,
      true,
      new Date("2026-06-16T10:01:00.000Z"),
      5
    );
    expect(editions[0].windowStart).toBe("2026-06-16T09:30:00.000Z");
    expect(editions[0].windowEnd).toBe("2026-06-16T10:00:00.000Z");
    expect(editions[0].summary).toContain("Beirut Water Authority");
    expect(editions[0].summary).not.toContain("Electricite du Liban");
    expect((await repo.getBriefingById(scheduledBriefing.id))?.nextBriefingAt).toBe("2026-06-16T11:00:00.000Z");
  });

  it("skips stale catch-up windows and publishes the latest settled window", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    await repo.saveRawMessage(briefing!.id, {
      id: `${briefing!.id}::latest_power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "latest-power-update",
      text: "Electricite du Liban confirmed two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:30:00.000Z",
      receivedAt: "2026-06-16T09:04:00.000Z",
      sourceUrl: "https://t.me/power/1",
      expiresAt: "2026-07-01T08:30:00.000Z"
    });

    const published = await publishDueBriefingEditions({
      repo,
      briefings: [{ ...briefing!, nextBriefingAt: "2026-06-16T03:00:00.000Z" }],
      now: new Date("2026-06-16T09:08:00.000Z")
    });

    expect(published).toBe(1);
    const editions = await repo.listBriefingEditions(briefing!.id, true);
    expect(editions[0].windowEnd).toBe("2026-06-16T09:00:00.000Z");
    expect((await repo.getBriefingById(briefing!.id))?.nextBriefingAt).toBe("2026-06-16T10:00:00.000Z");
  });

  it("hides existing empty editions from public feed and search", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    await repo.saveBriefingEdition({
      id: "edition_empty",
      briefingId: briefing!.id,
      cadence: "hourly",
      windowStart: "2026-06-16T07:00:00.000Z",
      windowEnd: "2026-06-16T08:00:00.000Z",
      title: "Hourly brief",
      summary: "No verified updates in this hourly brief.",
      sections: [
        {
          title: "No updates",
          summary: "No verified updates in this hourly brief.",
          evidence: []
        }
      ],
      status: "empty",
      publishedAt: "2026-06-16T08:00:00.000Z",
      createdAt: "2026-06-16T08:00:00.000Z",
      updatedAt: "2026-06-16T08:00:00.000Z"
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { editions: unknown[] };
    expect(feed.editions).toEqual([]);

    const detailResponse = await app.request("/api/feed/feed-owner/personal/editions/edition_empty", {}, env());
    expect(detailResponse.status).toBe(404);

    const searchResponse = await app.request("/api/feed/feed-owner/personal/search?q=verified", {}, env());
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as { editions: unknown[] };
    expect(search.editions).toEqual([]);
  });

  it("saves supported feed cadence while keeping briefing time internal", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const saveResponse = await app.request(
      "/api/me/briefings",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({
          ...briefing!,
          briefingCadence: "daily",
          briefingTimeOfDay: "08:30",
          briefingTimezone: "Asia/Beirut"
        })
      },
      env()
    );
    expect(saveResponse.status).toBe(200);

    const listResponse = await app.request("/api/me/briefings", { headers: { cookie: user.cookie } }, env());
    const payload = (await listResponse.json()) as {
      briefings: Array<{ briefingCadence: string; briefingTimeOfDay: string; briefingTimezone: string; nextBriefingAt?: string }>;
    };
    expect(payload.briefings[0].briefingCadence).toBe("daily");
    expect(payload.briefings[0].briefingTimeOfDay).toBe("00:00");
    expect(payload.briefings[0].briefingTimezone).toBe("Asia/Beirut");
    expect(payload.briefings[0].nextBriefingAt).toBeTruthy();
  });

  it("normalizes monthly cadence to weekly", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const saveResponse = await app.request(
      "/api/me/briefings",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({
          ...briefing!,
          briefingCadence: "monthly",
          briefingTimeOfDay: "08:30"
        })
      },
      env()
    );
    expect(saveResponse.status).toBe(200);
    const payload = (await saveResponse.json()) as {
      briefing: { briefingCadence: string; briefingTimeOfDay: string };
    };
    expect(payload.briefing.briefingCadence).toBe("weekly");
    expect(payload.briefing.briefingTimeOfDay).toBe("00:00");
  });

  it("serves synthesized public summaries for old count-style edition rows", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    await repo.saveBriefingEdition({
      id: "edition_count_summary",
      briefingId: briefing!.id,
      cadence: "hourly",
      windowStart: "2026-06-16T07:00:00.000Z",
      windowEnd: "2026-06-16T08:00:00.000Z",
      title: "Hourly brief",
      summary: "2 updates in this hourly brief.",
      sections: [
        {
          title: "Infrastructure",
          summary: "Electricite du Liban confirmed two extra hours of power supply tonight.",
          evidence: []
        },
        {
          title: "Security",
          summary: "The coastal road reopened after an overnight security closure.",
          evidence: []
        }
      ],
      status: "published",
      publishedAt: "2026-06-16T08:00:00.000Z",
      createdAt: "2026-06-16T08:00:00.000Z",
      updatedAt: "2026-06-16T08:00:00.000Z"
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { editions: Array<{ summary: string; sections: unknown[] }> };
    expect(feed.editions[0].summary).toContain("Verified updates:");
    expect(feed.editions[0].summary).toContain("[1]");
    expect(feed.editions[0].summary).not.toContain("2 updates in this hourly brief");
    expect(feed.editions[0].sections).toEqual([]);

    const detailResponse = await app.request("/api/feed/feed-owner/personal/editions/edition_count_summary", {}, env());
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as { edition: { summary: string; sections: unknown[] } };
    expect(detail.edition.summary).toBe(feed.editions[0].summary);
    expect(detail.edition.sections).toHaveLength(2);
  });

  it("uses the summary adapter to localize scheduled Arabic edition sections", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({
      ...briefing!,
      language: "ar",
      interestProfile: "Track Lebanese infrastructure and power supply updates."
    });
    const savedBriefing = await repo.getBriefingById(briefing!.id);
    expect(savedBriefing).not.toBeNull();

    const message: NormalizedMessage = {
      id: `${briefing!.id}::english_power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "english-power-update",
      text: "Electricite du Liban announced two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:15:00.000Z",
      receivedAt: "2026-06-16T08:15:10.000Z",
      sourceUrl: "https://t.me/power/1",
      expiresAt: "2026-07-01T08:15:00.000Z"
    };
    await repo.saveRawMessage(briefing!.id, message);
    const summarize = vi.fn(async () => "أعلنت كهرباء لبنان زيادة التغذية ساعتين هذه الليلة.");
    const summaryAdapter: SummaryAdapter = { summarize };

    await publishDueBriefingEditions({
      repo,
      briefings: [{ ...savedBriefing!, nextBriefingAt: "2026-06-16T09:00:00.000Z" }],
      now: new Date("2026-06-16T09:08:00.000Z"),
      summaryAdapter
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { editions: Array<{ id: string; summary: string }> };
    expect(feed.editions[0].summary).toContain("تحديثات موثوقة:");
    expect(feed.editions[0].summary).toContain("أعلنت كهرباء لبنان");
    expect(feed.editions[0].summary).not.toContain("Electricite du Liban");

    const editionResponse = await app.request(`/api/feed/feed-owner/personal/editions/${feed.editions[0].id}`, {}, env());
    expect(editionResponse.status).toBe(200);
    const edition = (await editionResponse.json()) as { edition: { sections: Array<{ title: string; summary: string }> } };
    expect(edition.edition.sections[0].title).toBe("بنية تحتية");
    expect(edition.edition.sections[0].summary).toBe("أعلنت كهرباء لبنان زيادة التغذية ساعتين هذه الليلة.");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("normalizes old Arabic section titles in public edition detail", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, language: "ar" });

    await repo.saveBriefingEdition({
      id: "edition_old_arabic_title",
      briefingId: briefing!.id,
      cadence: "hourly",
      windowStart: "2026-06-16T07:00:00.000Z",
      windowEnd: "2026-06-16T08:00:00.000Z",
      title: "Hourly brief",
      summary: "في هذه الساعة: أعلنت كهرباء لبنان زيادة التغذية ساعتين هذه الليلة [1].",
      sections: [
        {
          title: "Infrastructure",
          summary: "أعلنت كهرباء لبنان زيادة التغذية ساعتين هذه الليلة.",
          evidence: []
        }
      ],
      status: "published",
      publishedAt: "2026-06-16T08:00:00.000Z",
      createdAt: "2026-06-16T08:00:00.000Z",
      updatedAt: "2026-06-16T08:00:00.000Z"
    });

    const editionResponse = await app.request("/api/feed/feed-owner/personal/editions/edition_old_arabic_title", {}, env());
    expect(editionResponse.status).toBe(200);
    const detail = (await editionResponse.json()) as { edition: { sections: Array<{ title: string; summary: string }> } };
    expect(detail.edition.sections[0].title).toBe("بنية تحتية");
    expect(detail.edition.sections[0].summary).not.toContain("Infrastructure");
  });

  it("removes bilingual Telegram artifacts from saved Arabic public editions", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, language: "ar" });

    const rawText = "نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد Netanyahu: We have struck Iran and its proxies in the region, and the operation is not over yet ــــــــــــــ قناة موقع بنت جبيل على واتساب";
    await repo.saveBriefingEdition({
      id: "edition_saved_artifact_arabic",
      briefingId: briefing!.id,
      cadence: "hourly",
      windowStart: "2026-06-23T09:00:00.000Z",
      windowEnd: "2026-06-23T10:00:00.000Z",
      title: "تحديثات موثوقة",
      summary: `تحديثات موثوقة: ${rawText} [1].`,
      sections: [
        {
          title: "Security",
          summary: rawText,
          evidence: [
            {
              messageId: "msg_bintjbeil",
              sourceId: "src_bintjbeil",
              sourceTitle: "bintjbeil.org - موقع بنت جبيل",
              sourceType: "channel",
              sourceProvider: "telegram",
              sourceKind: "telegram_channel",
              postedAt: "2026-06-23T09:58:00.000Z",
              text: rawText,
              links: [],
              media: [],
              sourceUrl: "https://t.me/bintjbeilnews/1"
            }
          ]
        }
      ],
      status: "published",
      publishedAt: "2026-06-23T10:00:00.000Z",
      createdAt: "2026-06-23T10:00:00.000Z",
      updatedAt: "2026-06-23T10:00:00.000Z"
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { editions: Array<{ id: string; summary: string }> };
    expect(feed.editions[0].summary).toBe("تحديثات موثوقة: نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد [1].");
    expect(feed.editions[0].summary).not.toContain("Netanyahu");
    expect(feed.editions[0].summary).not.toContain("ــــ");

    const editionResponse = await app.request("/api/feed/feed-owner/personal/editions/edition_saved_artifact_arabic", {}, env());
    expect(editionResponse.status).toBe(200);
    const detail = (await editionResponse.json()) as { edition: { sections: Array<{ summary: string; evidence: Array<{ text: string }> }> } };
    expect(detail.edition.sections[0].summary).toBe("نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد");
    expect(detail.edition.sections[0].evidence[0].text).toBe("نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد");
  });

  it("does not publish wrong-language Arabic editions when localization is unavailable", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({
      ...briefing!,
      language: "ar",
      interestProfile: "Track Lebanese infrastructure and power supply updates."
    });
    const savedBriefing = await repo.getBriefingById(briefing!.id);
    expect(savedBriefing).not.toBeNull();

    await repo.saveRawMessage(briefing!.id, {
      id: `${briefing!.id}::english_power_update`,
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "english-power-update",
      text: "Electricite du Liban announced two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:15:00.000Z",
      receivedAt: "2026-06-16T08:15:10.000Z",
      sourceUrl: "https://t.me/power/1",
      expiresAt: "2026-07-01T08:15:00.000Z"
    });

    await publishDueBriefingEditions({
      repo,
      briefings: [{ ...savedBriefing!, nextBriefingAt: "2026-06-16T09:00:00.000Z" }],
      now: new Date("2026-06-16T09:08:00.000Z")
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { editions: Array<{ id: string; summary: string }> };
    expect(feed.editions).toEqual([]);

    const saved = await repo.getBriefingById(briefing!.id);
    expect(saved?.nextBriefingAt).toBe("2026-06-16T10:00:00.000Z");
  });

  it("keeps a manually paused Telegram source paused across later ingest passes", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async () => new Response(publicTelegramHtml, { status: 200 }));
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const addResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "https://t.me/LebUpdate" })
      },
      env()
    );
    expect(addResponse.status).toBe(200);
    let sources = await repo.listSources(briefing!.id);
    expect(sources[0].enabled).toBe(true);

    const pauseResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, sourceId: sources[0].id, enabled: false })
      },
      env()
    );
    expect(pauseResponse.status).toBe(200);
    sources = await repo.listSources(briefing!.id);
    expect(sources[0].enabled).toBe(false);

    await ingestPublicTelegramChannel({
      briefing: briefing!,
      url: "https://t.me/LebUpdate",
      repo,
      bucket,
      queue,
      fetcher: fetcher as unknown as typeof fetch,
      now: new Date("2026-06-16T08:02:00.000Z")
    });

    sources = await repo.listSources(briefing!.id);
    expect(sources[0].enabled).toBe(false);
  });

  it("does not publish a new item when the summary adapter returns no-post", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async () => new Response(publicTelegramHtml, { status: 200 }));
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track Lebanese infrastructure", intensity: "medium" });

    const sourceResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "t: LebUpdate" })
      },
      env()
    );
    expect(sourceResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const rawMessages = await repo.listRawMessagesForWindow(
      briefing!.id,
      "2026-06-15T18:00:00.000Z",
      "2026-06-15T19:00:00.000Z"
    );
    expect(rawMessages).toHaveLength(1);
    const jobId = queue.messages[0].jobId;

    await processQueueMessage(repo, { jobId, briefingId: briefing!.id, rawMessageId: rawMessages[0].id }, new Date("2026-06-15T19:00:00.000Z"), {
      summarize: async () => "NO_POST"
    });

    const feedItems = await repo.listFeedItems(user.account.id, "personal", true);
    expect(feedItems).toHaveLength(0);
  });

  it("completes queue jobs with the deterministic summary when AI summary fails", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async () => new Response(publicTelegramHtml, { status: 200 }));
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track Lebanese infrastructure", intensity: "medium" });

    const sourceResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "t: LebUpdate" })
      },
      env()
    );
    expect(sourceResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const rawMessages = await repo.listRawMessagesForWindow(
      briefing!.id,
      "2026-06-15T18:00:00.000Z",
      "2026-06-15T19:00:00.000Z"
    );
    expect(rawMessages).toHaveLength(1);
    const jobId = queue.messages[0].jobId;

    await expect(processQueueMessage(repo, { jobId, briefingId: briefing!.id, rawMessageId: rawMessages[0].id }, new Date("2026-06-15T19:00:00.000Z"), {
      summarize: async () => {
        throw new Error("summary timeout");
      }
    })).resolves.toBeDefined();

    const jobs = await repo.listProcessingJobs({ briefingId: briefing!.id, states: ["completed"] });
    expect(jobs).toHaveLength(1);
    const feedItems = await repo.listFeedItems(user.account.id, "personal", true);
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0].summary).toContain("Electricite du Liban");
  });

  it("keeps one published item when later AI summaries differ for the same event", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track Lebanese regional and public safety news", intensity: "medium" });

    const firstMessage: NormalizedMessage = {
      id: `${briefing!.id}::msg_ai_drift_1`,
      source: { id: "src_lbci", title: "LBCI_NEWS", type: "channel", provider: "telegram", kind: "telegram_channel", username: "LBCI_NEWS" },
      messageId: "303821",
      text: "وزير الخارجية الإسرائيلي: قطع جميع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبي",
      links: ["https://twitter.com/LBCI_NEWS/status/2067527301990900181"],
      media: [],
      postedAt: "2026-06-18T08:38:00.000Z",
      receivedAt: "2026-06-18T08:38:10.000Z",
      sourceUrl: "https://t.me/LBCI_NEWS/303821",
      expiresAt: "2026-07-03T08:38:00.000Z"
    };
    const secondMessage: NormalizedMessage = {
      ...firstMessage,
      id: `${briefing!.id}::msg_ai_drift_2`,
      messageId: "303822",
      text: "وزير الخارجية الإسرائيليّ: سأقطع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبيّ",
      links: ["https://twitter.com/LBCI_NEWS/status/2067527529599062343"],
      postedAt: "2026-06-18T08:43:00.000Z",
      receivedAt: "2026-06-18T08:43:10.000Z",
      sourceUrl: "https://t.me/LBCI_NEWS/303822"
    };

    const source = await repo.upsertSourceFromMessage(briefing!.id, firstMessage);
    await repo.setSourceEnabled(source.id, true);
    const persistedFirst = { ...firstMessage, source: { ...firstMessage.source, id: source.id } };
    const persistedSecond = { ...secondMessage, source: { ...secondMessage.source, id: source.id } };
    await repo.saveRawMessage(briefing!.id, persistedFirst);
    const firstJobId = await repo.createProcessingJob(briefing!.id, persistedFirst.id);
    await processQueueMessage(repo, { jobId: firstJobId, briefingId: briefing!.id, rawMessageId: persistedFirst.id }, new Date("2026-06-18T08:40:00.000Z"), {
      summarize: async () => "أعلن وزير الخارجية الإسرائيلي قطع الاتصالات مع مسؤولة السياسة الخارجية الأوروبية."
    });

    await repo.saveRawMessage(briefing!.id, persistedSecond);
    const secondJobId = await repo.createProcessingJob(briefing!.id, persistedSecond.id);
    await processQueueMessage(repo, { jobId: secondJobId, briefingId: briefing!.id, rawMessageId: persistedSecond.id }, new Date("2026-06-18T08:44:00.000Z"), {
      summarize: async () => "وزير الخارجية الإسرائيلي: قطع جميع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبي"
    });

    const feedItems = await repo.listFeedItems(user.account.id, "personal", true);
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0].evidence.map((entry) => entry.messageId)).toEqual([
      persistedFirst.id,
      persistedSecond.id
    ]);
  });

  it.each([
    [true, 1],
    [false, 2]
  ])("uses LLM event equivalence review result %s when deterministic matching is inconclusive", async (sameEvent, expectedCount) => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track central bank and economy news", intensity: "medium" });

    const existing: BriefingItem = {
      id: "item_existing_bank",
      clusterId: "cluster_existing_bank",
      summary: "Central bank ordered banks to limit cash withdrawals.",
      itemAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:00:00.000Z",
      expiresAt: "2026-07-03T08:00:00.000Z",
      mergedUpdateCount: 0,
      evidence: [
        {
          messageId: `${briefing!.id}::existing_bank_raw`,
          sourceId: "src_existing_bank",
          sourceTitle: "Banking Wire",
          sourceType: "channel",
          sourceProvider: "rss",
          sourceKind: "rss_feed",
          postedAt: "2026-06-18T08:00:00.000Z",
          text: "Central bank ordered banks to limit cash withdrawals.",
          links: [],
          media: []
        }
      ]
    };
    await repo.saveBriefingItems(briefing!.id, [existing]);

    const message: NormalizedMessage = {
      id: `${briefing!.id}::bank_review_raw`,
      source: { id: "src_bank_review", title: "Economy News", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "bank-review",
      text: "Central bank announced new withdrawal caps for commercial banks.",
      links: [],
      media: [],
      postedAt: "2026-06-18T08:05:00.000Z",
      receivedAt: "2026-06-18T08:05:10.000Z",
      sourceUrl: "https://t.me/economy/1",
      expiresAt: "2026-07-03T08:05:00.000Z"
    };
    const source = await repo.upsertSourceFromMessage(briefing!.id, message);
    await repo.setSourceEnabled(source.id, true);
    const persisted = { ...message, source: { ...message.source, id: source.id } };
    await repo.saveRawMessage(briefing!.id, persisted);
    const jobId = await repo.createProcessingJob(briefing!.id, persisted.id);
    const reviewAdapter: EventReviewAdapter = {
      areSameEvent: async () => sameEvent,
      isImportant: async () => false
    };

    await processQueueMessage(repo, { jobId, briefingId: briefing!.id, rawMessageId: persisted.id }, new Date("2026-06-18T08:06:00.000Z"), null, reviewAdapter);

    const feedItems = await repo.listFeedItems(user.account.id, "personal", true);
    expect(feedItems).toHaveLength(expectedCount);
  });

  it("does not rerun advisory importance review for every recent message in each queue job", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track economy updates", intensity: "medium" });

    const baseMessage: NormalizedMessage = {
      id: `${briefing!.id}::economy_current`,
      source: { id: "src_economy_review", title: "Economy Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "economy-current",
      text: "Economy index reached 2 today.",
      links: [],
      media: [],
      postedAt: "2026-06-18T08:05:00.000Z",
      receivedAt: "2026-06-18T08:05:10.000Z",
      sourceUrl: "https://t.me/economy/10",
      expiresAt: "2026-07-03T08:05:00.000Z"
    };
    const source = await repo.upsertSourceFromMessage(briefing!.id, baseMessage);
    await repo.setSourceEnabled(source.id, true);

    for (let index = 0; index < 5; index += 1) {
      await repo.saveRawMessage(briefing!.id, {
        ...baseMessage,
        id: `${briefing!.id}::economy_recent_${index}`,
        source: { ...baseMessage.source, id: source.id },
        messageId: `economy-recent-${index}`,
        text: `Economy index reached ${index + 3} today.`,
        postedAt: `2026-06-18T08:0${index}:00.000Z`,
        receivedAt: `2026-06-18T08:0${index}:10.000Z`,
        sourceUrl: `https://t.me/economy/${index}`
      });
    }

    const persistedCurrent = { ...baseMessage, source: { ...baseMessage.source, id: source.id } };
    await repo.saveRawMessage(briefing!.id, persistedCurrent);
    const jobId = await repo.createProcessingJob(briefing!.id, persistedCurrent.id);
    const isImportant = vi.fn(async () => false);
    const reviewAdapter: EventReviewAdapter = {
      areSameEvent: async () => false,
      isImportant
    };

    await processQueueMessage(
      repo,
      { jobId, briefingId: briefing!.id, rawMessageId: persistedCurrent.id },
      new Date("2026-06-18T08:06:00.000Z"),
      null,
      reviewAdapter
    );

    expect(isImportant).toHaveBeenCalledTimes(1);
    expect(isImportant).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ id: persistedCurrent.id })
    }));
  });

  it("returns a clear error when Apify-backed X sources are added without a token", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo, bucket: new FakeBucket(), queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const response = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "x: @ALJADEEDNEWS" })
      },
      env()
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "APIFY_API_TOKEN is not configured." });
  });

  it("enqueues due source refreshes once and leases them with lastCheckedAt", async () => {
    const repo = new InMemoryRepository();
    const queue = new FakeDistilledQueue();
    const app = createApp({ repository: repo, bucket: new FakeBucket(), queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const source = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Example RSS",
      provider: "rss",
      kind: "rss_feed",
      sourceUrl: "https://example.com/feed.xml",
      enabled: true
    }, new Date("2026-06-18T08:00:00.000Z"));

    const first = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue,
      now: new Date("2026-06-18T08:05:00.000Z")
    });
    const leased = await repo.getSource(source.id);
    const second = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue,
      now: new Date("2026-06-18T08:06:00.000Z")
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(queue.messages).toEqual([
      { type: "refresh_source", briefingId: briefing!.id, sourceId: source.id, force: undefined }
    ]);
    expect(leased?.lastCheckedAt).toBe("2026-06-18T08:05:00.000Z");
  });

  it("skips scheduled source refreshes while a feed has a large processing backlog", async () => {
    const repo = new InMemoryRepository();
    const queue = new FakeDistilledQueue();
    const app = createApp({ repository: repo, bucket: new FakeBucket(), queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Example RSS",
      provider: "rss",
      kind: "rss_feed",
      sourceUrl: "https://example.com/feed.xml",
      enabled: true
    }, new Date("2026-06-18T08:00:00.000Z"));
    for (let index = 0; index < 500; index += 1) {
      await repo.createProcessingJob(briefing!.id, `raw_${index}`, new Date("2026-06-18T08:00:00.000Z"));
    }

    const enqueued = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue,
      now: new Date("2026-06-18T09:00:00.000Z")
    });

    expect(enqueued).toBe(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("backs off failing Google News sources and skips quarantined source refreshes", async () => {
    const repo = new InMemoryRepository();
    const queue = new FakeDistilledQueue();
    const app = createApp({ repository: repo, bucket: new FakeBucket(), queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const source = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Google News: Lebanon security",
      provider: "rss",
      kind: "google_news",
      sourceUrl: "https://news.google.com/rss/search?q=Lebanon+security&hl=en-US&gl=US&ceid=US%3Aen",
      enabled: true
    }, new Date("2026-06-18T08:00:00.000Z"));
    await repo.updateSourceState({
      sourceId: source.id,
      lastCheckedAt: "2026-06-18T08:00:00.000Z",
      lastError: "Could not fetch Google News RSS source: 503"
    });

    const quarantined = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Google News: South Lebanon",
      provider: "rss",
      kind: "google_news",
      sourceUrl: "https://news.google.com/rss/search?q=South+Lebanon&hl=en-US&gl=US&ceid=US%3Aen",
      enabled: true
    }, new Date("2026-06-18T08:00:00.000Z"));
    await repo.updateSourceState({
      sourceId: quarantined.id,
      lastCheckedAt: "2026-06-17T08:00:00.000Z",
      lastError: "Paused after repeated source failures: Could not fetch Google News RSS source: 503"
    });

    const backedOff = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue,
      now: new Date("2026-06-18T10:00:00.000Z")
    });
    const dueAfterBackoff = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue,
      now: new Date("2026-06-18T14:01:00.000Z")
    });

    expect(backedOff).toBe(0);
    expect(dueAfterBackoff).toBe(1);
    expect(queue.messages).toEqual([
      { type: "refresh_source", briefingId: briefing!.id, sourceId: source.id, force: undefined }
    ]);
  });

  it("fetches, imports, and processes a Google News RSS source without Apify", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.startsWith("https://news.google.com/rss/search")) {
        expect(new URL(url).searchParams.get("q")).toBe("central bank lebanon");
        expect(new Headers(init?.headers).get("accept")).toContain("application/rss+xml");
        expect(new Headers(init?.headers).get("user-agent")).toContain("DistilledNewsBot");
        return new Response(
          `<?xml version="1.0"?>
          <rss><channel>
            <title>"central bank lebanon" - Google News</title>
            <item>
              <title>Central bank announced a new circular - Reuters</title>
              <link>https://news.google.com/rss/articles/bank-circular?oc=5</link>
              <guid isPermaLink="false">bank-circular</guid>
              <pubDate>Tue, 16 Jun 2026 08:01:00 GMT</pubDate>
              <description>&lt;a href="https://news.google.com/rss/articles/bank-circular?oc=5"&gt;Central bank announced a new circular&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font&gt;Reuters&lt;/font&gt;</description>
              <source url="https://www.reuters.com">Reuters</source>
            </item>
          </channel></rss>`,
          { status: 200, headers: { "content-type": "application/rss+xml" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, interestProfile: "Track central bank and economy news", intensity: "low" });

    const addResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "news: central bank lebanon" })
      },
      env()
    );
    expect(addResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);
    expect(Array.from(bucket.objects.keys()).some((key) => key.includes("google-news/"))).toBe(true);
    const sources = await repo.listSources(briefing!.id);
    expect(sources.find((source) => source.kind === "google_news")).toMatchObject({
      provider: "rss",
      title: "Google News: central bank lebanon"
    });
    const savedBriefing = await repo.getBriefingById(briefing!.id);
    expect(savedBriefing).not.toBeNull();
    await publishDueBriefingEditions({
      repo,
      briefings: [{ ...savedBriefing!, nextBriefingAt: "2026-06-16T09:00:00.000Z" }],
      now: new Date("2026-06-16T09:08:00.000Z")
    });

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { briefing: { briefingCadence?: string }; editions: Array<{ id: string; summary: string }> };
    expect(feed.briefing.briefingCadence).toBe("hourly");
    expect(feed.editions[0].summary).toContain("Verified updates:");
    expect(feed.editions[0].summary).toContain("[1]");

    const editionResponse = await app.request(
      `/api/feed/feed-owner/personal/editions/${encodeURIComponent(feed.editions[0].id)}`,
      {},
      env()
    );
    expect(editionResponse.status).toBe(200);
    const edition = (await editionResponse.json()) as { edition: { sections: Array<{ evidence: Array<{ sourceTitle: string }> }> } };
    expect(edition.edition.sections[0].evidence[0].sourceTitle).toBe("Reuters");
  });

  it("refreshes legacy Apify Google News sources through RSS", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const staleArticleUrl = "https://news.google.com/rss/articles/stale-power-grid?oc=5";
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      expect(url).not.toBe(staleArticleUrl);
      if (url.startsWith("https://news.google.com/rss/search")) {
        expect(new URL(url).searchParams.get("q")).toBe("lebanon electricity");
        return new Response(
          `<?xml version="1.0"?>
          <rss><channel>
            <title>"lebanon electricity" - Google News</title>
            <item>
              <title>Power grid repairs completed - Daily Wire</title>
              <link>https://news.google.com/rss/articles/power-grid?oc=5</link>
              <guid isPermaLink="false">power-grid</guid>
              <pubDate>Tue, 16 Jun 2026 08:10:00 GMT</pubDate>
              <source url="https://example.com">Daily Wire</source>
            </item>
          </channel></rss>`,
          { status: 200, headers: { "content-type": "application/rss+xml" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    const user = await createVerifiedUser(createApp({ repository: repo }), repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const source = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Google News: lebanon electricity",
      provider: "apify",
      kind: "google_news",
      sourceUrl: staleArticleUrl,
      actorId: "groupoject/google-news-scraper",
      actorInput: { queries: ["lebanon electricity"], geo: "US", language: "en" },
      enabled: true
    });

    await refreshSourceById({
      briefing: briefing!,
      sourceId: source.id,
      repo,
      bucket,
      queue,
      env: env(),
      fetcher: fetcher as unknown as typeof fetch,
      now: new Date("2026-06-16T08:15:00.000Z")
    });

    expect(queue.messages).toHaveLength(1);
    expect(Array.from(bucket.objects.keys()).some((key) => key.includes("google-news/"))).toBe(true);
    const refreshedSource = await repo.getSource(source.id);
    expect(refreshedSource).toMatchObject({
      title: "Google News: lebanon electricity",
      provider: "rss",
      kind: "google_news",
      sourceUrl: "https://news.google.com/rss/search?q=lebanon+electricity&hl=en-US&gl=US&ceid=US%3Aen"
    });
  });

  it("falls back to a capped Apify run when Google News RSS is temporarily unavailable", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.startsWith("https://news.google.com/rss/search")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("/actors/groupoject~google-news-scraper/runs")) {
        expect(new URL(url).searchParams.get("maxItems")).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual({
          queries: ["lebanon economy"],
          geo: "US",
          language: "en",
          maxItemsPerQuery: 20
        });
        return new Response(JSON.stringify({
          data: {
            id: "run_google_news",
            status: "RUNNING",
            defaultDatasetId: "dataset_google_news",
            startedAt: "2026-06-16T08:15:00.000Z"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    const user = await createVerifiedUser(createApp({ repository: repo }), repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const source = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Google News: lebanon economy",
      provider: "rss",
      kind: "google_news",
      input: "news: lebanon economy",
      sourceUrl: "https://news.google.com/rss/search?q=lebanon+economy&hl=en-US&gl=US&ceid=US%3Aen",
      enabled: true
    });

    const result = await refreshSourceById({
      briefing: briefing!,
      sourceId: source.id,
      repo,
      bucket,
      queue,
      env: { ...env(), APIFY_API_TOKEN: "token" } as Env,
      fetcher: fetcher as unknown as typeof fetch,
      now: new Date("2026-06-16T08:15:00.000Z")
    });
    const runs = await repo.listSourceRuns({ sourceId: source.id });
    const refreshedSource = await repo.getSource(source.id);
    const dispatchQueue = new FakeDistilledQueue();
    const enqueued = await enqueueDueSourceRefreshJobs({
      briefing: briefing!,
      repo,
      queue: dispatchQueue,
      now: new Date("2026-06-16T08:31:00.000Z")
    });

    expect(result).toMatchObject({
      runStarted: true,
      provider: "apify",
      kind: "google_news"
    });
    expect(runs[0]).toMatchObject({
      actorId: "groupoject/google-news-scraper",
      actorRunId: "run_google_news",
      state: "running",
      estimatedCostUsd: 0.02
    });
    expect(refreshedSource).toMatchObject({
      lastCheckedAt: "2026-06-16T08:15:00.000Z"
    });
    expect(refreshedSource?.lastError).toBeUndefined();
    expect(enqueued).toBe(0);
    expect(dispatchQueue.messages).toHaveLength(0);

    const duplicateResult = await refreshSourceById({
      briefing: briefing!,
      sourceId: source.id,
      repo,
      bucket,
      queue,
      env: { ...env(), APIFY_API_TOKEN: "token" } as Env,
      fetcher: fetcher as unknown as typeof fetch,
      now: new Date("2026-06-16T08:32:00.000Z")
    });
    expect(duplicateResult).toMatchObject({
      runStarted: true,
      provider: "apify",
      kind: "google_news"
    });
    expect((await repo.getSource(source.id))?.lastError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not start the Google News Apify fallback after the daily source cap is reached", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.startsWith("https://news.google.com/rss/search")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    });
    const user = await createVerifiedUser(createApp({ repository: repo }), repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    const source = await repo.upsertConfiguredSource({
      briefingId: briefing!.id,
      title: "Google News: lebanon economy",
      provider: "rss",
      kind: "google_news",
      input: "news: lebanon economy",
      sourceUrl: "https://news.google.com/rss/search?q=lebanon+economy&hl=en-US&gl=US&ceid=US%3Aen",
      enabled: true
    });
    for (let hour = 0; hour < 4; hour += 1) {
      const startedAt = `2026-06-16T0${hour}:00:00.000Z`;
      await repo.createSourceRun({
        sourceId: source.id,
        briefingId: briefing!.id,
        provider: "apify",
        actorId: "groupoject/google-news-scraper",
        actorRunId: `run_google_news_${hour}`,
        state: "succeeded",
        estimatedCostUsd: 0.02,
        startedAt
      }, new Date(startedAt));
    }

    const result = await refreshSourceById({
      briefing: briefing!,
      sourceId: source.id,
      repo,
      bucket,
      queue,
      env: { ...env(), APIFY_API_TOKEN: "token" } as Env,
      fetcher: fetcher as unknown as typeof fetch,
      now: new Date("2026-06-16T08:00:00.000Z")
    });
    const refreshedSource = await repo.getSource(source.id);
    const runs = await repo.listSourceRuns({ sourceId: source.id });

    expect(result).toMatchObject({
      provider: "apify",
      kind: "google_news",
      runStarted: false
    });
    expect(refreshedSource?.lastError).toContain("Apify fallback daily source cap reached");
    expect(runs).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("marks Apify demo placeholder datasets as source errors", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const queue = new FakeQueue();
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/actors/kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest/runs")) {
        expect(new URL(url).searchParams.get("maxItems")).toBe("112");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          searchTerms: ["from:ALJADEEDNEWS"],
          sort: "Latest",
          maxItems: 20
        });
        return new Response(JSON.stringify({
          data: {
            id: "run_x",
            status: "RUNNING",
            defaultDatasetId: "dataset_x",
            startedAt: "2026-06-16T08:00:00.000Z"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/actor-runs/run_x")) {
        return new Response(JSON.stringify({
          data: {
            id: "run_x",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset_x"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/datasets/dataset_x/items")) {
        return new Response(JSON.stringify([{ demo: true }, { demo: true }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    const app = createApp({ repository: repo, bucket, queue, fetcher: fetcher as unknown as typeof fetch });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const addResponse = await app.request(
      "/api/me/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ briefingId: briefing!.id, input: "x: @ALJADEEDNEWS" })
      },
      { ...env(), APIFY_API_TOKEN: "token" } as Env
    );
    expect(addResponse.status).toBe(200);

    await pollApifySourceRuns({
      repo,
      bucket,
      queue,
      env: { ...env(), APIFY_API_TOKEN: "token" } as Env,
      fetcher: fetcher as unknown as typeof fetch
    });

    const sources = await repo.listSources(briefing!.id);
    const source = sources.find((item) => item.kind === "x_profile");
    expect(source?.lastError).toContain("demo placeholders");
    const runs = await repo.listSourceRuns({ sourceId: source!.id });
    expect(runs[0]).toMatchObject({
      state: "failed",
      itemCount: 0
    });
    expect(runs[0].error).toContain("paid Apify plan");
    expect(queue.messages).toHaveLength(0);
  });

  it("serves feed links without auth even when an old row has the removed private flag", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();
    await repo.upsertBriefing({ ...briefing!, publicFeedEnabled: false, retentionDays: 60 });

    const edition: BriefingEdition = {
      id: "edition_old_private",
      briefingId: briefing!.id,
      cadence: "hourly",
      windowStart: "2026-06-16T07:00:00.000Z",
      windowEnd: "2026-06-16T08:00:00.000Z",
      title: "Hourly briefing",
      summary: "Old private rows now serve through normal feed links.",
      sections: [
        {
          title: "Update",
          summary: "Old private rows now serve through normal feed links.",
          evidence: []
        }
      ],
      status: "published",
      publishedAt: "2026-06-16T08:00:00.000Z",
      createdAt: "2026-06-16T08:00:00.000Z",
      updatedAt: "2026-06-16T08:00:00.000Z"
    };
    await repo.saveBriefingEdition(edition);

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as {
      briefing: { publicFeedEnabled: boolean; retentionDays: number };
      editions: Array<{ summary: string }>;
    };
    expect(feed.briefing.publicFeedEnabled).toBe(true);
    expect(feed.briefing.retentionDays).toBe(15);
    expect(feed.editions[0].summary).toContain("Old private rows");

    const searchResponse = await app.request("/api/feed/feed-owner/personal/search?q=private", {}, env());
    expect(searchResponse.status).toBe(200);

    const starResponse = await app.request(
      "/api/feed/feed-owner/personal/star",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starred: true })
      },
      env()
    );
    expect(starResponse.status).toBe(200);
  });

  it("merges saved items that reuse the same raw evidence", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Feed Owner");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const evidence = {
      messageId: `${briefing!.id}::raw_duplicate`,
      sourceId: "src_duplicate",
      sourceTitle: "LBCI_NEWS",
      sourceType: "channel" as const,
      sourceProvider: "telegram" as const,
      sourceKind: "telegram_channel" as const,
      sourceUrl: "https://t.me/LBCI_NEWS/303821",
      postedAt: "2026-06-18T08:38:00.000Z",
      text: "وزير الخارجية الإسرائيلي: قطع جميع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبي",
      links: ["https://twitter.com/LBCI_NEWS/status/2067527301990900181"],
      media: []
    };
    const first: BriefingItem = {
      id: "item_duplicate_a",
      clusterId: "cluster_duplicate_a",
      summary: "first summary",
      itemAt: "2026-06-18T08:38:00.000Z",
      updatedAt: "2026-06-18T08:38:00.000Z",
      expiresAt: "2026-07-03T08:38:00.000Z",
      mergedUpdateCount: 0,
      evidence: [evidence]
    };
    const second: BriefingItem = {
      ...first,
      id: "item_duplicate_b",
      clusterId: "cluster_duplicate_b",
      summary: "second summary"
    };

    await repo.saveBriefingItems(briefing!.id, [first, second]);
    const feedItems = await repo.listFeedItems(user.account.id, "personal", true);
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0].evidence).toHaveLength(1);
  });

  it("lists top explored feeds by stars and oldest tie", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });

    const older = await createVerifiedUser(app, repo, "older@test.com", "Older Owner");
    const newer = await createVerifiedUser(app, repo, "newer@test.com", "Newer Owner");
    const top = await createVerifiedUser(app, repo, "top@test.com", "Top Owner");
    const disabled = await createVerifiedUser(app, repo, "disabled@test.com", "Disabled Owner");
    const lowerOwners = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createVerifiedUser(app, repo, `lower-${index}@test.com`, `Lower Owner ${index}`)
      )
    );
    const owners = [older, newer, top, disabled, ...lowerOwners];

    const updates = [
      { owner: owners[0], title: "Older Tie", stars: 5 },
      { owner: owners[1], title: "Newer Tie", stars: 5 },
      { owner: owners[2], title: "Top Feed", stars: 9 },
      { owner: owners[3], title: "Disabled Feed", stars: 99 },
      ...owners.slice(4).map((owner, index) => ({ owner, title: `Lower Feed ${index}`, stars: 4 - (index % 4) }))
    ];

    for (const update of updates) {
      const briefing = await repo.getBriefingBySlug(update.owner.account.id, "personal");
      expect(briefing).not.toBeNull();
      await repo.upsertBriefing({ ...briefing!, title: update.title, stars: update.stars });
    }
    await repo.updateAccount({ id: owners[3].account.id, disabled: true });

    const response = await app.request("/api/explore/feeds", {}, env());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { feeds: Array<{ title: string; stars: number }> };
    expect(payload.feeds).toHaveLength(10);
    expect(payload.feeds.map((feed) => feed.title).slice(0, 3)).toEqual(["Top Feed", "Older Tie", "Newer Tie"]);
    expect(payload.feeds.some((feed) => feed.title === "Disabled Feed")).toBe(false);
  });

  it("redirects reserved old usernames after username changes", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Old Name");
    const briefingsResponse = await app.request("/api/me/briefings", { headers: { cookie: user.cookie } }, env());
    const { briefings } = (await briefingsResponse.json()) as { briefings: Array<Record<string, unknown>> };
    await app.request(
      "/api/me/briefings",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ ...briefings[0], publicFeedEnabled: true })
      },
      env()
    );

    const rename = await app.request(
      "/api/me/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ username: "New Name" })
      },
      env()
    );
    expect(rename.status).toBe(200);

    const redirect = await app.request("/api/feed/old-name/personal", {}, env());
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("http://localhost/api/feed/new-name/personal");
  });

  it("redirects legacy domains to the canonical Distilled domain", async () => {
    const app = createApp({ repository: new InMemoryRepository() });

    const legacy = await app.request("https://lownoise.news/ammar-mohanna/personal/?q=power", {}, env());
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe("https://distilled.news/ammar-mohanna/personal/?q=power");

    const canonicalWww = await app.request("https://www.distilled.news/", {}, env());
    expect(canonicalWww.status).toBe(301);
    expect(canonicalWww.headers.get("location")).toBe("https://distilled.news/");
  });

  it("requires the current password before changing account passwords", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Owner User");

    const rejected = await app.request(
      "/api/me/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "newpassword123" })
      },
      env()
    );
    expect(rejected.status).toBe(401);

    const changed = await app.request(
      "/api/me/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword123" })
      },
      env()
    );
    expect(changed.status).toBe(200);

    const oldLogin = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@test.com", password: "password123" })
      },
      env()
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@test.com", password: "newpassword123" })
      },
      env()
    );
    expect(newLogin.status).toBe(200);
  });

  it("treats malformed session cookies as unauthenticated", async () => {
    const app = createApp({ repository: new InMemoryRepository() });

    const response = await app.request(
      "/api/me/account",
      { headers: { cookie: "dn_session=not-a-valid-session" } },
      env()
    );

    expect(response.status).toBe(401);
  });

  it("fails closed for retention cleanup and deletes expired R2 archives when authorized", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const app = createApp({ repository: repo, bucket, queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Owner User");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const archiveKey = "telegram-public/briefing_1/source/expired.html";
    await bucket.put(archiveKey, "<html>old</html>");
    const message: NormalizedMessage = {
      id: `${briefing!.id}::expired_message`,
      source: { id: "src_expired", title: "Expired Source", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "expired_message",
      text: "Expired source post.",
      links: [],
      media: [],
      postedAt: "2026-05-01T10:00:00.000Z",
      receivedAt: "2026-05-01T10:00:10.000Z",
      sourceUrl: "https://t.me/source/1",
      rawPayloadKey: archiveKey,
      expiresAt: "2026-05-16T10:00:00.000Z"
    };
    const source = await repo.upsertSourceFromMessage(briefing!.id, message);
    await repo.saveRawMessage(briefing!.id, { ...message, source: { ...message.source, id: source.id } });

    const blocked = await app.request(
      "/api/internal/retention/run",
      { method: "POST" },
      { ...env(), INTERNAL_MAINTENANCE_SECRET: undefined } as Env
    );
    expect(blocked.status).toBe(401);
    expect(await repo.getRawMessage(message.id)).not.toBeNull();
    expect(bucket.objects.has(archiveKey)).toBe(true);

    const authorized = await app.request(
      "/api/internal/retention/run",
      { method: "POST", headers: { "x-distilled-internal": "internal-secret" } },
      env()
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ deleted: 1, archivesDeleted: 1, archiveDeleteFailures: 0 });
    expect(await repo.getRawMessage(message.id)).toBeNull();
    expect(bucket.objects.has(archiveKey)).toBe(false);
  });

  it("keeps shared R2 archives while any referencing raw message is still active", async () => {
    const repo = new InMemoryRepository();
    const bucket = new FakeBucket();
    const app = createApp({ repository: repo, bucket, queue: new FakeQueue() });
    const user = await createVerifiedUser(app, repo, "owner@test.com", "Owner User");
    const briefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(briefing).not.toBeNull();

    const archiveKey = "rss/briefing_1/source/shared.xml";
    await bucket.put(archiveKey, "<rss>mixed</rss>");
    const expired: NormalizedMessage = {
      id: `${briefing!.id}::expired_shared`,
      source: { id: "src_shared", title: "Shared Source", type: "channel", provider: "rss", kind: "rss_feed" },
      messageId: "expired_shared",
      text: "Expired source post.",
      links: [],
      media: [],
      postedAt: "2026-05-01T10:00:00.000Z",
      receivedAt: "2026-05-01T10:00:10.000Z",
      sourceUrl: "https://example.com/feed.xml#old",
      rawPayloadKey: archiveKey,
      expiresAt: "2026-05-16T10:00:00.000Z"
    };
    const active: NormalizedMessage = {
      ...expired,
      id: `${briefing!.id}::active_shared`,
      messageId: "active_shared",
      text: "Active source post.",
      postedAt: "2026-06-20T10:00:00.000Z",
      receivedAt: "2026-06-20T10:00:10.000Z",
      sourceUrl: "https://example.com/feed.xml#new",
      expiresAt: "2026-07-05T10:00:00.000Z"
    };
    const source = await repo.upsertSourceFromMessage(briefing!.id, expired);
    await repo.saveRawMessage(briefing!.id, { ...expired, source: { ...expired.source, id: source.id } });
    await repo.saveRawMessage(briefing!.id, { ...active, source: { ...active.source, id: source.id } });

    const authorized = await app.request(
      "/api/internal/retention/run",
      { method: "POST", headers: { "x-distilled-internal": "internal-secret" } },
      env()
    );

    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ deleted: 1, archivesDeleted: 0, archiveDeleteFailures: 0 });
    expect(await repo.getRawMessage(expired.id)).toBeNull();
    expect(await repo.getRawMessage(active.id)).not.toBeNull();
    expect(bucket.objects.has(archiveKey)).toBe(true);
  });

  it("lets admins view and manage accounts while preserving at least one admin", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const admin = await createVerifiedUser(app, repo, "admin@test.com", "Admin User", "admin");
    const user = await createVerifiedUser(app, repo, "user@test.com", "Normal User");

    const accountsResponse = await app.request("/api/admin/accounts", { headers: { cookie: admin.cookie } }, env());
    expect(accountsResponse.status).toBe(200);
    const accounts = (await accountsResponse.json()) as { accounts: Array<{ id: string; email: string }> };
    expect(accounts.accounts.map((account) => account.email)).toContain("user@test.com");

    const legacySecretResponse = await app.request(
      "/api/admin/accounts",
      { headers: { "x-distilled-admin": "admin-secret" } },
      env()
    );
    expect(legacySecretResponse.status).toBe(401);

    const disabled = await app.request(
      `/api/admin/accounts/${user.account.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ disabled: true })
      },
      env()
    );
    expect(disabled.status).toBe(200);

    const userBriefing = await repo.getBriefingBySlug(user.account.id, "personal");
    expect(userBriefing).not.toBeNull();

    const briefingsResponse = await app.request("/api/admin/briefings", { headers: { cookie: admin.cookie } }, env());
    expect(briefingsResponse.status).toBe(200);
    const adminBriefings = (await briefingsResponse.json()) as { briefings: Array<{ id: string; ownerAccountId: string }> };
    expect(adminBriefings.briefings.some((briefing) => briefing.ownerAccountId === user.account.id)).toBe(true);

    const pauseFeed = await app.request(
      `/api/admin/briefings/${userBriefing!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ paused: true })
      },
      env()
    );
    expect(pauseFeed.status).toBe(200);
    expect((await repo.getBriefingById(userBriefing!.id))?.paused).toBe(true);

    const deleteFeed = await app.request(
      `/api/admin/briefings/${userBriefing!.id}`,
      { method: "DELETE", headers: { cookie: admin.cookie } },
      env()
    );
    expect(deleteFeed.status).toBe(200);
    expect(await repo.getBriefingById(userBriefing!.id)).toBeNull();

    const deleteUser = await app.request(
      `/api/admin/accounts/${user.account.id}`,
      { method: "DELETE", headers: { cookie: admin.cookie } },
      env()
    );
    expect(deleteUser.status).toBe(200);
    expect(await repo.getAccountById(user.account.id)).toBeNull();

    const rejectSelfDelete = await app.request(
      `/api/admin/accounts/${admin.account.id}`,
      { method: "DELETE", headers: { cookie: admin.cookie } },
      env()
    );
    expect(rejectSelfDelete.status).toBe(400);

    const rejectLastAdminDisable = await app.request(
      `/api/admin/accounts/${admin.account.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ disabled: true })
      },
      env()
    );
    expect(rejectLastAdminDisable.status).toBe(400);
  });

  it("does not expose removed webhook or ask endpoints", async () => {
    const app = createApp({ repository: new InMemoryRepository() });

    const askResponse = await app.request("/api/ask/personal", {}, env());
    expect(askResponse.status).toBe(404);
    expect(await askResponse.json()).toEqual({ error: "not found" });

    const webhookResponse = await app.request("/telegram/webhook/briefing_default/secret", { method: "POST" }, env());
    expect(webhookResponse.status).toBe(404);
  });
});

async function createVerifiedUser(
  app: ReturnType<typeof createApp>,
  repo: InMemoryRepository,
  email: string,
  username: string,
  role: "admin" | "user" = "user"
) {
  const account = await repo.createAccount({
    email,
    username: username.toLowerCase().replace(/\s+/g, "-"),
    role,
    passwordHash: await hashPassword("password123"),
    emailVerifiedAt: new Date("2026-06-16T10:00:00.000Z").toISOString()
  });
  await repo.ensureDefaultBriefing(account);
  const login = await app.request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" })
    },
    env()
  );
  return { account, cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

function tokenFromMessage(text: string | undefined): string {
  const token = text?.match(/token=([^\s]+)/)?.[1];
  if (!token) throw new Error("token not found in email");
  return decodeURIComponent(token);
}
