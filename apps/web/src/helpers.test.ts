import { describe, expect, it } from "vitest";
import type { BriefingConfig } from "@distilled/core";
import { deriveBriefingSlug, formatTime, publicFeedUrl, slugify, uniqueSlug } from "./helpers";

const baseBriefing: BriefingConfig = {
  id: "briefing_default",
  ownerAccountId: "account_admin",
  ownerUsername: "admin",
  slug: "personal",
  title: "Personal Briefing",
  stars: 3,
  interestProfile: "Track power and public safety",
  styleInstruction: "",
  publicFeedEnabled: false,
  paused: false,
  language: "en",
  intensity: "low",
  briefingCadence: "hourly",
  briefingTimeOfDay: "00:00",
  briefingTimezone: "UTC",
  retentionDays: 15
};

describe("web helpers", () => {
  it("slugifies feed names conservatively", () => {
    expect(slugify(" Beirut / Security Feed ")).toBe("beirut-security-feed");
    expect(slugify("###")).toBe("briefing");
  });

  it("creates unique slugs for multiple briefings", () => {
    expect(uniqueSlug([baseBriefing], "personal")).toBe("personal-2");
    expect(uniqueSlug([baseBriefing], "new feed")).toBe("new-feed");
  });

  it("derives slugs from titles while ignoring the current feed id", () => {
    expect(deriveBriefingSlug([baseBriefing], "Hello world")).toBe("hello-world");
    expect(deriveBriefingSlug([baseBriefing], "Personal Briefing", baseBriefing.id)).toBe("personal-briefing");
  });

  it("builds shareable public feed URLs", () => {
    expect(publicFeedUrl("ammar-mohanna", "personal", "https://distilled.news")).toBe("https://distilled.news/ammar-mohanna/personal/");
  });

  it("formats timestamps consistently for all supported languages", () => {
    const english = formatTime("2026-06-16T10:58:00.000Z", "en");
    const arabic = formatTime("2026-06-16T10:58:00.000Z", "ar");
    const french = formatTime("2026-06-16T10:58:00.000Z", "fr");

    expect(english).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{2}:\d{2}$/);
    expect(arabic).toMatch(/[\u0600-\u06FF]/u);
    expect(arabic).not.toBe(english);
    expect(french).toMatch(/\d{1,2} [A-Za-zÀ-ÖØ-öø-ÿ]+, \d{2}:\d{2}/u);
    expect(french).not.toBe(english);
    expect(english).not.toMatch(/am|pm/i);
  });
});
