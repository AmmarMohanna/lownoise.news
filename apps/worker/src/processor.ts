import {
  areSameEventDeterministic,
  eventTokens,
  jaccardSimilarity,
  mergeBriefingItem,
  processMessages,
  sanitizeSummary,
  isImportantReviewCandidate,
  isImportantToInterest,
  type BriefingConfig,
  type BriefingItem,
  type EventReviewAdapter,
  type NormalizedMessage,
  type ProcessingResult,
  type SummaryAdapter
} from "@distilled/core";
import type { ProcessingJobMessage, Repository } from "./types";

const RECENT_MESSAGE_CONTEXT_LIMIT = 30;
const EXISTING_ITEM_CONTEXT_LIMIT = 80;

export async function processQueueMessage(
  repo: Repository,
  message: ProcessingJobMessage,
  now = new Date(),
  summaryAdapter?: SummaryAdapter | null,
  reviewAdapter?: EventReviewAdapter | null
): Promise<ProcessingResult | undefined> {
  try {
    const briefing = await repo.getBriefingById(message.briefingId);
    const rawMessage = await repo.getRawMessage(message.rawMessageId);
    if (!briefing || !rawMessage) {
      await repo.failProcessingJob(message.jobId, "Briefing or raw message not found", now);
      return undefined;
    }

    if (briefing.paused) {
      await repo.completeProcessingJob(message.jobId, now);
      return undefined;
    }

    const source = await repo.getSource(rawMessage.source.id);
    if (!source?.enabled) {
      await repo.completeProcessingJob(message.jobId, now);
      return undefined;
    }

    const existingItems = limitExistingItemsForProcessing(await repo.getExistingItems(briefing.id, now));
    const existingItemIds = new Set(existingItems.map((item) => item.id));
    const recentMessages = await repo.listRecentRawMessages(briefing.id, now, RECENT_MESSAGE_CONTEXT_LIMIT);
    const messages = uniqueMessagesById([rawMessage, ...recentMessages]);
    const importantMessageIds = await findImportantMessageIds(briefing, messages, rawMessage.id, reviewAdapter);
    const result = processMessages({
      briefing,
      messages,
      existingItems,
      importantMessageIds,
      now
    });
    result.publishedItems = await mergeReviewedEquivalentItems(
      briefing,
      result.publishedItems,
      rawMessage.id,
      reviewAdapter
    );

    if (summaryAdapter) {
      for (const item of result.publishedItems) {
        if (item.evidence.some((evidence) => evidence.messageId === rawMessage.id)) {
          const fallbackSummary = item.summary;
          try {
            const candidateSummary = sanitizeSummary(await summaryAdapter.summarize({ briefing, evidence: item.evidence }), briefing.language);
            if (candidateSummary) item.summary = candidateSummary;
            else if (!existingItemIds.has(item.id)) item.summary = "";
            else item.summary = fallbackSummary;
          } catch {
            item.summary = fallbackSummary;
          }
        }
      }
    }

    const changedItems = result.publishedItems.filter((item) =>
      Boolean(item.summary) && item.evidence.some((evidence) => evidence.messageId === rawMessage.id)
    );
    await repo.saveBriefingItems(briefing.id, changedItems, now);
    await repo.completeProcessingJob(message.jobId, now);
    return result;
  } catch (error) {
    await repo.failProcessingJob(
      message.jobId,
      error instanceof Error ? error.message : "Unknown processing error",
      now
    );
    throw error;
  }
}

function uniqueMessagesById<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  return unique;
}

function limitExistingItemsForProcessing(items: BriefingItem[]): BriefingItem[] {
  return items
    .slice()
    .sort((left, right) => right.itemAt.localeCompare(left.itemAt))
    .slice(0, EXISTING_ITEM_CONTEXT_LIMIT);
}

async function findImportantMessageIds(
  briefing: BriefingConfig,
  messages: NormalizedMessage[],
  currentMessageId: string,
  reviewAdapter?: EventReviewAdapter | null
): Promise<string[]> {
  const important = new Set<string>();
  for (const message of messages) {
    if (isImportantToInterest(message, briefing)) {
      important.add(message.id);
      continue;
    }
  }
  const currentMessage = messages.find((message) => message.id === currentMessageId);
  if (reviewAdapter && currentMessage && !important.has(currentMessage.id) && isImportantReviewCandidate(currentMessage, briefing)) {
    try {
      if (await reviewAdapter.isImportant({ briefing, message: currentMessage })) important.add(currentMessage.id);
    } catch {
      // Review calls are advisory; deterministic filtering remains the fallback.
    }
  }
  return Array.from(important);
}

async function mergeReviewedEquivalentItems(
  briefing: BriefingConfig,
  items: BriefingItem[],
  rawMessageId: string,
  reviewAdapter?: EventReviewAdapter | null
): Promise<BriefingItem[]> {
  const merged: BriefingItem[] = [];
  for (const item of items) {
    const target = merged.find((candidate) => areSameEventDeterministic(candidate.evidence, item.evidence));
    if (target) mergeBriefingItem(target, item, briefing);
    else merged.push({ ...item, evidence: item.evidence.map((entry) => ({ ...entry, links: [...entry.links], media: entry.media.map((media) => ({ ...media })) })) });
  }

  if (!reviewAdapter) return sortItems(merged);

  let reviews = 0;
  const maxReviews = 2;
  for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
    const left = merged[leftIndex];
    if (!left.evidence.some((entry) => entry.messageId === rawMessageId)) continue;

    for (let rightIndex = 0; rightIndex < merged.length; rightIndex += 1) {
      if (leftIndex === rightIndex || reviews >= maxReviews) continue;
      const right = merged[rightIndex];
      if (!right || !shouldReviewEventPair(left, right)) continue;
      reviews += 1;
      try {
        if (await reviewAdapter.areSameEvent({ briefing, left: left.evidence, right: right.evidence })) {
          mergeBriefingItem(right, left, briefing);
          merged.splice(leftIndex, 1);
          leftIndex -= 1;
          break;
        }
      } catch {
        // Equivalence review is advisory; deterministic merge remains the fallback.
      }
    }
  }

  return sortItems(merged);
}

function shouldReviewEventPair(left: BriefingItem, right: BriefingItem): boolean {
  const leftTokens = eventTokens([left.summary, ...left.evidence.map((entry) => entry.text)].join(" "));
  const rightTokens = eventTokens([right.summary, ...right.evidence.map((entry) => entry.text)].join(" "));
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  return jaccardSimilarity(leftTokens, rightTokens) >= 0.24;
}

function sortItems(items: BriefingItem[]): BriefingItem[] {
  return items.sort((left, right) => right.itemAt.localeCompare(left.itemAt));
}
