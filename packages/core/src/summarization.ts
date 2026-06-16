import type { BriefingConfig, BriefingEvidence, SummaryAdapter, SummaryInput } from "./types";
import { firstSentence, normalizeText } from "./text";

const INVALID_SUMMARY_PATTERNS = [
  /\bno new verified information\b/i,
  /\bnothing new to report\b/i,
  /\bno new updates?\b/i,
  /\bprovided evidence\b/i,
  /\bas an ai\b/i,
  /\bi (do not|don't) have enough information\b/i,
  /\bnot enough information\b/i,
  /\bunable to (determine|verify|summari[sz]e)\b/i,
  /\bcannot (determine|verify|summari[sz]e)\b/i,
  /\btoday'?s lownoise\.?\s*news briefing\b/i,
  /\binclude in (today'?s|the) lownoise\.?\s*news briefing\b/i
];

export class DeterministicSummaryAdapter implements SummaryAdapter {
  async summarize(input: SummaryInput): Promise<string> {
    return createEvidenceOnlySummary(input.briefing, input.evidence);
  }
}

export function createEvidenceOnlySummary(
  _briefing: BriefingConfig,
  evidence: BriefingEvidence[]
): string {
  const primary = evidence[0];
  if (!primary) return "";

  const sentence = firstSentence(primary.text);
  return sanitizeSummary(sentence);
}

export function buildSummaryPrompt(input: SummaryInput): string {
  const evidenceLines = uniqueEvidenceForSummary(input.evidence)
    .map((item, index) => {
      return `${index + 1}. ${item.sourceTitle} at ${item.postedAt}: ${item.text}`;
    })
    .join("\n");

  const summaryLanguage =
    input.briefing.language === "ar"
      ? "Arabic"
      : input.briefing.language === "fr"
        ? "French"
        : "English";

  return [
    "You write LowNoise.news briefing items.",
    "Use only the evidence below.",
    "Use balanced wording.",
    "Do not add political framing labels unless the user's instruction explicitly asks for them.",
    "Do not answer questions or speculate.",
    `Write the summary in ${summaryLanguage}.`,
    `Interest profile: ${input.briefing.interestProfile}`,
    input.briefing.styleInstruction ? `Style instruction: ${input.briefing.styleInstruction}` : "",
    "Evidence:",
    evidenceLines
  ]
    .filter(Boolean)
    .join("\n");
}

export function sanitizeSummary(summary: string): string {
  const cleaned = summary.replace(/\bBREAKING:?\s*/gi, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (isArtifactSummary(cleaned)) return "";

  const uniqueSentences: string[] = [];
  const seen = new Set<string>();
  const sentences = cleaned.match(/[^.!?]+[.!?]?/g) ?? [cleaned];

  for (const sentence of sentences.map((entry) => entry.trim()).filter(Boolean)) {
    const key = normalizeText(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueSentences.push(sentence);
  }

  return uniqueSentences.join(" ").trim();
}

export function isArtifactSummary(summary: string): boolean {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return true;
  return INVALID_SUMMARY_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function uniqueEvidenceForSummary(evidence: BriefingEvidence[]): BriefingEvidence[] {
  const seen = new Set<string>();
  const unique: BriefingEvidence[] = [];

  for (const item of evidence) {
    const key = normalizeText(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique.length > 0 ? unique : evidence;
}
