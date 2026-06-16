import { buildSummaryPrompt, sanitizeSummary, type SummaryAdapter, type SummaryInput } from "@lownoise/core";
import type { Env } from "./types";

export class OpenAIGatewaySummaryAdapter implements SummaryAdapter {
  constructor(
    private readonly options: {
      accountId: string;
      gatewayId: string;
      apiKey: string;
      gatewayAuthToken?: string;
      model: string;
      fetcher?: typeof fetch;
    }
  ) {}

  async summarize(input: SummaryInput): Promise<string> {
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(
      `https://gateway.ai.cloudflare.com/v1/${this.options.accountId}/${this.options.gatewayId}/openai/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.options.gatewayAuthToken
            ? { "cf-aig-authorization": `Bearer ${this.options.gatewayAuthToken}` }
            : {}),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "You produce short LowNoise.news briefing summaries. You never answer questions or add facts outside evidence."
            },
            { role: "user", content: buildSummaryPrompt(input) }
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`AI Gateway summary request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("AI Gateway returned an empty summary");
    return sanitizeSummary(content);
  }
}

export function createSummaryAdapterFromEnv(env: Env): OpenAIGatewaySummaryAdapter | null {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AI_GATEWAY_ID || !env.OPENAI_API_KEY) return null;
  return new OpenAIGatewaySummaryAdapter({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
    apiKey: env.OPENAI_API_KEY,
    gatewayAuthToken: env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    model: env.OPENAI_MODEL ?? "gpt-4.1-mini"
  });
}
