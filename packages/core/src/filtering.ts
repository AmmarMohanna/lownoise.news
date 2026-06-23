import type { BriefingConfig, NormalizedMessage, SuppressedMessage } from "./types";
import { eventTokens, jaccardSimilarity, normalizeEventText, normalizeText, significantTokens } from "./text";

const RUMOR_PATTERNS = [
  /\brumou?rs?\b/i,
  /\bunconfirmed\b/i,
  /\breportedly\b/i,
  /\bsources claim\b/i,
  /\bnot verified\b/i
];

const PREDICTION_PATTERNS = [
  /\bi think\b/i,
  /\bwhat if\b/i,
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
  /\b(percent|%|usd|dollar|lira|euro|km|people|soldiers|civilians|hours|minutes)\b/i,
  /(?:أعلن|اعلن|أكد|اكد|أفاد|افاد|وقّع|وقع|سيوقع|قتل|استشهد|أصيب|اصيب|جرح|اعتقل|أقر|اقر|وافق|افتتح|أغلق|اغلق|استهدف|قصف|غارة|غاره|انفجار|انسحب|انسحاب|بدأ|بدا|استأنف|استانف|قطع|أوقف|اوقف|علّق|علق|أطلق|اطلق|إطلاق|اطلاق|ألقى|القى|تلقي|قنبلة|مسيّرة|مسيرة|جريح|جريحين|جريحان|جرحى|قتيل|قتلى)/u
];

const IMPORTANT_PATTERNS = [
  /\b(minister|official|government|army|police|court|central bank|reuters|associated press|ap news|afp)\b/i,
  /\b(killed|injured|casualties|strike|missile|explosion|evacuated|closed|halted|resumed|cut all contact|sanction|approved|signed|announced)\b/i,
  /\b(currency|central bank|lira|dollar|euro|inflation|fuel|electricity|power|water|airport|port|border)\b/i,
  /(?:وزير|مسؤول|الحكومة|الجيش|الشرطة|قوى الامن|مصرف لبنان|رويترز|فرانس برس)/u,
  /(?:قتل|قتيل|قتلى|استشهد|شهيد|شهداء|جرح|جريح|جرحى|أصيب|اصيب|غارة|قصف|انفجار|إخلاء|اخلاء|اغلاق|أغلق|قطع|عقوبات|وقّع|وقع|أعلن|اعلن|أكد|اكد|استهداف|قنبلة|مسيّرة|مسيرة|انسحاب)/u,
  /(?:كهرباء|مياه|مطار|مرفأ|حدود|دولار|ليرة|مصرف|وقود)/u
];

const FLUFF_PATTERNS = [
  /\bbreaking\b/i,
  /\bstay tuned\b/i,
  /\bwatch now\b/i,
  /\byou won't believe\b/i,
  /\bshocking\b/i,
  /\bmust watch\b/i,
  /آخر تصريحات/u,
  /شاهد(?:وا)?/u,
  /للمزيد/u,
  /للتفاصيل/u,
  /التفاصيل/u
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
    lebanese: ["lebanon", "liban", "beirut", "south", "لبنان", "لبناني", "بيروت", "الجنوب", "جنوب", "النبطية", "صيدا", "صور", "طرابلس", "بعلبك"],
    lebanon: ["lebanese", "liban", "beirut", "south", "لبنان", "لبناني", "بيروت", "الجنوب", "جنوب", "النبطية", "صيدا", "صور", "طرابلس", "بعلبك"],
    liban: ["lebanon", "lebanese", "لبنان", "لبناني", "بيروت", "الجنوب", "النبطية"],
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
    لبنان: ["lebanon", "lebanese", "liban", "beirut", "south", "لبناني", "بيروت", "الجنوب", "جنوب", "النبطية", "صيدا", "صور", "طرابلس", "بعلبك"],
    لبناني: ["lebanon", "lebanese", "لبنان", "بيروت", "الجنوب", "النبطية"],
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

  const concreteFact = hasConcreteFact(text);

  if (FLUFF_PATTERNS.some((pattern) => pattern.test(text)) && text.length < 180 && (!concreteFact || isDanglingDetailsTeaser(text))) {
    return {
      messageId: message.id,
      reason: "fluff",
      detail: "Message looks like engagement-oriented filler."
    };
  }

  const hasPrediction = PREDICTION_PATTERNS.some((pattern) => pattern.test(text));
  const authoritySignal = hasAuthoritySignal(text);
  if (hasPrediction && !authoritySignal) {
    return {
      messageId: message.id,
      reason: "non_authoritative_prediction",
      detail: "Prediction is not tied to an authoritative source."
    };
  }

  const politicalSpeech = POLITICAL_SPEECH_PATTERNS.some((pattern) => pattern.test(text));
  if (politicalSpeech && !concreteFact) {
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

function isDanglingDetailsTeaser(text: string): boolean {
  return /(?:إذا|اذا|لو|هل|ماذا|لماذا|كيف|[.؟?]{2,}|…|\|).{0,100}(?:للتفاصيل|للمزيد)/u.test(text);
}

export function hasConcreteFact(text: string): boolean {
  return FACT_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasAuthoritySignal(text: string): boolean {
  return /\bminister|agency|central bank|army|police|court|company|official|government|reuters|associated press|ap news|afp\b/i.test(text) ||
    /(?:وزير|وكالة|مصرف لبنان|الجيش|الشرطة|قوى الامن|محكمة|شركة|مسؤول|الحكومة|رويترز|فرانس برس)/u.test(text);
}

export function hasImportantSignal(text: string): boolean {
  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isImportantToInterest(message: NormalizedMessage, briefing: BriefingConfig): boolean {
  if (!hasConcreteFact(message.text) || !hasImportantSignal(message.text)) return false;
  return isRelevantToInterest(message, briefing) || interestOverlap(message.text, briefing.interestProfile) > 0;
}

export function isImportantReviewCandidate(message: NormalizedMessage, briefing: BriefingConfig): boolean {
  if (!hasConcreteFact(message.text) && !hasImportantSignal(message.text)) return false;
  return isRelevantToInterest(message, briefing) || interestOverlap(message.text, briefing.interestProfile) > 0;
}

export function findDuplicate(
  message: NormalizedMessage,
  acceptedMessages: NormalizedMessage[]
): NormalizedMessage | undefined {
  const normalized = normalizeText(message.text);
  if (!normalized) return undefined;
  const eventNormalized = normalizeEventText(message.text);
  const tokens = eventTokens(message.text);

  return acceptedMessages.find((candidate) => {
    if (normalizeText(candidate.text) === normalized) return true;
    if (normalizeEventText(candidate.text) === eventNormalized) return true;
    const similarity = Math.max(
      jaccardSimilarity(significantTokens(candidate.text), significantTokens(message.text)),
      jaccardSimilarity(eventTokens(candidate.text), tokens)
    );
    return similarity >= 0.92;
  });
}

function interestOverlap(text: string, interestProfile: string): number {
  const profileTokens = expandInterestTokens(significantTokens(interestProfile));
  if (profileTokens.length === 0) return 1;
  const messageTokens = new Set(expandInterestTokens(significantTokens(text)));
  return profileTokens.filter((token) => messageTokens.has(token)).length;
}
