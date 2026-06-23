import { describe, expect, it } from "vitest";
import { buildBriefingEdition, getDueBriefingWindow, personalNewsBriefing, synthesizeEditionNarrativeSummary } from "../src";
import type { NormalizedMessage } from "../src";

describe("briefing cadence", () => {
  it("creates an hourly window when the briefing is due", () => {
    const window = getDueBriefingWindow(
      {
        ...personalNewsBriefing,
        briefingCadence: "hourly",
        nextBriefingAt: "2026-06-16T09:00:00.000Z"
      },
      new Date("2026-06-16T09:02:00.000Z")
    );

    expect(window).toEqual({
      cadence: "hourly",
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      nextBriefingAt: "2026-06-16T10:00:00.000Z"
    });
  });

  it("does not create a window before the next briefing time", () => {
    expect(getDueBriefingWindow(
      { ...personalNewsBriefing, nextBriefingAt: "2026-06-16T09:00:00.000Z" },
      new Date("2026-06-16T08:59:00.000Z")
    )).toBeNull();
  });

  it("falls back to UTC for invalid timezones", () => {
    const window = getDueBriefingWindow(
      {
        ...personalNewsBriefing,
        briefingTimezone: "Not/AZone",
        nextBriefingAt: undefined
      },
      new Date("2026-06-16T09:02:00.000Z")
    );

    expect(window?.windowEnd).toBe("2026-06-16T09:00:00.000Z");
  });
});

describe("briefing editions", () => {
  it("builds one edition from a window of matching messages", () => {
    const message: NormalizedMessage = {
      id: "briefing_default::msg_power",
      source: { id: "src_power", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
      messageId: "msg_power",
      text: "Electricite du Liban announced two extra hours of power supply tonight.",
      links: [],
      media: [],
      postedAt: "2026-06-16T08:15:00.000Z",
      receivedAt: "2026-06-16T08:15:10.000Z",
      sourceUrl: "https://t.me/power/1",
      expiresAt: "2026-07-01T08:15:00.000Z"
    };

    const edition = buildBriefingEdition({
      briefing: personalNewsBriefing,
      messages: [message],
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      now: new Date("2026-06-16T09:00:10.000Z")
    });

    expect(edition.status).toBe("published");
    expect(edition.title).toBe("Hourly brief");
    expect(edition.summary).toBe("This hour: Electricite du Liban announced two extra hours of power supply tonight [1].");
    expect(edition.sections).toHaveLength(1);
    expect(edition.sections[0].evidence[0].messageId).toBe(message.id);
  });

  it("localizes edition chrome for Arabic feeds", () => {
    const edition = buildBriefingEdition({
      briefing: { ...personalNewsBriefing, language: "ar" },
      messages: [],
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      now: new Date("2026-06-16T09:00:10.000Z")
    });

    expect(edition.title).toBe("موجز الساعة");
    expect(edition.summary).toBe("لا توجد تحديثات موثوقة في موجز الساعة.");
    expect(edition.sections[0].title).toBe("لا تحديثات");
  });

  it("synthesizes multiple updates into one referenced paragraph", () => {
    const summary = synthesizeEditionNarrativeSummary(
      [
        {
          title: "Infrastructure",
          summary: "Electricite du Liban announced two extra hours of power supply tonight.",
          evidence: []
        },
        {
          title: "Security",
          summary: "The army reopened the coastal road after a security incident.",
          evidence: []
        }
      ],
      "hourly",
      "en"
    );

    expect(summary).toBe(
      "This hour: Electricite du Liban announced two extra hours of power supply tonight [1]. Also, the army reopened the coastal road after a security incident [2]."
    );
  });

  it("caps hourly synthesis to a medium paragraph with practical references", () => {
    const sections = Array.from({ length: 8 }, (_, index) => ({
      title: "Update",
      summary: `Update ${index + 1} adds confirmed context about public services, official timing, affected neighborhoods, operational limits, and what residents should expect before the next scheduled notice from authorities.`,
      evidence: []
    }));

    const summary = synthesizeEditionNarrativeSummary(sections, "hourly", "en");

    expect(summary).toContain("[1]");
    expect(summary).not.toContain("[7]");
    expect(summary.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(150);
  });

  it("groups multiple raw items into one reference bundle when they support the same point", () => {
    const messages: NormalizedMessage[] = [
      {
        id: "briefing_default::power_a",
        source: { id: "src_power_a", title: "Power Wire", type: "channel", provider: "telegram", kind: "telegram_channel" },
        messageId: "power-a",
        text: "Electricite du Liban confirmed two additional hours of power supply tonight after fuel shipments arrived.",
        links: [],
        media: [],
        postedAt: "2026-06-16T08:15:00.000Z",
        receivedAt: "2026-06-16T08:15:10.000Z",
        sourceUrl: "https://t.me/powerA/1",
        expiresAt: "2026-07-01T08:15:00.000Z"
      },
      {
        id: "briefing_default::power_b",
        source: { id: "src_power_b", title: "North Updates", type: "channel", provider: "telegram", kind: "telegram_channel" },
        messageId: "power-b",
        text: "Electricite du Liban confirmed two additional hours of power supply tonight after fuel shipments arrived.",
        links: [],
        media: [],
        postedAt: "2026-06-16T08:18:00.000Z",
        receivedAt: "2026-06-16T08:18:10.000Z",
        sourceUrl: "https://t.me/powerB/1",
        expiresAt: "2026-07-01T08:18:00.000Z"
      }
    ];

    const edition = buildBriefingEdition({
      briefing: personalNewsBriefing,
      messages,
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      now: new Date("2026-06-16T09:00:10.000Z")
    });

    expect(edition.sections).toHaveLength(1);
    expect(edition.sections[0].evidence).toHaveLength(2);
    expect(edition.summary).toContain("[1]");
  });

  it("publishes an explicit empty edition when nothing meaningful happened", () => {
    const edition = buildBriefingEdition({
      briefing: personalNewsBriefing,
      messages: [],
      windowStart: "2026-06-16T08:00:00.000Z",
      windowEnd: "2026-06-16T09:00:00.000Z",
      now: new Date("2026-06-16T09:00:10.000Z")
    });

    expect(edition.status).toBe("empty");
    expect(edition.summary).toBe("No verified updates in this hourly brief.");
  });
});
