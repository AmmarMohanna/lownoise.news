import { cadenceLabel } from "./cadence";
import { processMessages } from "./processing";
import type {
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

export function buildBriefingEdition(input: BuildBriefingEditionInput): BriefingEdition {
  const result = processMessages({
    briefing: input.briefing,
    messages: input.messages,
    existingItems: [],
    now: input.now
  });
  const items = result.publishedItems.filter((item) => item.summary);
  const sections = items.length > 0
    ? items.map((item) => itemToSection(item, input.briefing.language))
    : [emptySection(input.briefing.briefingCadence, input.briefing.language)];
  const status = items.length > 0 ? "published" : "empty";
  const title = editionTitle(input.briefing.briefingCadence, input.briefing.language);
  const summary = editionSummary(items.length, input.briefing.briefingCadence, input.briefing.language);
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
    summary: item.summary,
    evidence: item.evidence
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
    return "موجز الساعة";
  }
  if (language === "fr") {
    if (cadence === "daily") return "Brief quotidien";
    if (cadence === "weekly") return "Brief hebdomadaire";
    if (cadence === "monthly") return "Brief mensuel";
    return "Brief horaire";
  }
  return `${capitalize(cadenceLabel(cadence))} brief`;
}

function editionSummary(
  itemCount: number,
  cadence: BriefingConfig["briefingCadence"],
  language: BriefingConfig["language"]
): string {
  const label = cadenceLabel(cadence);
  if (language === "ar") {
    if (itemCount === 0) return `لا توجد تحديثات موثوقة في ${arabicCadencePhrase(cadence)}.`;
    if (itemCount === 1) return `تحديث واحد في ${arabicCadencePhrase(cadence)}.`;
    if (itemCount === 2) return `تحديثان في ${arabicCadencePhrase(cadence)}.`;
    return `${itemCount} تحديثات في ${arabicCadencePhrase(cadence)}.`;
  }
  if (language === "fr") {
    if (itemCount === 0) return `Aucune mise à jour vérifiée dans ce brief ${frenchCadenceAdjective(cadence)}.`;
    return `${itemCount} mise${itemCount === 1 ? "" : "s"} à jour dans ce brief ${frenchCadenceAdjective(cadence)}.`;
  }
  if (itemCount === 0) return `No verified updates in this ${label} brief.`;
  return `${itemCount} update${itemCount === 1 ? "" : "s"} in this ${label} brief.`;
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
