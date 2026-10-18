// Red tests for the hosted-hub parity check (scripts/hosted-hub-parity.mjs):
// the postpublish step that tells the publisher when the hub page still states
// the OLD tool count. No network: the parser and the verdict are exercised on
// fixtures, and the live fetch is left to `npm run check:hub-parity`.
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools.js";
import { parseHubToolCount, hubVerdict, hubToolCount, HUB_FILES, DEFAULT_HUB_URL } from "../scripts/hosted-hub-parity.mjs";

let n = 0;
const ok = (m) => { n += 1; console.log(`  [ok  ] ${m}`); };

// 1. the parser reads the hub's real title shape and nothing else
{
  const live = '<html><head><title>Reddit MCP: 45 Tools for Claude, Cursor and VS Code</title></head></html>';
  assert.equal(parseHubToolCount(live), 45);
  assert.equal(parseHubToolCount('<title>Reddit MCP: 46 Tools for Claude</title>'), 46);
  assert.equal(parseHubToolCount("<title>Reddit API pricing</title>"), null, "a title without the count reads null, never 0");
  assert.equal(parseHubToolCount("no title at all"), null);
  assert.equal(parseHubToolCount(null), null);
  // A count elsewhere on the page is not the title: "45 tools" in body copy must not be picked up.
  assert.equal(parseHubToolCount("<p>45 tools</p><title>Reddit MCP server</title>"), null);
  ok("parseHubToolCount reads the <title> count and refuses everything else");
}

// 2. IN STEP when the counts agree
{
  const v = hubVerdict({ catalogCount: 45, hubCount: 45 });
  assert.equal(v.ok, true); assert.equal(v.code, 0);
  assert.match(v.lines.join("\n"), /IN STEP/);
  ok("equal counts are IN STEP, exit 0");
}

// 3. HUB BEHIND names both counts, the version, the url and every hub file, exit 1
{
  const v = hubVerdict({ catalogCount: 46, hubCount: 45, version: "0.11.0" });
  assert.equal(v.ok, false); assert.equal(v.code, 1);
  const text = v.lines.join("\n");
  assert.match(text, /exposes 46 tools/); assert.ok(!/endpoint-backed/.test(text)); assert.match(text, /states 45/); assert.match(text, /0\.11\.0/);
  assert.ok(text.includes(DEFAULT_HUB_URL));
  for (const f of HUB_FILES) assert.ok(text.includes(f), `names ${f}`);
  assert.match(text, /reconcile-endpoints\.mjs/);
  assert.ok(!/[—–]/.test(text), "no dashes in operator-facing lines");
  ok("a behind hub is exit 1 and names the exact files to update");
}

// 4. a hub that answered without a readable count is CANNOT EVALUATE (exit 2), never a pass
{
  const v = hubVerdict({ catalogCount: 45, hubCount: null });
  assert.equal(v.ok, false); assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /CANNOT EVALUATE/);
  ok("an unreadable hub title is exit 2, not a pass");
}

// 5. the catalog this check compares against is the shipped one, counted the way the hub counts
//    (every tool, local ones included: the hub lists reddit_explain as a row), and a plant must
//    change the verdict
{
  const base = hubToolCount(TOOLS);
  assert.equal(base, TOOLS.length, "every tool counts");
  assert.ok(TOOLS.some((t) => !t.path), "the catalog carries a local tool without a path (reddit_explain)");
  assert.equal(hubToolCount([{ path: "/x" }, { name: "local", path: null }, { path: "" }, null]), 3, "a local tool counts; a null slot does not");
  // The false alarm this replaced: 47 tools, one of them local, and a hub titled 47 must be IN STEP.
  const fixture = Array.from({ length: 46 }, (_, i) => ({ name: `t${i}`, path: `/p${i}` })).concat([{ name: "reddit_explain", path: null }]);
  assert.equal(hubVerdict({ catalogCount: hubToolCount(fixture), hubCount: 47 }).code, 0, "47 tools with one local tool vs a hub of 47 is IN STEP");
  assert.equal(hubVerdict({ catalogCount: base, hubCount: base }).code, 0);
  const planted = base + 1; // what the next publish with one more tool would carry
  const v = hubVerdict({ catalogCount: planted, hubCount: base });
  assert.equal(v.code, 1, "one more tool in the catalog than the hub states must refuse");
  ok(`a catalog one tool ahead of the hub (${planted} vs ${base}) is refused`);
}

// 6. the check is WIRED: postpublish runs it, and the test chain runs this file
{
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.postpublish, /postpublish\.mjs/, "postpublish goes through the runner");
  assert.match(pkg.scripts["check:hub-parity"] || "", /hosted-hub-parity\.mjs/);
  assert.match(pkg.scripts.test, /hub-parity\.test\.mjs/, "the test chain runs this file");
  const runner = readFileSync(new URL("../scripts/postpublish.mjs", import.meta.url), "utf8");
  assert.match(runner, /registry-drift\.mjs/); assert.match(runner, /hosted-hub-parity\.mjs/);
  ok("postpublish runs the registry step AND the hub check; the test chain runs this file");
}

console.log(`hub-parity.test.mjs: ${n} passed, 0 failed`);
