import type { BriefingItem } from "@lownoise/core";
import type { Env } from "./types";

export async function upsertPublishedItemsToVectorize(env: Env, items: BriefingItem[]): Promise<void> {
  if (
    !env.VECTORIZE ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.CLOUDFLARE_AI_GATEWAY_ID ||
    !env.OPENAI_API_KEY ||
    items.length === 0
  ) {
    return;
  }

  const vectors = [];
  for (const item of items) {
    const embedding = await createEmbedding(env, [
      item.summary,
      ...item.evidence.map((evidence) => `${evidence.sourceTitle}: ${evidence.text}`)
    ].join("\n"));

    vectors.push({
      id: item.id,
      values: embedding,
      metadata: {
        clusterId: item.clusterId,
        itemAt: item.itemAt,
        expiresAt: item.expiresAt
      }
    });
  }

  await env.VECTORIZE.upsert(vectors);
}

async function createEmbedding(env: Env, input: string): Promise<number[]> {
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_ID}/openai/embeddings`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        ...(env.CLOUDFLARE_AI_GATEWAY_TOKEN
          ? { "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN}` }
          : {}),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input
      })
    }
  );

  if (!response.ok) {
    throw new Error(`AI Gateway embedding request failed: ${response.status}`);
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding) throw new Error("AI Gateway returned an empty embedding");
  return embedding;
}
