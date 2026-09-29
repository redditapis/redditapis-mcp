// createServer(): one McpServer per caller, holding that caller's key and last
// failure in its own closure.
//
// WHY A FACTORY: the key and the last-failed-call record used to be module
// globals. Under stdio there is one process per user, so that was harmless;
// served remotely, one process serves many users, and a module global would
// send one caller's requests with another caller's key and hand one caller's
// failure (path, request id) to another caller's feedback draft. Every piece
// of per-caller state now lives inside createServer, and nothing in this file
// reads process.env: the entry point (index.js for stdio) resolves config and
// passes it in.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, buildQuery, buildPath, buildBody, buildHeaders } from "./tools.js";
import { createFeedbackHandler, sameFailure } from "./feedback.js";

// Read from package.json rather than a hand-maintained literal -- this drifted
// silently to "0.1.0" while the published package reached 0.1.12, so every
// User-Agent and MCP server handshake understated its own version for months.
export const { version: VERSION } = createRequire(import.meta.url)("../package.json");

export const DEFAULT_BASE_URL = "https://api.redditapis.com";
export const DEFAULT_TIMEOUT_MS = 30000;

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

// AGENT-ACTIONABLE PAYWALL. A missing key, a rejected key and an empty balance
// are the moments a user decides whether to keep using the product, and they
// happen inside an agent's turn. Prose like "top up at redditapis.com" leaves
// the agent guessing where to send the user; a structured payload names the
// exact page, so the agent can say "you have used your free credit, top up
// here" and resume after. The payload is both appended to the text (every
// client reads that) and returned as structuredContent (clients that parse it).
export const SIGNUP_URL = "https://www.redditapis.com/signup?utm_source=mcp&utm_medium=tool_error";
export const API_KEYS_URL = "https://www.redditapis.com/dashboard?utm_source=mcp&utm_medium=tool_error";
export const TOP_UP_URL = "https://www.redditapis.com/dashboard/buy-credits?utm_source=mcp&utm_medium=tool_error";

export function paywallFor(kind) {
  if (kind === "no_key") {
    return {
      needs: "account",
      message:
        "Missing REDDITAPIS_KEY: no API key is set. Sign up free at redditapis.com (new accounts start " +
        "with free credit, no card), copy the key from the dashboard, set REDDITAPIS_KEY in the MCP " +
        "client config, then retry this call.",
      action_url: SIGNUP_URL,
      api_keys_url: API_KEYS_URL,
      retry: "same call, after the key is set",
    };
  }
  if (kind === 401) {
    return {
      needs: "valid_key",
      message:
        "The redditapis.com API key was rejected (invalid, revoked or rotated). Copy a current key from " +
        "the dashboard, set REDDITAPIS_KEY, then retry this call.",
      action_url: API_KEYS_URL,
      retry: "same call, after the key is replaced",
    };
  }
  if (kind === 402) {
    return {
      needs: "credits",
      message:
        "The redditapis.com account is out of credits. Top up (pay as you go, no subscription), then " +
        "retry this call; nothing was charged for the failed request. reddit_account_me shows the balance.",
      action_url: TOP_UP_URL,
      retry: "same call, after topping up",
    };
  }
  return null;
}

function paywallResult(kind, detail = "") {
  const p = paywallFor(kind);
  return {
    isError: true,
    content: [{ type: "text", text: `${p.message}${detail ? ` (${detail})` : ""}\n\n${JSON.stringify(p)}` }],
    structuredContent: p,
  };
}

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

// Standing instructions the client hands its model alongside the tool list.
// This is the trigger list for feedback, in the place a model actually reads.
export const INSTRUCTIONS =
  "redditapis.com MCP server. Read tools cost credits per call (most $0.002); monitor, webhook and feedback tools are free. " +
  "If a redditapis tool call fails with an error other than 401/402/429 and the user has to work around it, if the user asks for something no redditapis tool covers, " +
  "if a documented field comes back empty or wrong, or if the user is clearly frustrated with a result, draft a report with reddit_feedback_send (action \"draft\"). " +
  "Drafting is local and silent; never send a draft unless the user names it after reviewing action \"list\". " +
  "Before drafting a report that a parameter is IGNORED or a field is EMPTY, re-run the call with a distinctive value that could only match if the parameter was honoured, and with the phrase quoted; " +
  "if either comes back on topic the issue is ranking or matching, so title it that way and say what the control showed.";

/**
 * Build one server for one caller.
 *
 * @param {object} opts
 * @param {string|undefined} opts.apiKey   the caller's key; calls fail clearly without one
 * @param {string} [opts.baseUrl]          API origin, default https://api.redditapis.com
 * @param {number} [opts.timeoutMs]        per-request timeout, must be > 0
 * @param {object} [opts.feedbackEnv]      env-shaped object for the feedback queue location
 *                                         (REDDITAPIS_FEEDBACK_DIR); a remote host gives each
 *                                         caller its own directory
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 */
export function createServer({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  feedbackEnv = process.env,
  fetchImpl = fetch,
} = {}) {
  const BASE_URL = String(baseUrl).replace(/\/+$/, "");
  const REQUEST_TIMEOUT_MS = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  // The last tool call that failed, so a feedback draft can carry the endpoint,
  // status and request id without the model retyping them. Set in callEndpoint's
  // error branch; the tool name is added by the registration wrapper below.
  // Per server, so one caller's failure never reaches another caller's draft.
  let lastError = null;

  // REST call. Resolves any {param} path placeholders from args, and for GET
  // sends the rest as a query string; for POST it sends the rest as a JSON body
  // (see buildBody -- `tool` is passed through only to read its
  // `filterSpecFields`). Forwards the API key as a Bearer token (redditapis.com
  // authenticates via `Authorization: Bearer <key>` only).
  async function callEndpoint(pathTemplate, args, method = "GET", tool = null) {
    // The credential check lives here, not at startup, so listing tools needs no
    // key and calling one still cannot silently proceed without it. Without this
    // the request would carry an Authorization header reading "Bearer
    // undefined" and the caller would read a 401 about an INVALID key when the
    // real answer is that no key was ever set.
    if (!apiKey) return paywallResult("no_key");
    const { path, rest: pathRest } = buildPath(pathTemplate, args);
    // A tool that declares `sessionHeaders` has its Reddit session args lifted
    // out of the query and onto headers. For every other tool this is the
    // identity, so the request is byte-for-byte what it was before.
    const { headers: sessionHeaders, rest } = buildHeaders(tool, pathRest);
    const isWrite = method !== "GET";
    const q = isWrite ? "" : buildQuery(rest);
    const url = `${BASE_URL}${path}${q ? `?${q}` : ""}`;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
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
      const res = await fetchImpl(url, { method, headers, body: requestBody, signal: ctrl.signal });
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
        if (res.status === 401 || res.status === 402) {
          return paywallResult(res.status, `HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
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
      env: feedbackEnv,
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
      if (!handler) throw new Error(`[reddit-mcp] tool ${tool.name} declares local handler "${tool.local}" but src/server.js has none`);
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

  return { server, callEndpoint, getLastError: () => lastError, baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS };
}
