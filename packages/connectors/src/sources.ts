import type { SourceKind, SourceProvider } from "@distilled/core";
import { parsePublicTelegramChannelUrl } from "./telegram";

export type DetectedSourceInput =
  | {
      provider: "telegram";
      kind: "telegram_channel";
      input: string;
      title: string;
      username: string;
      sourceUrl: string;
    }
  | {
      provider: "rss";
      kind: "rss_feed";
      input: string;
      title: string;
      sourceUrl: string;
    }
  | {
      provider: "apify";
      kind: "google_news";
      input: string;
      title: string;
      actorInput: Record<string, unknown>;
    }
  | {
      provider: "apify";
      kind: "x_profile" | "x_search";
      input: string;
      title: string;
      username?: string;
      sourceUrl?: string;
      actorInput: Record<string, unknown>;
    }
  | {
      provider: "apify";
      kind: "linkedin_company" | "linkedin_profile" | "apify_actor";
      input: string;
      title: string;
      sourceUrl?: string;
      actorInput: Record<string, unknown>;
      actorId?: string;
    };

export function detectSourceInput(input: string): DetectedSourceInput {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a source URL or query.");

  if (/^t:/i.test(trimmed)) {
    const channelInput = trimmed.replace(/^t:\s*/i, "").trim();
    if (!channelInput) throw new Error("Paste a Telegram URL like https://t.me/LebUpdate");
    return telegramInput(channelInput, trimmed);
  }

  if (isTelegramInput(trimmed)) {
    return telegramInput(trimmed, trimmed);
  }

  if (/^rss:/i.test(trimmed)) {
    const url = trimmed.replace(/^rss:\s*/i, "").trim();
    assertHttpUrl(url, "Enter an RSS URL like rss: https://example.com/feed.xml");
    return {
      provider: "rss",
      kind: "rss_feed",
      input: trimmed,
      title: hostTitle(url),
      sourceUrl: url
    };
  }

  if (/^https?:\/\/[^\s]+$/i.test(trimmed) && looksLikeFeedUrl(trimmed)) {
    return {
      provider: "rss",
      kind: "rss_feed",
      input: trimmed,
      title: hostTitle(trimmed),
      sourceUrl: trimmed
    };
  }

  if (/^news:/i.test(trimmed)) {
    const query = trimmed.replace(/^news:\s*/i, "").trim();
    if (!query) throw new Error("Type a search topic like Lebanon electricity");
    return googleNewsInput(query, trimmed);
  }

  if (/^x:/i.test(trimmed)) {
    return detectXInput(trimmed.replace(/^x:\s*/i, "").trim(), trimmed);
  }

  const xUrl = trimmed.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i);
  if (xUrl) return xProfileInput(xUrl[1], trimmed);

  if (/^linkedin:/i.test(trimmed)) {
    return detectLinkedInInput(trimmed.replace(/^linkedin:\s*/i, "").trim(), trimmed);
  }

  if (/^apify:/i.test(trimmed)) {
    return detectAdvancedApifyInput(trimmed);
  }

  if (!/^https?:\/\//i.test(trimmed)) return googleNewsInput(trimmed, trimmed);

  throw new Error("Paste a full Telegram or X URL, or type a search topic.");
}

export function defaultActorIdForKind(kind: SourceKind, env: {
  APIFY_GOOGLE_NEWS_ACTOR_ID?: string;
  APIFY_X_ACTOR_ID?: string;
  APIFY_LINKEDIN_COMPANY_ACTOR_ID?: string;
  APIFY_LINKEDIN_PROFILE_ACTOR_ID?: string;
}): string | undefined {
  if (kind === "google_news") return env.APIFY_GOOGLE_NEWS_ACTOR_ID ?? "groupoject/google-news-scraper";
  if (kind === "x_profile" || kind === "x_search") {
    return env.APIFY_X_ACTOR_ID ?? "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest";
  }
  if (kind === "linkedin_company") return env.APIFY_LINKEDIN_COMPANY_ACTOR_ID ?? "harvestapi/linkedin-company-posts";
  if (kind === "linkedin_profile") return env.APIFY_LINKEDIN_PROFILE_ACTOR_ID ?? "harvestapi/linkedin-profile-posts";
  return undefined;
}

