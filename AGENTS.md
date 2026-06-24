# Distilled.news Project Notes

The old V1 blueprint has been retired. Treat the current implementation as the product direction unless the user gives newer instructions.

## Current Direction

- Distilled.news is a Cloudflare-first, self-hostable public briefing product.
- Published feeds are public by design and use username-scoped URLs.
- The app supports public accounts, multiple feeds, stars/explore, Telegram, RSS, Google News, X, LinkedIn, and Apify-backed sources.
- Search is basic retained published-feed search. Do not add or assume Vectorize unless explicitly requested later.
- Cloudflare Workers, D1, R2, Queues, Email Service, AI Gateway, and optional Apify remain the deployment/runtime stack.
- `distilled.news` is the canonical production domain. `lownoise.news` remains a legacy redirect.
- There is intentionally no chatbot or open-ended public Q&A surface.

## Review Bias

- Prioritize operational safety, deployability, source ingestion correctness, data retention, and honest admin health reporting.
- Keep onboarding practical for self-hosters: generated secrets, clear Cloudflare resource checks, remote migration instructions, and current API routes.
- Avoid reintroducing private-feed toggles, Vectorize claims, or the discarded V1-only scope constraints.
