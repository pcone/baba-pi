#!/usr/bin/env bun
/**
 * baba-mcp — the baba daemon as one MCP tool, `search`, over stdio.
 *
 * Registered once per user:
 *   claude mcp add --scope user baba -- /Users/scott/Developer/baba-pi/bin/baba-mcp.ts
 *
 * The repo is `CLAUDE_PROJECT_DIR` when set and non-empty, else the server's
 * cwd. The daemon starts on the first call. When a call carries a progress
 * token, the daemon log's lines reach the client as progress notifications.
 * stdout carries protocol frames only; diagnostics go to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_TOP_K, search, validTopK } from "../src/client.ts";
import pkg from "../package.json" with { type: "json" };

// The low-level Server takes the SDK's request schemas and plain JSON Schema.
// The high-level McpServer would need zod, a peer dependency this repo does not carry.

const TOOL = {
  name: "search",
  description:
    "Semantic search over this repository's docs and code, for questions that " +
    "span files (\"how does the daemon decide liveness\"). Not for exact strings, " +
    "a file you already know, or anything outside the repo. Returns ranked chunks " +
    "with path, heading, score and excerpt. Cost: a warm query takes about " +
    "0.2–0.7 s; the first query after the tree changes re-embeds what changed, " +
    "from seconds up to about 95 s for a large change.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query",
      },
      k: {
        type: "integer",
        minimum: 1,
        description: `Number of results (default ${DEFAULT_TOP_K})`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new Server(
  { name: "baba", version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== TOOL.name) {
    return toolError(`unknown tool "${request.params.name}"`);
  }

  const args = request.params.arguments ?? {};
  const query = args.query;
  const k = args.k ?? DEFAULT_TOP_K;
  if (typeof query !== "string") {
    return toolError("query must be a string");
  }
  if (typeof k !== "number" || !validTopK(k)) {
    return toolError("k must be a positive integer");
  }

  const progressToken = request.params._meta?.progressToken;
  let progress = 0;
  const onStatus = (message: string) => {
    if (progressToken === undefined) return;
    progress += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      })
      .catch((err: unknown) => {
        console.error(`baba-mcp: progress notification failed: ${err}`);
      });
  };

  // CLAUDE_PROJECT_DIR names the project; an empty value is unset.
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const text = await search(root, query, k, onStatus);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
});

await server.connect(new StdioServerTransport());
