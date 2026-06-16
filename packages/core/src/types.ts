export type SourceType = "channel" | "group";
export type BriefingLanguage = "en" | "ar" | "fr";

export interface BriefingConfig {
  id: string;
  ownerAccountId: string;
  ownerUsername: string;
  slug: string;
  title: string;
  stars: number;
  interestProfile: string;
  styleInstruction?: string;
  publicFeedEnabled: boolean;
  paused: boolean;
  language: BriefingLanguage;
  retentionDays: number;
}

export interface MessageSource {
  id: string;
  title: string;
  type: SourceType;
  username?: string;
}

export interface MediaReference {
  type: "photo" | "video" | "document" | "animation" | "audio" | "voice" | "unknown";
  fileId?: string;
  url?: string;
  label?: string;
}

export interface NormalizedMessage {
  id: string;
  source: MessageSource;
  messageId: string;
  text: string;
  links: string[];
  media: MediaReference[];
  postedAt: string;
  receivedAt: string;
  sourceUrl?: string;
  rawPayloadKey?: string;
  expiresAt: string;
}

export interface BriefingEvidence {
  messageId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: SourceType;
  sourceUrl?: string;
  postedAt: string;
  text: string;
  links: string[];
  media: MediaReference[];
}

export interface BriefingItem {
  id: string;
  clusterId: string;
  summary: string;
  itemAt: string;
  updatedAt: string;
  expiresAt: string;
  mergedUpdateCount: number;
  evidence: BriefingEvidence[];
}

export interface SuppressedMessage {
  messageId: string;
  reason:
    | "empty"
    | "duplicate"
    | "not_relevant"
    | "rumor"
    | "fluff"
    | "non_authoritative_prediction"
    | "political_statement_without_new_facts"
    | "repeated_update";
  detail: string;
}

export interface ClusterCandidate {
  id: string;
  messages: NormalizedMessage[];
  tokens: string[];
}

export interface ProcessingInput {
  briefing: BriefingConfig;
  messages: NormalizedMessage[];
  existingItems?: BriefingItem[];
  now?: Date;
}

export interface ProcessingResult {
  publishedItems: BriefingItem[];
  suppressed: SuppressedMessage[];
}

export interface SummaryInput {
  briefing: BriefingConfig;
  evidence: BriefingEvidence[];
}

export interface SummaryAdapter {
  summarize(input: SummaryInput): Promise<string>;
}
