import {
  buildBriefingEdition,
  getDueBriefingWindow,
  sanitizeSummary,
  sectionSummaryMatchesFeedLanguage,
  selectEditionReferenceSections,
  synthesizeEditionNarrativeSummary,
  type BriefingConfig,
  type BriefingEdition,
  type SummaryAdapter
} from "@distilled/core";
import type { Repository } from "./types";

const MAX_WINDOW_MESSAGES = 500;

export async function publishDueBriefingEditions(input: {
  repo: Repository;
  briefings: BriefingConfig[];
  now?: Date;
  summaryAdapter?: SummaryAdapter | null;
}): Promise<number> {
  const now = input.now ?? new Date();
  let published = 0;

  for (const briefing of input.briefings) {
    if (briefing.paused) continue;
    const window = getDueBriefingWindow(briefing, now);
    if (!window) continue;

    const messages = await input.repo.listRawMessagesForWindow(
      briefing.id,
      window.windowStart,
      window.windowEnd,
      MAX_WINDOW_MESSAGES
    );
    const edition = await localizeEdition(
      buildBriefingEdition({
        briefing,
        messages,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        now
      }),
      briefing,
      input.summaryAdapter
    );
    await input.repo.upsertBriefing({ ...briefing, nextBriefingAt: window.nextBriefingAt }, now);
    if (edition.status !== "published") continue;

    await input.repo.saveBriefingEdition(edition, now);
    published += 1;
  }

  return published;
}

async function localizeEdition(
  edition: BriefingEdition,
  briefing: BriefingConfig,
  summaryAdapter?: SummaryAdapter | null
): Promise<BriefingEdition> {
  if (edition.status !== "published") return edition;

  const sections: BriefingEdition["sections"] = [];
  for (const section of edition.sections) {
    if (section.evidence.length === 0) {
      sections.push(section);
      continue;
    }

    if (!shouldLocalizeSectionSummary(section.summary, briefing.language)) {
      if (sectionSummaryMatchesFeedLanguage(section.summary, briefing.language)) {
        sections.push(section);
      }
      continue;
    }

    if (summaryAdapter) {
      try {
        const summary = sanitizeSummary(await summaryAdapter.summarize({ briefing, evidence: section.evidence }));
        if (summary && sectionSummaryMatchesFeedLanguage(summary, briefing.language)) {
          sections.push({ ...section, summary });
          continue;
        }
      } catch {
        // Wrong-language generated text is omitted from public synthesis when localization is unavailable.
      }
    }
  }

  const publicSections = selectEditionReferenceSections(sections, edition.cadence, briefing.language, { strictLanguage: true });
  const normalizedStatus = publicSections.length > 0 ? edition.status : "empty";
  return {
    ...edition,
    sections: publicSections,
    summary: synthesizeEditionNarrativeSummary(publicSections, edition.cadence, briefing.language),
    status: normalizedStatus
  };
}

function shouldLocalizeSectionSummary(summary: string, language: BriefingConfig["language"]): boolean {
  const hasArabic = /[\u0600-\u06FF]/u.test(summary);
  const hasLatin = /[A-Za-z]/.test(summary);
  if (language === "ar") return !hasArabic && hasLatin;
  if (language === "en") return hasArabic && !hasLatin;
  if (language === "fr") return hasArabic && !hasLatin;
  return false;
}