export function sourceProviderLabel(provider: SourceProvider, kind: SourceKind): string {
  if (provider === "telegram") return "Telegram";
  if (kind === "google_news") return "Google News";
  if (kind === "x_profile" || kind === "x_search") return "X";
  if (kind === "rss_feed") return "RSS";
  if (kind === "linkedin_company" || kind === "linkedin_profile") return "LinkedIn";
  return "Apify";
}

function telegramInput(value: string, original: string): DetectedSourceInput {
  const channel = parsePublicTelegramChannelUrl(value);
  return {
    provider: "telegram",
    kind: "telegram_channel",
    input: original,
    title: `@${channel.username}`,
    username: channel.username,
    sourceUrl: channel.publicUrl
  };
}

function detectXInput(value: string, original: string): DetectedSourceInput {
  const handle = value.match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1];
  if (handle) return xProfileInput(handle, original);
  if (!value) throw new Error("Paste an X URL like https://x.com/NASA or type a search topic.");
  return {
    provider: "apify",
    kind: "x_search",
    input: original,
    title: `X: ${value}`,
    actorInput: {
      searchTerms: [value],
      sort: "Latest",
      maxItems: 20
    }
  };
}

function googleNewsInput(query: string, original: string): DetectedSourceInput {
  return {
    provider: "apify",
    kind: "google_news",
    input: original,
    title: `Google News: ${query}`,
    actorInput: {
      queries: [query],
      geo: "US",
      language: "en",
      maxItemsPerQuery: 15,
      maxQueries: 1,
      dedupe: true,
      requestDelayMs: 0,
      maxConcurrency: 1
    }
  };
}

function xProfileInput(handle: string, original: string): DetectedSourceInput {
  return {
    provider: "apify",
    kind: "x_profile",
    input: original,
    title: `@${handle}`,
    username: handle,
    sourceUrl: `https://x.com/${handle}`,
    actorInput: {
      searchTerms: [`from:${handle}`],
      sort: "Latest",
      maxItems: 20
    }
  };
}

function detectLinkedInInput(value: string, original: string): DetectedSourceInput {
  assertHttpUrl(value, "Enter a LinkedIn company or profile URL.");
  const kind = value.includes("/company/") ? "linkedin_company" : "linkedin_profile";
  return {
    provider: "apify",
    kind,
    input: original,
    title: `LinkedIn: ${hostTitle(value)}`,
    sourceUrl: value,
    actorInput: {
      targetUrls: [value],
      maxPosts: 20,
      postedLimit: "24h",
      includeQuotePosts: true,
      includeReposts: false,
      scrapeReactions: false,
      scrapeComments: false
    }
  };
}

function detectAdvancedApifyInput(input: string): DetectedSourceInput {
  const body = input.replace(/^apify:\s*/i, "").trim();
  const [actorId, ...jsonParts] = body.split(/\s+/);
  if (!actorId) throw new Error("Enter an Apify actor id after apify:");
  const json = jsonParts.join(" ").trim();
  return {
    provider: "apify",
    kind: "apify_actor",
    input,
    title: `Apify: ${actorId}`,
    actorId,
    actorInput: json ? JSON.parse(json) as Record<string, unknown> : {}
  };
}

function isTelegramInput(input: string): boolean {
  return input.startsWith("@") || /^https?:\/\/t\.me\//i.test(input);
}

function looksLikeFeedUrl(input: string): boolean {
  return /\.(rss|xml|atom)(?:[?#].*)?$/i.test(input) || /\/(feed|rss|atom)(?:[/?#].*)?$/i.test(input);
}

function assertHttpUrl(input: string, message: string): void {
  try {
    const url = new URL(input);
    if (url.protocol === "http:" || url.protocol === "https:") return;
  } catch {
    // Fall through.
  }
  throw new Error(message);
}

function hostTitle(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return input;
  }
}
