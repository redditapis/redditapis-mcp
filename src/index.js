#!/usr/bin/env node
// redditapis-mcp, official MCP server for redditapis.com
//
// Exposes the Reddit API as native MCP tools for Claude, Cursor, and any MCP
// client: subreddit listings, post + comment search, community/user/media/comment
// search, a post's comment tree, subreddit top posts, user profile/comments,
// (since 0.2.0) managing your own redditapis.com monitors and webhooks -- create/
// list/update/remove a monitor, register/list/test/delete a webhook, and read
// delivery history -- and (since 0.4.0) sending the team product feedback the
// user has reviewed. Each tool is a thin, typed wrapper over a REST endpoint at
// https://api.redditapis.com, except reddit_feedback_send, whose draft queue
// lives on this machine (./feedback.js) and posts only on the user's say. The
// server holds no other state and forwards your API key on every call. The
// tool catalog lives in ./tools.js.
//
// Config (env):
//   REDDITAPIS_KEY        required. Your key from https://www.redditapis.com
//                         (REDDIT_APIS_KEY is accepted as an alias).
//   REDDITAPIS_BASE_URL   optional. Defaults to https://api.redditapis.com
//   REDDITAPIS_TIMEOUT_MS optional. Per-request timeout (default 30000)
//   REDDITAPIS_FEEDBACK_DIR optional. Where reddit_feedback_send keeps its
//                         local draft queue (default ~/.redditapis)
//
// Run:  npx -y redditapis-mcp@latest   (stdio transport)

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, buildQuery, buildPath, buildBody, buildHeaders } from "./tools.js";
import { createFeedbackHandler, sameFailure } from "./feedback.js";

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

// The last tool call that failed, so a feedback draft can carry the endpoint,
// status and request id without the model retyping them. Set in callEndpoint's
// error branch; the tool name is added by the registration wrapper below.
let lastError = null;

// REST call. Resolves any {param} path placeholders from args, and for GET
// sends the rest as a query string; for POST it sends the rest as a JSON body
// (see buildBody -- `tool` is passed through only to read its
// `filterSpecFields`). Forwards the API key as a Bearer token (redditapis.com
// authenticates via `Authorization: Bearer <key>` only).
// The trailing sentence appended to a failed call, so the model reads an error
// it can act on rather than a bare status.
//
// A 404 HINT HAS TO KNOW WHICH ENDPOINT WAS CALLED. This was a flat status-only
// ternary, so every 404 in the catalog got the listing-shaped sentence, and a
// caller whose FEEDBACK id was not found was told to check their subreddit,
// post id or permalink. None of those are involved. The feedback endpoints are
// the first mounted outside the /api/reddit surface, so they are the first
// place that assumption is plainly wrong; /account/* would have been next.
//
// Only the 404 varies, because it is the only status whose useful advice
// depends on what was being looked up. Everything else is about the KEY, the
// CREDIT balance or OUR service and reads the same on every endpoint.
const NOT_FOUND_HINTS = [
  [/^\/feedback/, " (not found. No feedback report with that id on this account, and an id from another account will not resolve here. Use the id returned by reddit_feedback_send action=send.)"],
  [/^\/account/, " (not found. That account resource does not exist for this key.)"],
];
const DEFAULT_NOT_FOUND_HINT =
  " (not found. The subreddit, post id, user, or permalink may be wrong or deleted)";

export function hintFor(status, path) {
  if (status === 401) return " (invalid or missing API key, verify REDDITAPIS_KEY at https://www.redditapis.com)";
  if (status === 402) return " (insufficient credits, top up at https://www.redditapis.com)";
  if (status === 403) return " (access forbidden. The subreddit/user may be private, banned, or quarantined)";
  if (status === 404) {
    for (const [re, hint] of NOT_FOUND_HINTS) if (re.test(path || "")) return hint;
    return DEFAULT_NOT_FOUND_HINT;
  }
  if (status === 429) return " (rate limited. Wait a few seconds and retry, or reduce request frequency)";
  if (status >= 500) return " (upstream API error. Retry in a moment; if persistent, contact https://www.redditapis.com)";
  return "";
}

