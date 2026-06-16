import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { hashPassword } from "./auth";
import { processQueueMessage } from "./processor";
import { InMemoryRepository } from "./repository";
import type { Env, ProcessingJobMessage } from "./types";

class FakeBucket {
  objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }
}

class FakeQueue {
  messages: ProcessingJobMessage[] = [];

  async send(message: ProcessingJobMessage): Promise<void> {
    this.messages.push(message);
  }
}

class FakeEmail {
  messages: Array<{ to: string; subject: string; text?: string; html?: string }> = [];

  async send(message: { to: string; subject: string; text?: string; html?: string }): Promise<void> {
    this.messages.push(message);
  }
}

class FailingEmail {
  async send(): Promise<void> {
    throw new Error("email service unavailable");
  }
}

function env(email = new FakeEmail()): Env {
  return {
    ADMIN_SESSION_SECRET: "admin-secret",
    ADMIN_SETUP_TOKEN: "setup-token",
    INTERNAL_MAINTENANCE_SECRET: "internal-secret",
    PUBLIC_WEB_BASE_URL: "https://lownoise.news",
    EMAIL_FROM: "LowNoise.news <noreply@lownoise.news>",
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
    expect(response.headers.get("set-cookie")).toContain("ln_session=");
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
        body: JSON.stringify({ ...briefings[0], title: "Personal Briefing", interestProfile: "Track Lebanese infrastructure", publicFeedEnabled: true, paused: false, language: "en", retentionDays: 15, stars: 0 })
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

    await processQueueMessage(repo, queue.messages[0], new Date("2026-06-16T08:00:00.000Z"));

    const feedResponse = await app.request("/api/feed/feed-owner/personal", {}, env());
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as { items: Array<{ summary: string; evidence: Array<{ sourceUrl: string }> }> };
    expect(feed.items[0].summary).toContain("Electricite du Liban");
    expect(feed.items[0].evidence[0].sourceUrl).toBe("https://t.me/LebUpdate/10");

    const oldRoute = await app.request("/api/feed/personal", {}, env());
    expect(oldRoute.status).toBe(404);
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

  it("lets admins view and manage accounts while preserving at least one admin", async () => {
    const repo = new InMemoryRepository();
    const app = createApp({ repository: repo });
    const admin = await createVerifiedUser(app, repo, "admin@test.com", "Admin User", "admin");
    const user = await createVerifiedUser(app, repo, "user@test.com", "Normal User");

    const accountsResponse = await app.request("/api/admin/accounts", { headers: { cookie: admin.cookie } }, env());
    expect(accountsResponse.status).toBe(200);
    const accounts = (await accountsResponse.json()) as { accounts: Array<{ id: string; email: string }> };
    expect(accounts.accounts.map((account) => account.email)).toContain("user@test.com");

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
