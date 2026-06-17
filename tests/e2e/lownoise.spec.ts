import { expect, test } from "@playwright/test";

const briefing = {
  id: "briefing_default",
  ownerAccountId: "account_1",
  ownerUsername: "ammar-mohanna",
  slug: "personal",
  title: "Personal Briefing",
  stars: 0,
  interestProfile: "Track Lebanese infrastructure and public safety.",
  styleInstruction: "Use calm wording.",
  publicFeedEnabled: true,
  paused: false,
  language: "en",
  retentionDays: 15
};

const item = {
  id: "item_1",
  clusterId: "cluster_1",
  summary: "Electricite du Liban confirmed two extra hours of power supply tonight.",
  itemAt: "2026-06-16T08:00:00.000Z",
  updatedAt: "2026-06-16T08:02:00.000Z",
  expiresAt: "2026-07-01T08:00:00.000Z",
  mergedUpdateCount: 1,
  evidence: [
    {
      messageId: "telegram_1",
      sourceId: "telegram_-100123",
      sourceTitle: "Beirut Local",
      sourceType: "channel",
      sourceUrl: "https://t.me/beirutlocal/2",
      postedAt: "2026-06-16T08:00:00.000Z",
      text: "Electricite du Liban confirmed two extra hours of power supply tonight.",
      links: ["https://example.test/power"],
      media: [{ type: "photo", url: "https://example.test/power.jpg", label: "source photo" }]
    }
  ]
};

const firstRunBriefing = {
  ...briefing,
  publicFeedEnabled: false,
  interestProfile:
    "Track Lebanese security, economy, infrastructure, public safety, and major regional events. Ignore routine political statements unless they change concrete facts.",
  styleInstruction: "Use calm, balanced wording."
};

test("public signup asks for email, username, and password", async ({ page }) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ authenticated: false, setupRequired: false })
    });
  });
  await page.route("**/api/auth/register", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "register" }).click();
  await page.getByLabel("email").fill("ammar@example.com");
  await page.getByLabel("username").fill("Ammar Mohanna");
  await page.getByLabel("password").fill("password123");
  await page.getByRole("button", { name: /^register$/ }).first().click();
  await expect(page.getByText("check your email to verify your account")).toBeVisible();
});

test("email verification waits for an explicit user action", async ({ page }) => {
  let verifyCalls = 0;
  await page.route("**/api/auth/verify-email", async (route) => {
    verifyCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        account: {
          id: "account_1",
          email: "ammar@example.com",
          username: "ammar-mohanna",
          role: "user",
          emailVerifiedAt: "2026-06-16T08:00:00.000Z"
        }
      })
    });
  });

  await page.goto("/verify-email?token=test-token");

  await expect(page.getByRole("button", { name: "verify email" })).toBeVisible();
  expect(verifyCalls).toBe(0);

  await page.getByRole("button", { name: "verify email" }).click();
  await expect(page.getByText("email verified")).toBeVisible();
  expect(verifyCalls).toBe(1);
});

test("feed uses username-scoped URL while exposing evidence, refresh, and search", async ({ page }) => {
  let sessionRequests = 0;
  await page.route("**/api/auth/session", async (route) => {
    sessionRequests += 1;
    await route.abort();
  });
  await page.route("**/api/feed/ammar-mohanna/personal", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        briefing,
        items: [item],
        viewerHasStarred: false
      })
    });
  });
  await page.route("**/api/feed/ammar-mohanna/personal/search?q=power%20supply", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [item] }) });
  });

  await page.goto("/ammar-mohanna/personal/");

  await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();
  expect(sessionRequests).toBe(0);
  await expect(page.getByPlaceholder("search published briefing")).toBeVisible();
  await expect(page.locator(".news-item").filter({ hasText: item.summary }).first()).toBeVisible();
  await expect(page.getByText(/confidence|source count|breaking/i)).toHaveCount(0);

  await page.getByLabel(/show evidence/i).click();
  await expect(page.getByText("Beirut Local")).toBeVisible();
  await expect(page.getByRole("link", { name: /original/i })).toHaveAttribute("href", item.evidence[0].sourceUrl);

  await page.getByPlaceholder("search published briefing").fill("power supply");
  await page.keyboard.press("Enter");
  await expect(page.locator(".news-item").filter({ hasText: item.summary }).first()).toBeVisible();
});

