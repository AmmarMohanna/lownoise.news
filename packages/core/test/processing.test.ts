import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  createEvidenceOnlySummary,
  demoMessages,
  firstSentence,
  personalNewsBriefing,
  processMessages,
  sanitizeEvidenceText,
  sanitizeSummary,
  searchBriefingItems
} from "../src";

describe("processMessages", () => {
  it("filters by interest profile and suppresses weak default items", () => {
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
      briefing: { ...personalNewsBriefing, intensity: "medium" },
      messages: [demoMessages[0]]
    });

    const second = processMessages({
      briefing: { ...personalNewsBriefing, intensity: "medium" },
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
      briefing: { ...personalNewsBriefing, intensity: "medium" },
      messages: [demoMessages[0], duplicate]
    });

    expect(result.publishedItems[0].evidence).toHaveLength(1);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_duplicate", reason: "duplicate" })
    );
  });

  it("merges Arabic same-event posts from multiple sources into one item", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar",
        intensity: "medium"
      },
      messages: [
        {
          id: "msg_lbci_303821",
          source: { id: "src_lbci", title: "LBCI_NEWS", type: "channel", provider: "telegram", kind: "telegram_channel", username: "LBCI_NEWS" },
          messageId: "303821",
          text: "وزير الخارجية الإسرائيلي: قطع جميع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبي https://twitter.com/LBCI_NEWS/status/2067527301990900181 June 18, 2026 at 10:38AM",
          links: ["https://twitter.com/LBCI_NEWS/status/2067527301990900181"],
          media: [],
          postedAt: "2026-06-18T08:38:00.000Z",
          receivedAt: "2026-06-18T08:38:10.000Z",
          sourceUrl: "https://t.me/LBCI_NEWS/303821",
          expiresAt: "2026-07-03T08:38:00.000Z"
        },
        {
          id: "msg_jadeed_2067528460738695496",
          source: { id: "src_aljadeed", title: "Al Jadeed News", type: "channel", provider: "apify", kind: "x_profile", username: "ALJADEEDNEWS" },
          messageId: "2067528460738695496",
          text: "وزير الخارجية الإسرائيلي: قطع جميع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبي",
          links: ["https://x.com/ALJADEEDNEWS/status/2067528460738695496"],
          media: [],
          postedAt: "2026-06-18T08:42:00.000Z",
          receivedAt: "2026-06-18T08:42:10.000Z",
          sourceUrl: "https://x.com/ALJADEEDNEWS/status/2067528460738695496",
          expiresAt: "2026-07-03T08:42:00.000Z"
        },
        {
          id: "msg_lbci_303822",
          source: { id: "src_lbci", title: "LBCI_NEWS", type: "channel", provider: "telegram", kind: "telegram_channel", username: "LBCI_NEWS" },
          messageId: "303822",
          text: "وزير الخارجية الإسرائيليّ: سأقطع الاتصالات مع مسؤولة السياسة الخارجية في الاتحاد الأوروبيّ #LBCINews https://t.co/JvcYreWuu1 https://twitter.com/LBCI_NEWS/status/2067527529599062343 June 18, 2026 at 10:39AM",
          links: ["https://t.co/JvcYreWuu1", "https://twitter.com/LBCI_NEWS/status/2067527529599062343"],
          media: [],
          postedAt: "2026-06-18T08:43:00.000Z",
          receivedAt: "2026-06-18T08:43:10.000Z",
          sourceUrl: "https://t.me/LBCI_NEWS/303822",
          expiresAt: "2026-07-03T08:43:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(1);
    expect(result.publishedItems[0].evidence.map((entry) => entry.messageId)).toEqual([
      "msg_lbci_303821",
      "msg_jadeed_2067528460738695496",
      "msg_lbci_303822"
    ]);
    expect(result.publishedItems[0].mergedUpdateCount).toBe(2);
  });

  it("rescues important single-source low-intensity updates", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        interestProfile: "Track Lebanese public safety and infrastructure incidents.",
        intensity: "low"
      },
      messages: [
        {
          id: "msg_important_blast",
          source: { id: "src_local", title: "Local Updates", type: "channel", provider: "telegram", kind: "telegram_channel" },
          messageId: "900",
          text: "انفجار كبير قرب مرفأ بيروت أدى إلى جريحين وإقفال الطريق",
          links: [],
          media: [],
          postedAt: "2026-06-18T09:00:00.000Z",
          receivedAt: "2026-06-18T09:00:10.000Z",
          sourceUrl: "https://t.me/local/900",
          expiresAt: "2026-07-03T09:00:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
  });

  it("keeps distinct important incidents separate", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar",
        intensity: "medium"
      },
      messages: [
        {
          id: "msg_strike_nabatieh",
          source: { id: "src_south", title: "South News", type: "channel", provider: "telegram", kind: "telegram_channel" },
          messageId: "1",
          text: "غارة إسرائيلية على النبطية أدت إلى جريحين",
          links: [],
          media: [],
          postedAt: "2026-06-18T09:10:00.000Z",
          receivedAt: "2026-06-18T09:10:10.000Z",
          sourceUrl: "https://t.me/south/1",
          expiresAt: "2026-07-03T09:10:00.000Z"
        },
        {
          id: "msg_strike_tyre",
          source: { id: "src_south", title: "South News", type: "channel", provider: "telegram", kind: "telegram_channel" },
          messageId: "2",
          text: "غارة إسرائيلية على صور أدت إلى قتيل",
          links: [],
          media: [],
          postedAt: "2026-06-18T09:12:00.000Z",
          receivedAt: "2026-06-18T09:12:10.000Z",
          sourceUrl: "https://t.me/south/2",
          expiresAt: "2026-07-03T09:12:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(2);
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

  it("suppresses teaser captions that do not state the news", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar",
        intensity: "medium"
      },
      messages: [
        {
          id: "msg_teaser_x",
          source: {
            id: "src_x_aljadeed",
            title: "Al Jadeed News",
            type: "channel",
            provider: "apify",
            kind: "x_profile",
            username: "ALJADEEDNEWS"
          },
          messageId: "2067327204279697663",
          text: "قبل توقيع الاتفاق مع إيران.. آخر تصريحات ترامب⬇️ https://t.co/WkRRoLzyNa",
          links: ["https://x.com/ALJADEEDNEWS/status/2067327204279697663", "https://t.co/WkRRoLzyNa"],
          media: [],
          postedAt: "2026-06-17T19:23:09.000Z",
          receivedAt: "2026-06-17T19:24:04.000Z",
          sourceUrl: "https://x.com/ALJADEEDNEWS/status/2067327204279697663",
          expiresAt: "2026-07-02T19:23:09.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_teaser_x", reason: "fluff" })
    );
  });

  it("suppresses Arabic details-link teasers with unfinished conditions", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar",
        intensity: "high"
      },
      messages: [
        {
          id: "msg_incomplete_details_teaser",
          source: {
            id: "src_x_aljadeed",
            title: "Al Jadeed News",
            type: "channel",
            provider: "apify",
            kind: "x_profile",
            username: "ALJADEEDNEWS"
          },
          messageId: "2067470284165104060",
          text: "لا انسحاب من جنوب لبنان إلا إذا.. نتنياهو يحسمها | للتفاصيل⏬ https://t.co/p6VdUwK9G1",
          links: [
            "https://x.com/ALJADEEDNEWS/status/2067470284165104060",
            "https://t.co/p6VdUwK9G1"
          ],
          media: [],
          postedAt: "2026-06-18T04:51:00.000Z",
          receivedAt: "2026-06-18T04:52:00.000Z",
          sourceUrl: "https://x.com/ALJADEEDNEWS/status/2067470284165104060",
          expiresAt: "2026-07-03T04:51:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_incomplete_details_teaser", reason: "fluff" })
    );
  });

  it("suppresses Arabic details-link teasers that only hint at an event", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        language: "ar",
        intensity: "high"
      },
      messages: [
        {
          id: "msg_context_only_martyr_teaser",
          source: {
            id: "src_x_aljadeed",
            title: "Al Jadeed News",
            type: "channel",
            provider: "apify",
            kind: "x_profile",
            username: "ALJADEEDNEWS"
          },
          messageId: "2067504406631735374",
          text: "اول شهيد في الجنوب.. عقب توقيع الاتفاق الإيراني-الأميركي⬇️ https://t.co/0paVzwgXXx",
          links: ["https://x.com/ALJADEEDNEWS/status/2067504406631735374"],
          media: [],
          postedAt: "2026-06-18T07:07:17.000Z",
          receivedAt: "2026-06-18T07:16:25.037Z",
          sourceUrl: "https://x.com/ALJADEEDNEWS/status/2067504406631735374",
          expiresAt: "2026-07-03T07:07:17.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_context_only_martyr_teaser", reason: "no_clear_information" })
    );
  });

  it("suppresses speculative personal noise even when it mentions a regional term", () => {
    const result = processMessages({
      briefing: {
        ...personalNewsBriefing,
        intensity: "medium"
      },
      messages: [
        {
          id: "msg_speculative_noise",
          source: {
            id: "src_telegram_noise",
            title: "Lebanese News and Updates",
            type: "channel",
            provider: "telegram",
            kind: "telegram_channel",
            username: "LebUpdate"
          },
          messageId: "62308",
          text: "what if i nuke israel rn",
          links: [],
          media: [],
          postedAt: "2026-06-17T19:18:00.000Z",
          receivedAt: "2026-06-17T19:18:01.000Z",
          sourceUrl: "https://t.me/LebUpdate/62308",
          expiresAt: "2026-07-02T19:18:00.000Z"
        }
      ]
    });

    expect(result.publishedItems).toHaveLength(0);
    expect(result.suppressed).toContainEqual(
      expect.objectContaining({ messageId: "msg_speculative_noise", reason: "non_authoritative_prediction" })
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
        language: "ar",
        intensity: "medium"
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
      briefing: { ...personalNewsBriefing, intensity: "medium" },
      messages: [demoMessages[0]]
    });
    const prompt = buildSummaryPrompt({
      briefing: personalNewsBriefing,
      evidence: result.publishedItems[0].evidence
    });

    expect(prompt).toContain("Use only the evidence below");
    expect(prompt).toContain("clear, standalone factual update");
    expect(prompt).toContain("return exactly NO_POST");
    expect(prompt).toContain("Do not answer questions or speculate");
    expect(prompt).not.toContain("/api/ask");
  });

  it("requests French output when the briefing language is French", () => {
    const result = processMessages({
      briefing: { ...personalNewsBriefing, intensity: "medium" },
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

  it("removes feed artifacts from summaries", () => {
    expect(
      sanitizeSummary(
        "💠عبري لايف|يسرائيل هيوم: أنباء أولية عن اتصالات متسارعة للتوصل إلى اتفاق مع لبنان https://twitter. com/LBCI_NEWS/status/2067311300137361568 June 17, 2026 at 08:19PM #lbcinews @LBCI_NEWS"
      )
    ).toBe("يسرائيل هيوم: أنباء أولية عن اتصالات متسارعة للتوصل إلى اتفاق مع لبنان");
  });

  it("removes bilingual Telegram boilerplate from Arabic summaries", () => {
    expect(
      sanitizeSummary(
        "نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد\nNetanyahu: We have struck Iran and its proxies in the region, and the operation is not over yet\nــــــــــــــ\nقناة موقع بنت جبيل على واتساب",
        "ar"
      )
    ).toBe("نتنياهو: وجهنا ضربة إلى إيران ووكلائها في المنطقة وهي عملية لم تنته بعد");
  });

  it("removes trailing channel boilerplate from Arabic evidence text", () => {
    expect(
      sanitizeEvidenceText("مشاهد توثق تمركز دبابات ميركافا وجرافة D9 في محيط جبانة حداثا قناة موقع بنت جبيل على واتساب", "ar")
    ).toBe("مشاهد توثق تمركز دبابات ميركافا وجرافة D9 في محيط جبانة حداثا");
  });

  it("drops meta refusal summaries instead of publishing them", () => {
    expect(
      sanitizeSummary(
        "No new verified information is available from the provided evidence to include in today’s Distilled.news briefing."
      )
    ).toBe("");
  });

  it("drops Arabic no-information summaries instead of publishing them", () => {
    expect(
      sanitizeSummary(
        "لا توجد معلومات جديدة متعلقة بالأمن أو الاقتصاد أو البنية التحتية أو السلامة العامة في لبنان في الوقت الحالي."
      )
    ).toBe("");
  });

  it("drops explicit no-post summary decisions", () => {
    expect(sanitizeSummary("NO_POST")).toBe("");
  });

  it("drops context-only summaries without concrete information value", () => {
    expect(sanitizeSummary("عقب توقيع الاتفاق الإيراني-الأميركي")).toBe("");
    expect(sanitizeSummary("اول شهيد في الجنوب")).toBe("");
  });

  it("keeps concise incident summaries with a concrete cause", () => {
    expect(sanitizeSummary("جريحان نتيجة تصادم بين مركبتين على أوتوستراد الناعمة باتجاه بيروت")).toBe(
      "جريحان نتيجة تصادم بين مركبتين على أوتوستراد الناعمة باتجاه بيروت"
    );
  });

  it("recognizes Arabic sentence endings instead of slicing at the fallback limit", () => {
    expect(firstSentence("أعلنت الرئاسة اللبنانية موقفها من التطورات؟ وأضافت أنها تتابع الاتصالات.")).toBe(
      "أعلنت الرئاسة اللبنانية موقفها من التطورات؟"
    );
  });

  it("does not cut Arabic evidence-only summaries at 220 characters", () => {
    const text = "الرئاسة اللبنانية: شكر الرئيس عون نائب الرئيس الاميركي ووزير الخارجية على الاهتمام الذي تبديه الولايات المتحدة حيال لبنان بهدف انهاء الحرب فيه وتعزيز سلطة الدولة اللبنانية واستقلالية قرارها باعتبارها المسؤولة وحدها عن حفظ";
    expect([...text].slice(0, 220).join("")).toMatch(/عن حف$/u);

    expect(
      createEvidenceOnlySummary({ ...personalNewsBriefing, language: "ar" }, [
        {
          messageId: "presidency-update",
          sourceId: "src_lbci",
          sourceTitle: "LBCI_NEWS",
          sourceType: "channel",
          sourceProvider: "apify",
          sourceKind: "x_profile",
          postedAt: "2026-06-23T14:53:00.000Z",
          text,
          links: [],
          media: []
        }
      ])
    ).toBe(text);
  });

  it("removes no-details artifact sentences while keeping factual content", () => {
    expect(
      sanitizeSummary(
        "أعلن دونالد ترامب أنه قد يحضر مراسم توقيع الاتفاق مع إيران. لم ترد تفاصيل إضافية حول تأثير هذا الحضور على الأوضاع الإقليمية أو اللبنانية."
      )
    ).toBe("أعلن دونالد ترامب أنه قد يحضر مراسم توقيع الاتفاق مع إيران.");
  });

  it("chooses informative evidence over teaser fragments", () => {
    expect(
      createEvidenceOnlySummary(personalNewsBriefing, [
        {
          messageId: "teaser",
          sourceId: "src_x",
          sourceTitle: "Al Jadeed News",
          sourceType: "channel",
          sourceProvider: "apify",
          sourceKind: "x_profile",
          postedAt: "2026-06-17T19:23:09.000Z",
          text: "قبل توقيع الاتفاق مع إيران.. آخر تصريحات ترامب⬇️ https://t.co/WkRRoLzyNa",
          links: ["https://t.co/WkRRoLzyNa"],
          media: []
        },
        {
          messageId: "quote",
          sourceId: "src_x",
          sourceTitle: "Al Jadeed News",
          sourceType: "channel",
          sourceProvider: "apify",
          sourceKind: "x_profile",
          postedAt: "2026-06-17T17:12:32.000Z",
          text: "ترامب: قد أبقى لحضور مراسم توقيع الاتفاق مع إيران",
          links: [],
          media: []
        }
      ])
    ).toBe("ترامب: قد أبقى لحضور مراسم توقيع الاتفاق مع إيران");
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
