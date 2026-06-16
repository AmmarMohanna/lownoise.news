import { describe, expect, it } from "vitest";
import type { BriefingConfig } from "@lownoise/core";
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
    expect(publicFeedUrl("ammar-mohanna", "personal", "https://lownoise.news")).toBe("https://lownoise.news/ammar-mohanna/personal/");
  });

  it("formats timestamps in 24-hour time for all supported languages", () => {
    const english = formatTime("2026-06-16T10:58:00.000Z", "en");
    const arabic = formatTime("2026-06-16T10:58:00.000Z", "ar");
    const french = formatTime("2026-06-16T10:58:00.000Z", "fr");

    expect(english).toMatch(/\b\d{2}:\d{2}\b/);
    expect(arabic).toMatch(/\b\d{2}:\d{2}\b/);
    expect(french).toMatch(/\b\d{2}:\d{2}\b/);
    expect(english).not.toMatch(/am|pm/i);
    expect(arabic).not.toMatch(/am|pm/i);
    expect(french).not.toMatch(/am|pm/i);
  });
});
