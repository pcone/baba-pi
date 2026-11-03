/**
 * baba pi extension
 *
 * Exposes a `semantic_search` tool to the LLM over the shared per-repo baba
 * daemon. All pi sessions (orchestrator + subagents) share one daemon per
 * main repository.
 *
 * The daemon client — repo resolution across worktrees, spawn-on-demand,
 * the JSON-line socket protocol and result formatting — lives in
 * `src/client.ts`, which `bin/baba-search.ts` uses too. This file is only
 * the pi surface: the tool registration, its schema and its prompt guidance.
 *
 * session_shutdown is a no-op: the daemon is shared and self-exits after
 * BABA_DAEMON_IDLE_SECS of inactivity (default 600s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  daemonRequest,
  ensureDaemon,
  formatResults,
  resolveMainRoot,
} from "./client.ts";

export default function babaExtension(pi: ExtensionAPI) {
  // ── Tool registration ──────────────────────────────────────────

  pi.registerTool({
    name: "semantic_search",
    label: "Semantic Search",
    description:
      "Semantic code search over the main repository's docs and code " +
      "(not your current worktree). Returns ranked chunks with path, " +
      "heading, snippet, and relevance score.",
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language search query",
      }),
      top_k: Type.Optional(
        Type.Number({
          description: "Number of results to return (default 10)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query: string = params.query;
      const topK: number =
        typeof params.top_k === "number" ? Math.floor(params.top_k) : 10;

      if (!query || query.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Error: empty query." }],
          details: {},
        };
      }

      try {
        const mainRoot = resolveMainRoot(ctx.cwd);
        const sockPath = await ensureDaemon(mainRoot);

        const response = await daemonRequest(
          {
            type: "search",
            query: query.trim(),
            top_k: topK,
          },
          sockPath,
        );

        // Surface any preceding status messages.
        const statuses: string[] = (response as { statuses?: string[] })
          .statuses ?? [];

        switch (response.type) {
          case "results": {
            let text = formatResults(response.results);
            if (statuses.length > 0) {
              text =
                statuses
                  .map((s) => `[baba] ${s}`)
                  .join("\n") +
                "\n\n" +
                text;
            }
            return {
              content: [{ type: "text", text }],
              details: {},
            };
          }
          case "error": {
            let text = `baba error: ${response.msg}`;
            if (statuses.length > 0) {
              text =
                statuses
                  .map((s) => `[baba] ${s}`)
                  .join("\n") +
                "\n" +
                text;
            }
            return {
              content: [{ type: "text", text }],
              details: {},
            };
          }
          case "status":
            // Shouldn't happen — read loop only returns results/error.
            // If it does, treat as informational.
            return {
              content: [
                { type: "text", text: `baba: ${response.msg}` },
              ],
              details: {},
            };
          default:
            return {
              content: [
                {
                  type: "text",
                  text: `baba returned unexpected response type: ${JSON.stringify(response)}`,
                },
              ],
              details: {},
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `baba tool error: ${message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── Lifecycle ───────────────────────────────────────────────────

  // Daemon is shared and detached — other sessions may still use it.
  // The daemon self-exits after BABA_DAEMON_IDLE_SECS (default 600s)
  // of inactivity. session_shutdown is intentionally a no-op.
}
