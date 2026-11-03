# Follow-ups

Debts this repo carries and does not fix yet. Each row is the carrier: closing the row is the
work, and an item not listed here is dropped rather than deferred.

**F1 — `ServeResponse` does not declare `statuses`.** `daemonRequestOnce` attaches the
accumulated status lines to the terminal response, and both consumers read them through a
cast (`src/index.ts`, `bin/baba-search.ts`). Closing it: declare `statuses?: string[]` on the
terminal members of `ServeResponse` and delete the three casts. Left out of the WO-2026-068
extract because declaring it changes the protocol type inside a behaviour-preserving move.

**F2 — the default `top_k` of 10 is written twice.** `DEFAULT_TOP_K` in `bin/baba-search.ts`
and the `: 10` fallback in the tool's `execute`. Closing it: export one constant from
`src/client.ts` and use it at both sites. Left out because the order froze the tool body.
