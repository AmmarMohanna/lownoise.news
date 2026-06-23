import { cadenceLabel } from "./cadence";
import { processMessages } from "./processing";
import { sanitizeEvidenceText, sanitizeSummary } from "./summarization";
import { firstSentence, normalizeText } from "./text";
import type {
  BriefingEvidence,
  BriefingConfig,
  BriefingEdition,
  BriefingEditionSection,
  BriefingItem,
  NormalizedMessage
} from "./types";

export interface BuildBriefingEditionInput {
  briefing: BriefingConfig;
  messages: NormalizedMessage[];
  windowStart: string;
  windowEnd: string;
  now: Date;
}

const REFERENCE_LIMITS: Record<BriefingConfig["briefingCadence"], number> = {
  hourly: 6,
  daily: 8,
  weekly: 10,
  monthly: 10
};

const SUMMARY_WORD_LIMITS: Record<BriefingConfig["briefingCadence"], number> = {
  hourly: 150,
  daily: 220,
  weekly: 280,
  monthly: 320
};

export function buildBriefingEdition(input: BuildBriefingEditionInput): BriefingEdition {
  const result = processMessages({
    briefing: input.briefing,
    messages: input.messages,
    existingItems: [],
    now: input.now
  });
  const items = result.publishedItems.filter((item) => item.summary);
  const sections = items.length > 0
    ? selectEditionReferenceSections(
        items.map((item) => itemToSection(item, input.briefing.language)),
        input.briefing.briefingCadence,
        input.briefing.language
      )
    : [emptySection(input.briefing.briefingCadence, input.briefing.language)];
  const status = items.length > 0 ? "published" : "empty";
  const title = editionTitle(input.briefing.briefingCadence, input.briefing.language);
  const summary = items.length > 0
    ? synthesizeEditionNarrativeSummary(sections, input.briefing.briefingCadence, input.briefing.language)
    : editionSummary(0, input.briefing.briefingCadence, input.briefing.language);
  const timestamp = input.now.toISOString();

  return {
    id: editionId(input.briefing.id, input.briefing.briefingCadence, input.windowStart, input.windowEnd),
    briefingId: input.briefing.id,
    cadence: input.briefing.briefingCadence,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    title,
    summary,
    sections,
    status,
    publishedAt: input.windowEnd,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function searchBriefingEditions(editions: BriefingEdition[], query: string): BriefingEdition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return editions.filter((edition) => editionHaystack(edition).includes(normalized));
}

function itemToSection(item: BriefingItem, language: BriefingConfig["language"]): BriefingEditionSection {
  return {
    title: sectionTitle(item, language),
    summary: sanitizeSummary(item.summary, language),
    evidence: item.evidence.map((entry) => sanitizeEvidenceForLanguage(entry, language))
  };
}

function emptySection(
  cadence: BriefingConfig["briefingCadence"],
  language: BriefingConfig["language"]
): BriefingEditionSection {
  return {
    title: localizedNoUpdateTitle(language),
    summary: editionSummary(0, cadence, language),
    evidence: []
  };
}

export function synthesizeEditionNarrativeSummary(
  sections: BriefingEditionSection[],
  cadence: BriefingConfig["briefingCadence"],
  language: BriefingConfig["language"]
): string {
  const referencedSections = selectEditionReferenceSections(sections, cadence, language);
  const referencedUpdates = referencedSections
    .map((section, index) => referenceSentence(sanitizeEvidenceText(section.summary, language), index + 1))
    .filter(Boolean);

  if (referencedUpdates.length === 0) return editionSummary(0, cadence, language);

  let summary: string;
  if (language === "ar") {
    const [first, ...rest] = referencedUpdates;
    summary = [
      `${arabicNarrativeIntro(cadence)} ${first}.`,
      ...rest.map((update, index) => `${arabicNarrativeConnector(index)} ${update}.`)
    ].join(" ");
    return trimSummaryToCadenceLimit(summary, cadence);
  }

  if (language === "fr") {
    const [first, ...rest] = referencedUpdates;
    summary = [
      `${frenchNarrativeIntro(cadence)} ${first}.`,
      ...rest.map((update, index) => `${frenchNarrativeConnector(index)} ${update}.`)
    ].join(" ");
    return trimSummaryToCadenceLimit(summary, cadence);
  }

  const [first, ...rest] = referencedUpdates;
  summary = [
    `${englishNarrativeIntro(cadence)} ${first}.`,
    ...rest.map((update, index) => `${englishNarrativeConnector(index)} ${lowerLeadingEnglishArticle(update)}.`)
  ].join(" ");
  return trimSummaryToCadenceLimit(summary, cadence);
}

export function selectEditionReferenceSections(
  sections: BriefingEditionSection[],
  cadence: BriefingConfig["briefingCadence"],
  language: BriefingConfig["language"],
  options: { strictLanguage?: boolean } = {}
): BriefingEditionSection[] {
  const referenceLimit = REFERENCE_LIMITS[cadence] ?? REFERENCE_LIMITS.hourly;
  return sections
    .filter((section) => section.summary.trim())
    .filter((section) => !options.strictLanguage || sectionSummaryMatchesFeedLanguage(section.summary, language))
    .slice(0, referenceLimit);
}

export function sectionSummaryMatchesFeedLanguage(summary: string, language: BriefingConfig["language"]): boolean {
  const hasArabic = /[\u0600-\u06FF]/u.test(summary);
  const hasLatin = /[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(summary);
  if (!summary.trim()) return false;
  if (language === "ar") return hasArabic;
  if (language === "en" || language === "fr") return hasLatin || !hasArabic;
  return true;
}

export function sanitizeEditionSectionForLanguage(
  section: BriefingEditionSection,
  language: BriefingConfig["language"]
): BriefingEditionSection {
  const evidence = section.evidence.map((entry) => sanitizeEvidenceForLanguage(entry, language));
  const summary = repairTruncatedSectionSummary(sanitizeEvidenceText(section.summary, language), evidence, language);
  return {
    ...section,
    summary,
    evidence
  };
}

function sanitizeEvidenceForLanguage(
  evidence: BriefingEvidence,
  language: BriefingConfig["language"]
): BriefingEvidence {
  return {
    ...evidence,
    text: sanitizeEvidenceText(evidence.text, language)
  };
}

function repairTruncatedSectionSummary(
  summary: string,
  evidence: BriefingEvidence[],
  language: BriefingConfig["language"]
): string {
  if (!summary || /[.!?؟]$/u.test(summary)) return summary;
  if ([...summary].length < 200) return summary;
  const normalizedSummary = normalizeText(summary);
  if (!normalizedSummary) return summary;

  const source = evidence.find((entry) => {
    const normalizedEvidence = normalizeText(entry.text);
    return normalizedEvidence.length > normalizedSummary.length && normalizedEvidence.startsWith(normalizedSummary);
  });
  if (!source) return summary;

  const repaired = sanitizeSummary(firstSentence(source.text), language);
  return repaired.length > summary.length ? repaired : summary;
}

function referenceSentence(summary: string, referenceNumber: number): string {
  const cleaned = summary
    .replace(/\s*\[\d+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!؟?]+$/u, "");
  return cleaned ? `${cleaned} [${referenceNumber}]` : "";
}

function trimSummaryToCadenceLimit(summary: string, cadence: BriefingConfig["briefingCadence"]): string {
  const wordLimit = SUMMARY_WORD_LIMITS[cadence] ?? SUMMARY_WORD_LIMITS.hourly;
  if (wordCount(summary) <= wordLimit) return summary;

  const completeSentences = summary.match(/[^.!؟?]+[.!؟?]+/gu) ?? [];
  const kept: string[] = [];
  for (const sentence of completeSentences) {
    const candidate = [...kept, sentence.trim()].join(" ");
    if (wordCount(candidate) > wordLimit) break;
    kept.push(sentence.trim());
  }
  if (kept.length > 0) return kept.join(" ");

  const words = summary.trim().split(/\s+/u);
  return `${words.slice(0, wordLimit).join(" ").replace(/[,:;،]+$/u, "")}.`;
}

function wordCount(value: string): number {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.length;
}

function sectionTitle(item: BriefingItem, language: BriefingConfig["language"]): string {
  const evidenceText = item.evidence.map((entry) => `${entry.sourceTitle} ${entry.text}`).join(" ").toLowerCase();
  if (/\b(bank|currency|economy|market|inflation|lira|dollar|fuel|مصرف|دولار|ليرة)\b/.test(evidenceText)) return localizedSectionTitle("economy", language);
  if (/\b(power|electricity|water|internet|road|airport|port|كهرباء|مياه|مطار|مرفأ)\b/.test(evidenceText)) return localizedSectionTitle("infrastructure", language);
  if (/\b(strike|missile|army|border|killed|injured|security|غارة|قصف|الجيش|حدود|قتيل|جريح)\b/.test(evidenceText)) return localizedSectionTitle("security", language);
  return localizedSectionTitle("update", language);
}

function editionHaystack(edition: BriefingEdition): string {
  return [
    edition.title,
    edition.summary,
    ...edition.sections.flatMap((section) => [
      section.title,
      section.summary,
      ...section.evidence.flatMap((evidence) => [
        evidence.sourceTitle,
        evidence.text,
        evidence.links.join(" "),
        evidence.media.map((media) => media.label ?? media.url ?? "").join(" ")
      ])
    ])
  ].join(" ").toLowerCase();
}

function editionId(briefingId: string, cadence: string, windowStart: string, windowEnd: string): string {
  return `edition_${stableHash(`${briefingId}:${cadence}:${windowStart}:${windowEnd}`)}`;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function editionTitle(cadence: BriefingConfig["briefingCadence"], language: BriefingConfig["language"]): string {
  if (language === "ar") {
    if (cadence === "daily") return "الموجز اليومي";
    if (cadence === "weekly") return "الموجز الأسبوعي";
    if (cadence === "monthly") return "الموجز الشهري";
    return "تحديثات موثوقة";
  }
  if (language === "fr") {
    if (cadence === "daily") return "Brief quotidien";
    if (cadence === "weekly") return "Brief hebdomadaire";
    if (cadence === "monthly") return "Brief mensuel";
    return "Mises à jour vérifiées";
  }
  if (cadence === "hourly") return "Verified updates";
  return `${capitalize(cadenceLabel(cadence))} brief`;
}

function editionSummary(
  itemCount: number,
  cadence: BriefingConfig["briefingCadence"],
  language: BriefingConfig["language"]
): string {
  const label = cadenceLabel(cadence);
  if (language === "ar") {
    if (itemCount === 0) return cadence === "hourly" ? "لا توجد تحديثات موثوقة في هذه النافذة." : `لا توجد تحديثات موثوقة في ${arabicCadencePhrase(cadence)}.`;
    if (itemCount === 1) return cadence === "hourly" ? "تحديث موثوق واحد." : `تحديث واحد في ${arabicCadencePhrase(cadence)}.`;
    if (itemCount === 2) return cadence === "hourly" ? "تحديثان موثوقان." : `تحديثان في ${arabicCadencePhrase(cadence)}.`;
    return cadence === "hourly" ? `${itemCount} تحديثات موثوقة.` : `${itemCount} تحديثات في ${arabicCadencePhrase(cadence)}.`;
  }
  if (language === "fr") {
    if (itemCount === 0) return cadence === "hourly" ? "Aucune mise à jour vérifiée dans cette fenêtre." : `Aucune mise à jour vérifiée dans ce brief ${frenchCadenceAdjective(cadence)}.`;
    return cadence === "hourly" ? `${itemCount} mise${itemCount === 1 ? "" : "s"} à jour vérifiée${itemCount === 1 ? "" : "s"}.` : `${itemCount} mise${itemCount === 1 ? "" : "s"} à jour dans ce brief ${frenchCadenceAdjective(cadence)}.`;
  }
  if (itemCount === 0) return cadence === "hourly" ? "No verified updates in this window." : `No verified updates in this ${label} brief.`;
  return cadence === "hourly" ? `${itemCount} verified update${itemCount === 1 ? "" : "s"}.` : `${itemCount} update${itemCount === 1 ? "" : "s"} in this ${label} brief.`;
}

function englishNarrativeIntro(cadence: BriefingConfig["briefingCadence"]): string {
  if (cadence === "hourly") return "Verified updates:";
  return `This ${cadenceLabel(cadence)} brief:`;
}

function englishNarrativeConnector(index: number): string {
  if (index === 0) return "Also,";
  if (index === 1) return "Separately,";
  return "It also notes";
}

function lowerLeadingEnglishArticle(update: string): string {
  return update.replace(/^(The|A|An)\s/u, (article) => article.toLowerCase());
}

function arabicNarrativeIntro(cadence: BriefingConfig["briefingCadence"]): string {
  if (cadence === "hourly") return "تحديثات موثوقة:";
  return `في ${arabicCadencePhrase(cadence)}:`;
}

function arabicNarrativeConnector(index: number): string {
  if (index === 0) return "كما ورد";
  if (index === 1) return "وبشكل منفصل،";
  return "ويشير الموجز أيضاً إلى";
}

function frenchNarrativeIntro(cadence: BriefingConfig["briefingCadence"]): string {
  if (cadence === "hourly") return "Mises à jour vérifiées :";
  return `Dans ce brief ${frenchCadenceAdjective(cadence)} :`;
}

function frenchNarrativeConnector(index: number): string {
  if (index === 0) return "Le brief note aussi";
  if (index === 1) return "Séparément,";
  return "Il relève également";
}

function localizedNoUpdateTitle(language: BriefingConfig["language"]): string {
  if (language === "ar") return "لا تحديثات";
  if (language === "fr") return "Aucune mise à jour";
  return "No updates";
}

function localizedSectionTitle(
  title: "economy" | "infrastructure" | "security" | "update",
  language: BriefingConfig["language"]
): string {
  if (language === "ar") {
    if (title === "economy") return "اقتصاد";
    if (title === "infrastructure") return "بنية تحتية";
    if (title === "security") return "أمن";
    return "تحديث";
  }
  if (language === "fr") {
    if (title === "economy") return "Économie";
    if (title === "infrastructure") return "Infrastructures";
    if (title === "security") return "Sécurité";
    return "Mise à jour";
  }
  if (title === "economy") return "Economy";
  if (title === "infrastructure") return "Infrastructure";
  if (title === "security") return "Security";
  return "Update";
}

function arabicCadencePhrase(cadence: BriefingConfig["briefingCadence"]): string {
  if (cadence === "daily") return "الموجز اليومي";
  if (cadence === "weekly") return "الموجز الأسبوعي";
  if (cadence === "monthly") return "الموجز الشهري";
  return "موجز الساعة";
}

function frenchCadenceAdjective(cadence: BriefingConfig["briefingCadence"]): string {
  if (cadence === "daily") return "quotidien";
  if (cadence === "weekly") return "hebdomadaire";
  if (cadence === "monthly") return "mensuel";
  return "horaire";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
