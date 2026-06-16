import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  demoMessages,
  personalNewsBriefing,
  processMessages,
  sanitizeSummary,
  searchBriefingItems
} from "../src";

describe("processMessages", () => {
  it("filters by interest profile and suppresses low-noise defaults", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: demoMessages
    });

    expect(result.publishedItems).toHaveLength(1);
    expect(result.publishedItems[0].summary).toContain("Electricite du Liban");
    expect(result.publishedItems[0].evidence).toHaveLength(2);
    expect(result.suppressed.map((entry) => entry.reason)).toContain(
      "political_statement_without_new_facts"
    );
    expect(result.suppressed.map((entry) => entry.reason)).toContain("not_relevant");
  });

  it("merges repeated updates into existing briefing items", () => {
    const first = processMessages({
      briefing: personalNewsBriefing,
      messages: [demoMessages[0]]
    });

    const second = processMessages({
      briefing: personalNewsBriefing,
      messages: [demoMessages[1]],
      existingItems: first.publishedItems
    });

    expect(second.publishedItems).toHaveLength(1);
    expect(second.publishedItems[0].mergedUpdateCount).toBe(1);
    expect(second.publishedItems[0].evidence.map((entry) => entry.messageId)).toEqual([
      "msg_1",
      "msg_2"
    ]);
  });

  it("deduplicates exact repeated messages", () => {
    const duplicate = { ...demoMessages[0], id: "msg_duplicate", messageId: "102" };
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: [demoMessages[0], duplicate]
    });

    expect(result.publishedItems[0].evidence).toHaveLength(1);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_duplicate", reason: "duplicate" })
    );
  });

  it("suppresses no-update filler posts", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: [
        {
          ...demoMessages[0],
          id: "msg_no_update",
          messageId: "201",
          text: "No new verified information this hour. No major regional events to report."
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_no_update", reason: "repeated_update" })
    );
  });

  it("searches retained published items and ignores expired items", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: demoMessages
    });

    expect(searchBriefingItems(result.publishedItems, "power supply", new Date("2026-06-16"))).toHaveLength(1);
    expect(searchBriefingItems(result.publishedItems, "power supply", new Date("2026-07-10"))).toHaveLength(0);
  });

  it("matches Arabic source text against an English interest profile for Arabic feeds", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar"
      },
      messages: [
        {
          id: "msg_ar_1",
          source: { id: "src_ar_1", title: "LBCI_NEWS", type: "channel", username: "LBCI_NEWS" },
          messageId: "303523",
          text: "التحكم المروري: جريحان نتيجة تصادم بين مركبتين على أوتوستراد الناعمة باتجاه بيروت",
          links: [],
          media: [],
          postedAt: "2026-06-16T14:23:10.000Z",
          receivedAt: "2026-06-16T14:23:12.000Z",
          sourceUrl: "https://t.me/LBCI_NEWS/303523",
          expiresAt: "2026-07-01T14:23:10.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(1);
    expect(result.publishedItems[0].summary).toContain("جريحان");
    expect(result.suppressed).toHaveLength(0);
  });
});

describe("summary prompt", () => {
  it("locks summary generation to evidence and avoids chatbot behavior", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: [demoMessages[0]]
    });
    const prompt = buildSummaryPrompt({
      briefing: personalNewsBriefing,
      evidence: result.publishedItems[0].evidence
    });

    expect(prompt).toContain("Use only the evidence below");
    expect(prompt).toContain("Do not answer questions or speculate");
    expect(prompt).not.toContain("/api/ask");
  });

  it("requests French output when the briefing language is French", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: [demoMessages[0]]
    });
    const prompt = buildSummaryPrompt({
      briefing: {
        ...personalNewsBriefing,
        language: "fr"
      },
      evidence: result.publishedItems[0].evidence
    });

    expect(prompt).toContain("Write the summary in French.");
  });

  it("removes repeated sentences from summaries", () => {
    expect(
      sanitizeSummary("BREAKING: Power supply improved in Beirut tonight. Power supply improved in Beirut tonight.")
    ).toBe("Power supply improved in Beirut tonight.");
  });

  it("drops meta refusal summaries instead of publishing them", () => {
    expect(
      sanitizeSummary(
        "No new verified information is available from the provided evidence to include in today’s LowNoise.news briefing."
      )
    ).toBe("");
  });

  it("does not treat a source title as enough relevance by itself", () => {
    const result = processMessages({
      briefing: personalNewsBriefing,
      messages: [
        {
          id: "msg_irrelevant_source_match",
          source: {
            id: "src_irrelevant",
            title: "Lebanese News and Updates",
            type: "channel",
            username: "lebupdates"
          },
          messageId: "999",
          text: "Off to a wonderful shitty start I see",
          links: [],
          media: [],
          postedAt: "2026-06-16T18:00:00.000Z",
          receivedAt: "2026-06-16T18:00:01.000Z",
          sourceUrl: "https://t.me/lebupdates/999",
          expiresAt: "2026-07-01T18:00:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({
        messageId: "msg_irrelevant_source_match",
        reason: "not_relevant"
      })
    );
  });
});
