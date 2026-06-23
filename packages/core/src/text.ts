const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "in",
  "into",
  "is",
  "it",
  "its",
  "new",
  "no",
  "not",
  "of",
  "on",
  "or",
  "said",
  "says",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with"
]);

const EVENT_STOP_WORDS = new Set([
  ...STOP_WORDS,
  "breaking",
  "news",
  "update",
  "updates",
  "lbcinews",
  "lbci",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "january",
  "february",
  "march",
  "april",
  "may",
  "2024",
  "2025",
  "2026",
  "في",
  "من",
  "عن",
  "على",
  "علي",
  "الى",
  "إلى",
  "الي",
  "مع",
  "هذا",
  "هذه",
  "ذلك",
  "تلك",
  "كل",
  "جميع",
  "عبر",
  "بعد",
  "قبل",
  "خلال",
  "اليوم",
  "أمس",
  "غدا",
  "غداً"
]);

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const FIRST_SENTENCE_MAX_CHARS = 320;
const FIRST_SENTENCE_BOUNDARY_MAX_CHARS = 420;

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEventText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/#\p{L}[\p{L}\p{N}_-]*/gu, " ")
    .normalize("NFKD")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/(^|\s)(?:سوف\s+|سي|سأ|سا)(?=\p{L}{3,})/gu, "$1")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function significantTokens(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    )
  );
}

export function eventTokens(text: string): string[] {
  const normalized = normalizeEventText(text);
  if (!normalized) return [];

  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !EVENT_STOP_WORDS.has(token))
    )
  );
}

export function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const intersection = Array.from(a).filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const match = trimmed.match(new RegExp(`^(.{24,${FIRST_SENTENCE_BOUNDARY_MAX_CHARS}}?[.!?؟])(?:\\s|$)`, "u"));
  if (match) return match[1].trim();
  if (trimmed.length <= FIRST_SENTENCE_MAX_CHARS) return trimmed;
  return clipAtWordBoundary(trimmed, FIRST_SENTENCE_MAX_CHARS);
}

function clipAtWordBoundary(text: string, maxChars: number): string {
  const clipped = text.slice(0, maxChars).trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxChars * 0.65)) {
    return clipped.slice(0, lastSpace).replace(/[,:;،؛]+$/u, "").trim();
  }
  return clipped;
}

export function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
