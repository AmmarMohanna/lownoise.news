import type { BriefingConfig, NormalizedMessage } from "./types";

export const personalNewsBriefing: BriefingConfig = {
  id: "briefing_default",
  ownerAccountId: "account_admin",
  ownerUsername: "admin",
  slug: "personal",
  title: "Personal Briefing",
  stars: 0,
  interestProfile:
    "Track Lebanese security, economy, infrastructure, public safety, and major regional events. Ignore routine political statements unless they change concrete facts.",
  styleInstruction: "Use calm, balanced wording.",
  publicFeedEnabled: true,
  paused: false,
  language: "en",
  retentionDays: 15
};

export const demoMessages: NormalizedMessage[] = [
  {
    id: "msg_1",
    source: { id: "src_lb_1", title: "Beirut Local", type: "channel", username: "beirutlocal" },
    messageId: "101",
    text: "Electricite du Liban said power supply will increase by two hours tonight after fuel shipments arrived.",
    links: ["https://example.test/power"],
    media: [],
    postedAt: "2026-06-16T08:00:00.000Z",
    receivedAt: "2026-06-16T08:00:10.000Z",
    sourceUrl: "https://t.me/beirutlocal/101",
    expiresAt: "2026-07-01T08:00:00.000Z"
  },
  {
    id: "msg_2",
    source: { id: "src_lb_2", title: "North Updates", type: "channel", username: "northupdates" },
    messageId: "88",
    text: "BREAKING: Electricite du Liban confirms two additional hours of power supply tonight.",
    links: [],
    media: [],
    postedAt: "2026-06-16T08:02:00.000Z",
    receivedAt: "2026-06-16T08:02:05.000Z",
    sourceUrl: "https://t.me/northupdates/88",
    expiresAt: "2026-07-01T08:02:00.000Z"
  },
  {
    id: "msg_3",
    source: { id: "src_noise", title: "Political Clips", type: "channel", username: "politicalclips" },
    messageId: "33",
    text: "A politician condemned the situation and called for unity.",
    links: [],
    media: [],
    postedAt: "2026-06-16T08:05:00.000Z",
    receivedAt: "2026-06-16T08:05:01.000Z",
    sourceUrl: "https://t.me/politicalclips/33",
    expiresAt: "2026-07-01T08:05:00.000Z"
  },
  {
    id: "msg_4",
    source: { id: "src_world", title: "World Wire", type: "channel", username: "worldwire" },
    messageId: "200",
    text: "A football club announced a new assistant coach before the next season.",
    links: [],
    media: [{ type: "photo", url: "https://example.test/coach.jpg", label: "press photo" }],
    postedAt: "2026-06-16T08:07:00.000Z",
    receivedAt: "2026-06-16T08:07:10.000Z",
    sourceUrl: "https://t.me/worldwire/200",
    expiresAt: "2026-07-01T08:07:00.000Z"
  }
];