test("admin setup keeps account settings tucked behind subtle controls", async ({ page }) => {
  const savedBriefings: Array<typeof briefing> = [];
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        setupRequired: false,
        account: {
          id: "account_1",
          email: "ammar@example.com",
          username: "ammar-mohanna",
          role: "admin",
          emailVerifiedAt: "2026-06-16T08:00:00.000Z"
        }
      })
    });
  });
  await page.route("**/api/me/briefings", async (route) => {
    if (route.request().method() === "POST") {
      savedBriefings.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ briefing: JSON.parse(route.request().postData() ?? "{}") })
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ briefings: [briefing] }) });
  });
  await page.route("**/api/me/sources?briefingId=briefing_default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sources: [
          {
            id: "telegram_-100123",
            briefingId: "briefing_default",
            title: "Beirut Local",
            type: "channel",
            enabled: false,
            lastSeenAt: "2026-06-16T08:00:00.000Z"
          }
        ]
      })
    });
  });
  await page.route("**/api/me/health?briefingId=briefing_default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        health: {
          lastTelegramEventAt: "2026-06-16T08:00:00.000Z",
          latestPublishedAt: "2026-06-16T08:05:00.000Z",
          processing: { queued: 0, completed: 1, failed: 1 }
        }
      })
    });
  });
  await page.route("**/api/admin/accounts", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [
          {
            id: "account_1",
            email: "ammar@example.com",
            username: "ammar-mohanna",
            role: "admin",
            emailVerifiedAt: "2026-06-16T08:00:00.000Z",
            briefingCount: 1
          }
        ]
      })
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "admin" })).toBeVisible();
  await expect(page.getByLabel("interest profile")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "fetch latest" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "retry processing" })).toHaveCount(0);
  await page.locator(".health-summary > summary").click();
  await expect(page.getByRole("button", { name: "retry processing" })).toBeVisible();
  await page.getByRole("button", { name: "feed settings for Personal Briefing" }).click();
  await expect(page.getByRole("dialog", { name: "feed settings" })).toBeVisible();
  await expect(page.getByLabel("interest profile")).toBeVisible();
  await expect(page.getByLabel("public feed")).toHaveCount(0);
  await expect(page.getByText("retention days")).toHaveCount(0);
  await page.getByLabel("title").fill("Local Briefing");
  await expect.poll(() => savedBriefings.some((saved) => saved.title === "Local Briefing")).toBe(true);
  await page.getByRole("button", { name: "close feed settings" }).click();
  await expect(page.getByLabel("username")).toHaveCount(0);
  await page.getByRole("button", { name: "account settings" }).click();
  await expect(page.getByRole("dialog", { name: "account" })).toBeVisible();
  await expect(page.getByLabel("username")).toHaveValue("ammar-mohanna");
  await expect(page.getByLabel("current password")).toBeVisible();
  await expect(page.getByLabel("new password")).toBeVisible();
  await page.getByRole("button", { name: "close account settings" }).click();
  await expect(page.getByRole("link", { name: "open Local Briefing", exact: true })).toHaveAttribute(
    "href",
    "/ammar-mohanna/local-briefing/"
  );
  await expect(page.getByText("private", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "feed help" }).click();
  await expect(page.getByRole("dialog", { name: "feed help" })).toBeVisible();
  await expect(page.getByText("Copy the feed URL when you want someone to read it.")).toBeVisible();
  await page.getByRole("button", { name: "close feed help" }).click();
  await expect(page.getByText("Beirut Local")).toBeVisible();
  await expect(page.getByRole("heading", { name: "accounts" })).toBeVisible();
  await page.getByRole("button", { name: "manage ammar-mohanna" }).click();
  await expect(page.getByRole("dialog", { name: "manage account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "disable account" })).toBeVisible();
});

test("first-run setup sheet creates the first feed and source", async ({ page }) => {
  let savedBriefing: typeof briefing | undefined;
  let sourceBody: { briefingId: string; url: string } | undefined;

  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        setupRequired: false,
        account: {
          id: "account_1",
          email: "ammar@example.com",
          username: "ammar-mohanna",
          role: "user",
          emailVerifiedAt: "2026-06-16T08:00:00.000Z"
        }
      })
    });
  });
  await page.route("**/api/me/briefings", async (route) => {
    if (route.request().method() === "POST") {
      savedBriefing = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ briefing: savedBriefing }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ briefings: [firstRunBriefing] }) });
  });
  await page.route("**/api/me/account", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        account: {
          id: "account_1",
          email: "ammar@example.com",
          username: "ammar-news",
          role: "user",
          emailVerifiedAt: "2026-06-16T08:00:00.000Z"
        },
        briefings: [{ ...firstRunBriefing, ownerUsername: "ammar-news" }]
      })
    });
  });
  await page.route("**/api/me/sources**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sources: [] }) });
      return;
    }
    sourceBody = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sources: [
          {
            id: "telegram_-100123",
            briefingId: "briefing_default",
            title: "Beirut Local",
            type: "channel",
            enabled: true,
            lastSeenAt: "2026-06-16T08:00:00.000Z"
          }
        ],
        health: {
          lastTelegramEventAt: "2026-06-16T08:00:00.000Z",
          latestPublishedAt: undefined,
          processing: { queued: 1, completed: 0, failed: 0 }
        }
      })
    });
  });
  await page.route("**/api/me/health?briefingId=briefing_default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        health: {
          lastTelegramEventAt: undefined,
          latestPublishedAt: undefined,
          processing: { queued: 0, completed: 0, failed: 0 }
        }
      })
    });
  });

  await page.goto("/");

  await expect(page.getByRole("dialog", { name: "setup feed" })).toBeVisible();
  await page.getByLabel("username").fill("Ammar News");
  await page.getByLabel("feed name").fill("City Watch");
  await page.getByLabel("interest profile").fill("Track Beirut infrastructure and public safety.");
  await page.getByLabel("first source").fill("https://t.me/LebUpdate");
  await page.getByRole("button", { name: "finish setup" }).click();

  await expect.poll(() => savedBriefing?.title).toBe("City Watch");
  expect(savedBriefing?.publicFeedEnabled).toBe(true);
  expect(sourceBody).toEqual({ briefingId: "briefing_default", url: "https://t.me/LebUpdate" });
  await expect(page.getByRole("dialog", { name: "setup feed" })).toHaveCount(0);
});
