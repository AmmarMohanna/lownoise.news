import { searchBriefingItems, type BriefingConfig } from "@lownoise/core";
import {
  normalizeTelegramUpdate,
  registerTelegramWebhook,
  validateTelegramWebhookSecret,
  type TelegramUpdate
} from "@lownoise/connectors";
import { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { adminAuth, clearSessionCookie, createSession, hashPassword, setSessionCookie, verifySession } from "./auth";
import { D1Repository } from "./repository";
import type { Env, ProcessingJobMessage, Repository } from "./types";

type Variables = {
  repo: Repository;
};

export interface AppOptions {
  repository?: Repository;
  bucket?: { put(key: string, value: string, options?: unknown): Promise<unknown> };
  queue?: { send(message: ProcessingJobMessage): Promise<unknown> };
  fetcher?: typeof fetch;
}

const briefingInputSchema = z.object({
  id: z.string().min(1).default("briefing_default"),
  slug: z.string().min(1).default("personal"),
  title: z.string().min(1).default("Personal Briefing"),
  interestProfile: z.string().min(1),
  styleInstruction: z.string().optional(),
  publicFeedEnabled: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(90).default(15)
});

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  const repoFor = (c: { env: Env }): Repository => options.repository ?? new D1Repository(c.env.DB);
  const bucketFor = (c: { env: Env }) => options.bucket ?? c.env.RAW_ARCHIVE;
  const queueFor = (c: { env: Env }) => options.queue ?? c.env.PROCESSING_QUEUE;
  const fetcher = options.fetcher ?? fetch;

  app.get("/api/admin/session", async (c) => {
    const repo = repoFor(c);
    const setupRequired = !(await repo.getSetting("admin_password_hash"));
    const authenticated = await verifySession(
      getCookie(c, "ln_session"),
      c.env.ADMIN_SESSION_SECRET ?? ""
    );
    return c.json({ authenticated, setupRequired });
  });

  app.post("/api/admin/session", async (c) => {
    const repo = repoFor(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      password?: string;
      setupToken?: string;
    };
    if (!body.password) return c.json({ error: "password is required" }, 400);
    if (!c.env.ADMIN_SESSION_SECRET) {
      return c.json({ error: "ADMIN_SESSION_SECRET is not configured" }, 500);
    }

    const existingHash = await repo.getSetting("admin_password_hash");
    if (!existingHash) {
      const expectedSetupToken = c.env.ADMIN_SETUP_TOKEN ?? c.env.ADMIN_SESSION_SECRET;
      if (body.setupToken !== expectedSetupToken) return c.json({ error: "invalid setup token" }, 401);
      await repo.setSetting("admin_password_hash", await hashPassword(body.password));
    } else if ((await hashPassword(body.password)) !== existingHash) {
      return c.json({ error: "invalid password" }, 401);
    }

    setSessionCookie(c, await createSession(c.env.ADMIN_SESSION_SECRET));
    return c.json({ ok: true });
  });

  app.delete("/api/admin/session", async (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.use("/api/admin/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/api/admin/session") return next();
    return adminAuth(repoFor)(c, next);
  });

  app.get("/api/admin/briefings", async (c) => {
    const repo = c.get("repo");
    await repo.ensureDefaultBriefing();
    return c.json({ briefings: await repo.listBriefings() });
  });

  app.post("/api/admin/briefings", async (c) => {
    const repo = c.get("repo");
    const input = briefingInputSchema.parse(await c.req.json());
    const briefing = await repo.upsertBriefing(input);
    return c.json({ briefing });
  });

  app.get("/api/admin/sources", async (c) => {
    const repo = c.get("repo");
    const briefing = await repo.ensureDefaultBriefing();
    return c.json({ sources: await repo.listSources(briefing.id) });
  });

  app.post("/api/admin/sources", async (c) => {
    const repo = c.get("repo");
    const body = (await c.req.json()) as { sourceId?: string; enabled?: boolean };
    if (!body.sourceId || typeof body.enabled !== "boolean") {
      return c.json({ error: "sourceId and enabled are required" }, 400);
    }
    await repo.setSourceEnabled(body.sourceId, body.enabled);
    const briefing = await repo.ensureDefaultBriefing();
    return c.json({ sources: await repo.listSources(briefing.id) });
  });

  app.get("/api/admin/health", async (c) => {
    const repo = c.get("repo");
    return c.json({ health: await repo.getHealth(c.env) });
  });

  app.post("/api/admin/telegram/register-webhook", async (c) => {
    const repo = c.get("repo");
    const briefing = await repo.ensureDefaultBriefing();
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ error: "Telegram bot token or webhook secret is not configured" }, 400);
    }

    const apiBase = c.env.PUBLIC_API_BASE_URL ?? new URL(c.req.url).origin;
    const webhookUrl = `${apiBase}/telegram/webhook/${briefing.id}/${c.env.TELEGRAM_WEBHOOK_SECRET}`;
    const result = await registerTelegramWebhook(
      {
        botToken: c.env.TELEGRAM_BOT_TOKEN,
        webhookUrl,
        secretToken: c.env.TELEGRAM_WEBHOOK_SECRET
      },
      fetcher
    );

    if (result.ok) await repo.setSetting("telegram_webhook_registered", "true");
    return c.json({ result, webhookUrl });
  });

  app.post("/telegram/webhook/:briefingId/:secret", async (c) => {
    const repo = repoFor(c);
    const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (
      c.req.param("secret") !== expectedSecret ||
      !validateTelegramWebhookSecret(c.req.header("X-Telegram-Bot-Api-Secret-Token"), expectedSecret)
    ) {
      return c.json({ error: "invalid webhook secret" }, 401);
    }

    const briefing = await repo.getBriefingById(c.req.param("briefingId"));
    if (!briefing) return c.json({ error: "briefing not found" }, 404);

    const update = (await c.req.json()) as TelegramUpdate;
    const rawPayloadKey = `telegram/${briefing.id}/${update.update_id}.json`;
    await bucketFor(c).put(rawPayloadKey, JSON.stringify(update), {
      httpMetadata: { contentType: "application/json" }
    });

    const normalized = normalizeTelegramUpdate(update, {
      rawPayloadKey,
      retentionDays: briefing.retentionDays
    });
    if (!normalized) return c.json({ ok: true, ignored: true });

    const source = await repo.upsertSourceFromMessage(briefing.id, normalized);
    await repo.saveRawMessage(briefing.id, normalized);
    await repo.setSetting("last_telegram_event_at", normalized.receivedAt);

    if (!source.enabled) return c.json({ ok: true, queued: false, sourceDetected: true });

    const jobId = await repo.createProcessingJob(briefing.id, normalized.id);
    await queueFor(c).send({ jobId, briefingId: briefing.id, rawMessageId: normalized.id });
    return c.json({ ok: true, queued: true, jobId });
  });

  app.get("/api/feed/:briefingSlug", async (c) => {
    const repo = repoFor(c);
    const briefing = await repo.getBriefingBySlug(c.req.param("briefingSlug"));
    if (!briefing) return c.json({ error: "briefing not found" }, 404);
    const includePrivate = await isAdminRequest(c, briefing);
    if (!briefing.publicFeedEnabled && !includePrivate) return c.json({ error: "feed is private" }, 401);
    return c.json({ briefing: publicBriefing(briefing), items: await repo.listFeedItems(briefing.slug, true) });
  });

  app.get("/api/feed/:briefingSlug/search", async (c) => {
    const repo = repoFor(c);
    const briefing = await repo.getBriefingBySlug(c.req.param("briefingSlug"));
    if (!briefing) return c.json({ error: "briefing not found" }, 404);
    const includePrivate = await isAdminRequest(c, briefing);
    if (!briefing.publicFeedEnabled && !includePrivate) return c.json({ error: "feed is private" }, 401);

    const query = c.req.query("q") ?? "";
    const items = await repo.listFeedItems(briefing.slug, true);
    return c.json({ items: searchBriefingItems(items, query) });
  });

  app.post("/api/internal/retention/run", async (c) => {
    if (c.req.header("x-lownoise-internal") !== c.env.INTERNAL_MAINTENANCE_SECRET) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const repo = repoFor(c);
    return c.json({ deleted: await repo.deleteExpired() });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.all("*", async (c) => {
    if (c.env.ASSETS) {
      const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
      if (assetResponse.status !== 404 || c.req.method !== "GET") return assetResponse;

      const accept = c.req.header("accept") ?? "";
      const requestPath = new URL(c.req.url).pathname;
      const hasFileExtension = /\/[^/]+\.[^/]+$/.test(requestPath);
      if (hasFileExtension && !accept.includes("text/html")) return assetResponse;

      const indexUrl = new URL(c.req.url);
      indexUrl.pathname = "/";
      indexUrl.search = "";
      return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw));
    }
    return c.text("LowNoise.news Worker is running. Build apps/web to serve the UI.", 200);
  });

  return app;
}

async function isAdminRequest(c: Context<{ Bindings: Env; Variables: Variables }>, _briefing: BriefingConfig): Promise<boolean> {
  const secret = c.env.ADMIN_SESSION_SECRET ?? "";
  if (c.req.header("x-lownoise-admin") === secret && secret) return true;
  return verifySession(getCookie(c, "ln_session"), secret);
}

function publicBriefing(briefing: BriefingConfig): Omit<BriefingConfig, "interestProfile" | "styleInstruction"> {
  return {
    id: briefing.id,
    slug: briefing.slug,
    title: briefing.title,
    publicFeedEnabled: briefing.publicFeedEnabled,
    retentionDays: briefing.retentionDays
  };
}
