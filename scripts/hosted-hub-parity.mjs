#!/usr/bin/env node
// hosted-hub-parity.mjs: after every npm publish, does the hosted hub page still
// describe THIS catalog?
//
// WHY. The site at redditapis.com renders its /mcp hub (the tool table, the
// title tag "Reddit MCP: N Tools ...", the install page, a blog post, llms.txt)
// from a copy of this catalog that lives in the site repo and is updated by
// hand when the site bumps its redditapis-mcp dependency. Nothing in THIS repo
// ever told the publisher that the site was now behind. Measured: 0.10.0 added
// reddit_set_watch on 2026-10-02 and the hub said 44 tools until 2026-10-14,
// twelve days, while npm shipped 45.
//
//   node scripts/hosted-hub-parity.mjs            compare TOOLS.length with the hub title
//   HOSTED_HUB_URL=https://... node scripts/...   another hub (a preview, a staging host)
//
// Runs as part of `postpublish` (scripts/postpublish.mjs). Right after a publish
// that changed the catalog a mismatch is EXPECTED: the hub updates when the site
// bumps the dependency. The non-zero exit is the nag that makes that bump happen
// in the same sitting instead of twelve days later, and the message names the
// exact files.
//
// EXIT 0 in step | 1 the hub states a different count | 2 cannot evaluate
// (the hub did not answer, or its title no longer carries the count). A check
// that could not run is never a pass.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const DEFAULT_HUB_URL = "https://www.redditapis.com/mcp";

// The hub's <title> is the one machine-readable count the page carries on every
// build: "Reddit MCP: 45 Tools for Claude, Cursor and VS Code". It is rendered
// from the same constant the page's title-vs-table assertion checks, so a title
// that says N means the table has N rows.
const TITLE_RE = /<title>\s*Reddit MCP:\s*(\d+)\s+Tools\b[^<]*<\/title>/i;

// The hub lists ENDPOINT-BACKED tools (one row per tool with a REST path); a
// local tool such as reddit_explain, which answers from the catalog itself and
// calls no endpoint, is not a hub row. Count the way the hub counts.
export function endpointBackedCount(tools) {
  return (tools || []).filter((t) => t && typeof t.path === "string" && t.path.length > 0).length;
}

/** The tool count the hub states, or null when the title does not carry one. */
export function parseHubToolCount(html) {
  if (typeof html !== "string") return null;
  const m = html.match(TITLE_RE);
  return m ? Number(m[1]) : null;
}

// The site-repo files that carry the count or the tool list, in the order the
// site's own all-surface parity gate (scripts/reconcile-endpoints.mjs there)
// reports them. Listed here so the publisher is told exactly what to touch.
export const HUB_FILES = [
  "package.json + package-lock.json (bump the redditapis-mcp dependency; the gates read the installed catalog)",
  "apps/frontend/app/(en)/mcp/mcpTools.ts (MCP_HUB_TOOLS: one row per tool, by name)",
  "apps/frontend/app/(en)/mcp/page.tsx (TITLE_TOOL_COUNT)",
  "apps/frontend/app/reddit-mcp-server/page.tsx (officialTools)",
  "apps/frontend/content/blog/reddit-api-npm-sdk-2026.md (the tool count in prose)",
  "apps/frontend/public/llms.txt and llms-full.txt (regenerated)",
  "scripts/mcp-tool-count-claims-allowlist.json (any dated historical count)",
];

/** { ok, code, lines } for a catalog count and the hub's count (null = unreadable). */
export function hubVerdict({ catalogCount, hubCount, hubUrl = DEFAULT_HUB_URL, version = "" }) {
  if (!Number.isInteger(hubCount)) {
    return { ok: false, code: 2, lines: [
      `[hub-parity] CANNOT EVALUATE: ${hubUrl} answered, but its <title> no longer carries "Reddit MCP: N Tools".`,
      "  Either the hub changed its title shape (update TITLE_RE here) or the page is not the hub. Not a pass.",
    ] };
  }
  if (hubCount === catalogCount) {
    return { ok: true, code: 0, lines: [`[hub-parity] IN STEP: the hosted hub states ${hubCount} tools and this catalog exposes ${catalogCount} endpoint-backed tools.`] };
  }
  return { ok: false, code: 1, lines: [
    `[hub-parity] HUB BEHIND: this catalog${version ? ` (${version})` : ""} exposes ${catalogCount} endpoint-backed tools; ${hubUrl} states ${hubCount}.`,
    "  Right after a publish that changed the catalog this is expected, and it stays wrong until the site",
    "  repo bumps its redditapis-mcp dependency and updates every surface that states the count. Do it now:",
    ...HUB_FILES.map((f) => `    - ${f}`),
    "  Then run the site's `node scripts/reconcile-endpoints.mjs`; it lists every remaining FAIL row.",
  ] };
}

async function fetchHub(url) {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "redditapis-mcp hub-parity check" } });
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      return await r.text();
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { error: lastErr };
}

async function main() {
  const { TOOLS } = await import("../src/tools.js");
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let version = "";
  try { version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || ""; } catch { /* the version is decoration here */ }
  const hubUrl = process.env.HOSTED_HUB_URL || DEFAULT_HUB_URL;
  const html = await fetchHub(hubUrl);
  if (typeof html !== "string") {
    console.error(`[hub-parity] CANNOT EVALUATE: ${hubUrl} did not answer after 3 attempts (${html.error}). Not a pass.`);
    process.exit(2);
  }
  const v = hubVerdict({ catalogCount: endpointBackedCount(TOOLS), hubCount: parseHubToolCount(html), hubUrl, version });
  for (const l of v.lines) (v.ok ? console.log : console.error)(l);
  process.exit(v.code);
}

function isEntrypoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isEntrypoint()) main();
