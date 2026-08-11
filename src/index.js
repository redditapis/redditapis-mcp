#!/usr/bin/env node
// redditapis-mcp, official MCP server for redditapis.com
//
// Exposes the Reddit API as native MCP tools for Claude, Cursor, and any MCP
// client: subreddit listings, post + comment search, community/user/media/comment
// search, a post's comment tree, subreddit top posts, user profile/comments, and
// (since 0.2.0) managing your own redditapis.com monitors and webhooks -- create/
// list/update/remove a monitor, register/list/test/delete a webhook, and read
// delivery history. Each tool is a thin, typed wrapper over a REST endpoint at
// https://api.redditapis.com. The server holds no state and forwards your API
// key on every call. The tool catalog lives in ./tools.js.
//
// Config (env):
//   REDDITAPIS_KEY        required. Your key from https://www.redditapis.com
//                         (REDDIT_APIS_KEY is accepted as an alias).
//   REDDITAPIS_BASE_URL   optional. Defaults to https://api.redditapis.com
//   REDDITAPIS_TIMEOUT_MS optional. Per-request timeout (default 30000)
//
// Run:  npx -y redditapis-mcp@latest   (stdio transport)

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, buildQuery, buildPath, buildBody } from "./tools.js";

const API_KEY = process.env.REDDITAPIS_KEY || process.env.REDDIT_APIS_KEY;
const BASE_URL = (
  process.env.REDDITAPIS_BASE_URL || "https://api.redditapis.com"
).replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.REDDITAPIS_TIMEOUT_MS || 30000);
// Read from package.json rather than a hand-maintained literal -- this drifted
// silently to "0.1.0" while the published package reached 0.1.12, so every
// User-Agent and MCP server handshake understated its own version for months.
const { version: VERSION } = createRequire(import.meta.url)("../package.json");

if (!API_KEY) {
  console.error(
    "[reddit-mcp] Missing REDDITAPIS_KEY. Get a key at https://www.redditapis.com and set it in your MCP client config.",
  );
  process.exit(1);
}

// REST call. Resolves any {param} path placeholders from args, and for GET
// sends the rest as a query string; for POST it sends the rest as a JSON body
// (see buildBody -- `tool` is passed through only to read its
// `filterSpecFields`). Forwards the API key as a Bearer token (redditapis.com
// authenticates via `Authorization: Bearer <key>` only).
async function callEndpoint(pathTemplate, args, method = "GET", tool = null) {
  const { path, rest } = buildPath(pathTemplate, args);
  const isWrite = method !== "GET";
  const q = isWrite ? "" : buildQuery(rest);
  const url = `${BASE_URL}${path}${q ? `?${q}` : ""}`;

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    accept: "application/json",
    "user-agent": `reddit-mcp/${VERSION}`,
  };
  let requestBody;
  if (isWrite) {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(buildBody(tool || {}, rest));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body: requestBody, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " (invalid or missing API key, verify REDDITAPIS_KEY at https://www.redditapis.com)"
          : res.status === 402
            ? " (insufficient credits, top up at https://www.redditapis.com)"
            : res.status === 403
              ? " (access forbidden. The subreddit/user may be private, banned, or quarantined)"
              : res.status === 404
                ? " (not found. The subreddit, post id, user, or permalink may be wrong or deleted)"
                : res.status === 429
                  ? " (rate limited. Wait a few seconds and retry, or reduce request frequency)"
                  : res.status >= 500
                    ? " (upstream API error. Retry in a moment; if persistent, contact https://www.redditapis.com)"
                    : "";
      return { isError: true, content: [{ type: "text", text: `HTTP ${res.status}${hint}: ${body.slice(0, 1200)}` }] };
    }
    return { content: [{ type: "text", text: body }] };
  } catch (err) {
    const msg = err?.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message || String(err);
    return { isError: true, content: [{ type: "text", text: `Request failed: ${msg}` }] };
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer({ name: "redditapis", version: VERSION });

for (const tool of TOOLS) {
  const method = tool.method || "GET";
  const annotations = {
    title: tool.name,
    readOnlyHint: !tool.write,
    destructiveHint: Boolean(tool.destructive),
    openWorldHint: true,
  };
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.shape, annotations },
    async (args) => callEndpoint(tool.path, args, method, tool),
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error(`[reddit-mcp] ready · ${TOOLS.length} tools · base ${BASE_URL}`);
}

main().catch((err) => {
  console.error("[reddit-mcp] fatal:", err);
  process.exit(1);
});