async function callEndpoint(pathTemplate, args, method = "GET", tool = null) {
  const { path, rest: pathRest } = buildPath(pathTemplate, args);
  // A tool that declares `sessionHeaders` has its Reddit session args lifted
  // out of the query and onto headers. For every other tool this is the
  // identity, so the request is byte-for-byte what it was before.
  const { headers: sessionHeaders, rest } = buildHeaders(tool, pathRest);
  const isWrite = method !== "GET";
  const q = isWrite ? "" : buildQuery(rest);
  const url = `${BASE_URL}${path}${q ? `?${q}` : ""}`;

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    accept: "application/json",
    "user-agent": `reddit-mcp/${VERSION}`,
    ...sessionHeaders,
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
      const hint = hintFor(res.status, path);
      lastError = {
        path,
        method,
        status: res.status,
        requestId: res.headers.get("x-request-id") || undefined,
        ts: Date.now(),
      };
      // Credential, credit, rate-limit and not-found failures are the caller's
      // situation (a 404 is almost always a wrong id or a deleted thing, a 409
      // a conflict with the caller's own state), not a product defect;
      // everything else may be one, and the model reads error bodies closely,
      // so the pointer lives here.
      const feedbackHint =
        res.status === 401 || res.status === 402 || res.status === 404 || res.status === 409 || res.status === 429
          ? ""
          : " If this blocked the user's task and looks like a defect or a missing capability, draft a report with reddit_feedback_send (queued locally until the user reviews it).";
      return { isError: true, content: [{ type: "text", text: `HTTP ${res.status}${hint}: ${body.slice(0, 1200)}${feedbackHint}` }] };
    }
    // A success clears the record so a later draft never inherits an old
    // failure's endpoint or request id (review 2026-09-04: a remove's draft
    // carried the previous update's 404).
    lastError = null;
    return { content: [{ type: "text", text: body }] };
  } catch (err) {
    const msg = err?.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message || String(err);
    lastError = { path, method, status: null, error: msg.slice(0, 200), ts: Date.now() };
    return { isError: true, content: [{ type: "text", text: `Request failed: ${msg}` }] };
  } finally {
    clearTimeout(timer);
  }
}

// Standing instructions the client hands its model alongside the tool list.
// This is the trigger list for feedback, in the place a model actually reads.
const INSTRUCTIONS =
  "redditapis.com MCP server. Read tools cost credits per call (most $0.002); monitor, webhook and feedback tools are free. " +
  "If a redditapis tool call fails with an error other than 401/402/429 and the user has to work around it, if the user asks for something no redditapis tool covers, " +
  "if a documented field comes back empty or wrong, or if the user is clearly frustrated with a result, draft a report with reddit_feedback_send (action \"draft\"). " +
  "Drafting is local and silent; never send a draft unless the user names it after reviewing action \"list\".";

const server = new McpServer({ name: "redditapis", version: VERSION }, { instructions: INSTRUCTIONS });

// Handlers for tools that carry local: "<name>" in the catalog. A name the
// catalog uses and this map lacks is a boot-time failure, never a silent
// passthrough to the API with the local args attached.
const LOCAL_HANDLERS = {
  feedback: createFeedbackHandler({
    callEndpoint,
    version: VERSION,
    getClientInfo: () => server.server.getClientVersion(),
    getLastError: () => lastError,
  }),
};

for (const tool of TOOLS) {
  const method = tool.method || "GET";
  const annotations = {
    title: tool.name,
    readOnlyHint: !tool.write,
    destructiveHint: Boolean(tool.destructive),
    openWorldHint: true,
  };
  let handler;
  if (tool.local) {
    handler = LOCAL_HANDLERS[tool.local];
    if (!handler) throw new Error(`[reddit-mcp] tool ${tool.name} declares local handler "${tool.local}" but src/index.js has none`);
  } else {
    handler = async (args) => {
      const result = await callEndpoint(tool.path, args, method, tool);
      if (result?.isError && lastError) {
        let resolved = null;
        try { resolved = buildPath(tool.path, args).path; } catch { resolved = null; }
        // Name the tool only when BOTH method and path match the recorded
        // failure; a GET and a POST can share a path.
        if (sameFailure(lastError, resolved, method)) lastError.tool = tool.name;
      }
      return result;
    };
  }
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.shape, annotations },
    handler,
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
