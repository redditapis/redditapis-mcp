// Every registered tool carries a human-readable title and all four MCP
// annotation hints (spec 2025-06-18 ToolAnnotations). Read over the protocol,
// through createServer and an in-memory client, so the test sees what a host
// sees in tools/list, not a restatement of the table.
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools.js";
import { TOOL_ANNOTATIONS, toolAnnotations } from "../src/annotations.js";
import { listCatalog, findingsFor } from "./description-compliance.test.mjs";

let n = 0;
const ok = (m) => { n += 1; console.log(`  [ok  ] ${m}`); };
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const TITLE_SHAPE = /^[A-Z][A-Za-z]*( (?:[A-Z][A-Za-z]*|by|of|to|and))*$/;
// A title is a plain label: no URL, host or domain shape, which is how a
// vendor or infrastructure name would ride in.
const BANNED_IN_TITLE = /https?:|www\.|\.(com|io|net|org|dev|app|ai)\b|api\./i;

// The checks, as a function over a tools/list result, so the red tests below
// run the same code the real sweep runs.
function auditTools(tools) {
  const problems = [];
  for (const t of tools) {
    if (typeof t.title !== "string" || !t.title) problems.push(`${t.name}: no title`);
    else {
      if (!TITLE_SHAPE.test(t.title)) problems.push(`${t.name}: title "${t.title}" is not short Title Case`);
      if (t.title.length > 40) problems.push(`${t.name}: title "${t.title}" is over 40 chars`);
      if (t.title.includes("_")) problems.push(`${t.name}: title "${t.title}" looks like a tool name`);
      if (BANNED_IN_TITLE.test(t.title)) problems.push(`${t.name}: title "${t.title}" names a host`);
      for (const f of findingsFor(t.name, "title", t.title)) problems.push(`${t.name}: title finding (${f.check}) ${f.hit}`);
    }
    if (t.annotations?.title !== t.title) problems.push(`${t.name}: annotations.title differs from title`);
    for (const h of HINTS) {
      if (typeof t.annotations?.[h] !== "boolean") problems.push(`${t.name}: ${h} not set`);
    }
  }
  return problems;
}

const { tools } = await listCatalog();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// 1. the table and the catalog agree in both directions
{
  assert.equal(tools.length, TOOLS.length, `listed ${tools.length} tools, catalog has ${TOOLS.length}`);
  const missing = TOOLS.map((t) => t.name).filter((x) => !TOOL_ANNOTATIONS[x]);
  const orphan = Object.keys(TOOL_ANNOTATIONS).filter((x) => !TOOLS.some((t) => t.name === x));
  assert.deepEqual(missing, [], `tools with no annotation row: ${missing.join(", ")}`);
  assert.deepEqual(orphan, [], `annotation rows naming no tool: ${orphan.join(", ")}`);
  const titles = Object.values(TOOL_ANNOTATIONS).map((r) => r.title);
  assert.equal(new Set(titles).size, titles.length, "two tools share a title");
  ok(`${TOOLS.length} catalog tools, ${Object.keys(TOOL_ANNOTATIONS).length} annotation rows, no gap either way, titles unique`);
}

// 2. table-driven: every registered tool has a title and all four hints
{
  const problems = auditTools(tools);
  assert.deepEqual(problems, [], problems.join("\n"));
  ok(`every one of ${tools.length} listed tools has a Title Case title and all four hints`);
}

// 3. readOnlyHint follows the catalog's own write flag, and the catalog's
// destructive flag is never weakened by the table
{
  for (const t of TOOLS) {
    const a = byName[t.name].annotations;
    assert.equal(a.readOnlyHint, !t.write, `${t.name}: readOnlyHint must equal !write`);
    if (t.destructive) assert.equal(a.destructiveHint, true, `${t.name}: catalog says destructive`);
    if (a.readOnlyHint) assert.equal(a.destructiveHint, false, `${t.name}: a read cannot be destructive`);
    assert.equal(TOOL_ANNOTATIONS[t.name].readOnly, !t.write, `${t.name}: table readOnly disagrees with the catalog`);
  }
  ok("readOnlyHint equals !write for every tool; catalog-destructive tools stay destructive; no read is destructive");
}

// 4. spot checks: three reads, three writes (two destructive)
{
  const expect = {
    reddit_search: { title: "Search Posts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    reddit_subreddit_posts: { title: "List Subreddit Posts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    reddit_account_me: { title: "Get Account Balance", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    reddit_monitor_add: { title: "Create Monitor", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    reddit_monitor_remove: { title: "Delete Monitor", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    reddit_monitor_webhook_delete: { title: "Delete Webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  };
  for (const [name, want] of Object.entries(expect)) {
    const t = byName[name];
    assert.ok(t, `${name} not listed`);
    assert.equal(t.title, want.title, `${name}: title`);
    for (const h of HINTS) assert.equal(t.annotations[h], want[h], `${name}: ${h}`);
  }
  ok("spot checks: 3 reads (2 Reddit, 1 own account) and 3 writes (1 additive, 2 destructive) carry the expected hints");
}

// 5. red tests: the audit must catch each planted defect class
{
  const good = byName.reddit_search;
  const plant = (mut) => { const t = structuredClone(good); mut(t); return auditTools([t]); };
  const cases = [
    ["no title", (t) => { delete t.title; }],
    ["snake_case title", (t) => { t.title = "reddit_search"; t.annotations.title = t.title; }],
    ["lowercase title", (t) => { t.title = "search posts"; t.annotations.title = t.title; }],
    ["host in title", (t) => { t.title = "Search Posts example.com"; t.annotations.title = t.title; }],
    ["annotations.title mismatch", (t) => { t.annotations.title = "Other"; }],
    ...HINTS.map((h) => [`${h} missing`, (t) => { delete t.annotations[h]; }]),
    ["hint not boolean", (t) => { t.annotations.idempotentHint = "true"; }],
  ];
  for (const [label, mut] of cases) assert.ok(plant(mut).length > 0, `audit missed planted defect: ${label}`);
  assert.deepEqual(plant(() => {}), [], "negative control: an unmodified tool must pass");
  ok(`audit catches all ${cases.length} planted defects and passes the unmodified control`);

  // A tool with no row cannot register at all.
  assert.throws(() => toolAnnotations({ name: "reddit_not_a_tool" }), /no row in src\/annotations\.js/);
  ok("toolAnnotations throws for a tool with no row, so registration fails closed");
}

console.log(`annotations: ${n} checks passed`);
