import { describe, expect, it } from "vitest";
import { buildBriefingEdition, getDueBriefingWindow, personalNewsBriefing } from "../src";
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
    expect(edition.summary).toBe("1 update in this hourly brief.");
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
