import type { BriefingConfig, BriefingItem } from "@lownoise/core";

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

export interface TelegramSourceRecord {
  id: string;
  briefingId: string;
  title: string;
  type: "channel" | "group";
  username?: string;
  url?: string;
  enabled: boolean;
  lastSeenAt: string;
}

export interface HealthStatus {
  lastTelegramEventAt?: string;
  latestPublishedAt?: string;
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

export interface FeedPayload {
  briefing: Omit<BriefingConfig, "interestProfile" | "styleInstruction">;
  items: BriefingItem[];
  viewerHasStarred: boolean;
}
