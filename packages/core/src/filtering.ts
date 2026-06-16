import type { BriefingConfig, NormalizedMessage, SuppressedMessage } from "./types";
import { jaccardSimilarity, normalizeText, significantTokens } from "./text";

const RUMOR_PATTERNS = [
  /\brumou?rs?\b/i,
  /\bunconfirmed\b/i,
  /\breportedly\b/i,
  /\bsources claim\b/i,
  /\bnot verified\b/i
];

const PREDICTION_PATTERNS = [
  /\bi think\b/i,
  /\bwill probably\b/i,
  /\bcould happen\b/i,
  /\bmay happen\b/i,
  /\bmy prediction\b/i,
  /\bexpected to\b/i
];

const POLITICAL_SPEECH_PATTERNS = [
  /\bsaid\b/i,
  /\bstated\b/i,
  /\bdeclared\b/i,
  /\bcalled for\b/i,
  /\bcondemned\b/i,
  /\bwarned\b/i
];

const FACT_PATTERNS = [
  /\b(deploy|deployed|strike|strikes|hit|killed|injured|arrested|closed|opened|approved|signed|launched|resumed|halted|evacuated|entered|left|announced)\b/i,
  /\b\d+([.,]\d+)?\b/,
  /\b(percent|%|usd|dollar|lira|euro|km|people|soldiers|civilians|hours|minutes)\b/i
];

const FLUFF_PATTERNS = [
  /\bbreaking\b/i,
  /\bstay tuned\b/i,
  /\bwatch now\b/i,
  /\byou won't believe\b/i,
  /\bshocking\b/i,
  /\bmust watch\b/i
];

const NO_UPDATE_PATTERNS = [
  /\bno new (developments?|updates?)\b/i,
  /\bno new verified information\b/i,
  /\bnothing new to report\b/i,
  /\bno major regional events\b/i
];

export function isRelevantToInterest(message: NormalizedMessage, briefing: BriefingConfig): boolean {
  const profileTokens = expandInterestTokens(significantTokens(briefing.interestProfile));
  if (profileTokens.length === 0) return true;

  const messageTokens = expandInterestTokens(significantTokens(message.text));
  const overlap = profileTokens.filter((token) => messageTokens.includes(token));

  if (overlap.length > 0) return true;

  const profile = normalizeText(briefing.interestProfile);
  const text = normalizeText(message.text);

  return profileTokens.some((token) => text.includes(token)) || text.includes(profile);
}

function expandInterestTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  const synonyms: Record<string, string[]> = {
    lebanese: ["lebanon", "liban", "beirut", "لبنان", "لبناني", "بيروت"],
    lebanon: ["lebanese", "liban", "beirut", "لبنان", "لبناني", "بيروت"],
    liban: ["lebanon", "lebanese", "لبنان", "لبناني"],
    beirut: ["lebanon", "lebanese", "بيروت", "لبنان"],
    economy: ["economic", "currency", "bank", "lira", "dollar", "economy", "اقتصاد", "اقتصادي", "عملة", "بنك", "مصرف", "ليرة", "دولار", "نفط", "برنت"],
    infrastructure: [
      "power",
      "electricity",
      "water",
      "internet",
      "road",
      "airport",
      "port",
      "كهرباء",
      "مياه",
      "انترنت",
      "طريق",
      "أوتوستراد",
      "بنية",
      "تحتية",
      "مطار",
      "مرفأ"
    ],
    security: [
      "army",
      "border",
      "strike",
      "safety",
      "incident",
      "security",
      "أمن",
      "أمني",
      "الجيش",
      "حدود",
      "غارة",
      "ضربة",
      "حادث",
      "تصادم",
      "جريح",
      "جريحان",
      "قتيل",
      "قتلى",
      "إصابة"
    ],
    public: ["public", "civil", "مدني", "عام", "عامة"],
    safety: ["safety", "incident", "accident", "injury", "أمن", "سلامة", "حادث", "تصادم", "إصابة", "جريح", "جريحان"],
    regional: ["regional", "region", "middleeast", "iran", "syria", "israel", "إقليمي", "المنطقة", "إيران", "إيراني", "سوريا", "إسرائيل", "أميركي", "الولايات"],
    events: ["event", "events", "developments", "تطور", "تطورات", "حدث", "أحداث"],
    لبنان: ["lebanon", "lebanese", "liban", "beirut", "لبناني", "بيروت"],
    لبناني: ["lebanon", "lebanese", "لبنان", "بيروت"],
    بيروت: ["beirut", "lebanon", "lebanese", "لبنان"],
    اقتصاد: ["economy", "economic", "currency", "bank", "lira", "dollar", "اقتصادي", "عملة", "بنك", "مصرف", "ليرة", "دولار"],
    أمني: ["security", "safety", "incident", "army", "border", "أمن", "الجيش", "حادث", "غارة", "ضربة"],
    أمن: ["security", "safety", "incident", "army", "border", "أمني", "الجيش", "حادث", "غارة", "ضربة"],
    بنية: ["infrastructure", "power", "electricity", "water", "internet", "road", "airport", "port", "تحتية", "كهرباء", "مياه", "طريق", "مطار", "مرفأ"],
    تحتية: ["infrastructure", "power", "electricity", "water", "internet", "road", "airport", "port", "بنية", "كهرباء", "مياه", "طريق", "مطار", "مرفأ"],
    إقليمي: ["regional", "region", "middleeast", "iran", "syria", "israel", "المنطقة", "إيران", "إيراني", "سوريا", "إسرائيل", "أميركي"]
  };

  for (const token of tokens) {
    for (const synonym of synonyms[token] ?? []) {
      expanded.add(synonym);
    }
  }

  return Array.from(expanded);
}

export function classifyNoise(message: NormalizedMessage): SuppressedMessage | null {
  const text = message.text.trim();
  if (!text) {
    return {
      messageId: message.id,
      reason: "empty",
      detail: "Message has no supported text or caption."
    };
  }

  if (RUMOR_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      messageId: message.id,
      reason: "rumor",
      detail: "Message appears to be unverified or rumor-based."
    };
  }

  const hasConcreteFact = FACT_PATTERNS.some((pattern) => pattern.test(text));

  if (FLUFF_PATTERNS.some((pattern) => pattern.test(text)) && text.length < 180 && !hasConcreteFact) {
    return {
      messageId: message.id,
      reason: "fluff",
      detail: "Message looks like engagement-oriented filler."
    };
  }

  const hasPrediction = PREDICTION_PATTERNS.some((pattern) => pattern.test(text));
  const hasAuthoritySignal = /\bminister|agency|central bank|army|police|court|company|official|government\b/i.test(text);
  if (hasPrediction && !hasAuthoritySignal) {
    return {
      messageId: message.id,
      reason: "non_authoritative_prediction",
      detail: "Prediction is not tied to an authoritative source."
    };
  }

  const politicalSpeech = POLITICAL_SPEECH_PATTERNS.some((pattern) => pattern.test(text));
  if (politicalSpeech && !hasConcreteFact) {
    return {
      messageId: message.id,
      reason: "political_statement_without_new_facts",
      detail: "Statement does not add concrete facts."
    };
  }

  if (NO_UPDATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      messageId: message.id,
      reason: "repeated_update",
      detail: "Message says there is no meaningful new development."
    };
  }

  return null;
}

export function findDuplicate(
  message: NormalizedMessage,
  acceptedMessages: NormalizedMessage[]
): NormalizedMessage | undefined {
  const normalized = normalizeText(message.text);
  if (!normalized) return undefined;

  return acceptedMessages.find((candidate) => {
    if (normalizeText(candidate.text) === normalized) return true;
    const similarity = jaccardSimilarity(significantTokens(candidate.text), significantTokens(message.text));
    return similarity >= 0.92;
  });
}
