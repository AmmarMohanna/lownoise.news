import type { BriefingConfig, BriefingEdition, SourceKind, SourceProvider } from "@distilled/core";

export type AccountRole = "admin" | "user";

export interface AccountRecord {
  id: string;
  email: string;
  username: string;
  role: AccountRole;
  emailVerifiedAt?: string;
  disabledAt?: string;
}

export interface AccountWithStats extends AccountRecord {
  briefingCount: number;
}

export interface SourceRecord {
  id: string;
  briefingId: string;
  title: string;
  type: "channel" | "group";
  provider: SourceProvider;
  kind: SourceKind;
  username?: string;
  input?: string;
  url?: string;
  sourceUrl?: string;
  actorId?: string;
  enabled: boolean;
  lastSeenAt: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface HealthStatus {
  lastSourceEventAt?: string;
  lastSourceFetchAt?: string;
  lastImportedMessageAt?: string;
  latestPublishedAt?: string;
  nextBriefingAt?: string;
  processing: {
    queued: number;
    completed: number;
    failed: number;
  };
}

export interface SessionStatus {
  authenticated: boolean;
  setupRequired: boolean;
  account?: AccountRecord;
  turnstileSiteKey?: string;
}

export type PublicBriefing = Omit<BriefingConfig, "interestProfile" | "styleInstruction">;

export interface FeedPayload {
  briefing: PublicBriefing;
  editions: BriefingEdition[];
  viewerHasStarred: boolean;
}
