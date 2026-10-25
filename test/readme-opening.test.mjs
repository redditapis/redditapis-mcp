// readme-opening.test.mjs: the first paragraph of README.md is the text that
// Glama, mcpservers.org, the MCP Registry and npm copy word for word into their
// listings, so it is a published surface. This gate holds the README to facts
// read from the shipped package, never from another document:
//
//   1. the opening names the package as published and is short enough to be
//      copied whole (listings take about the first 120 words), with no dashes;
//   2. the "Website:" line under it equals server.json websiteUrl;
//   3. every tool count the README states equals the live catalog
//      (src/tools.js): "<N> tools", "<N> Reddit reads", "<N> Reddit-facing
//      tools" and "the other <N>". A README once said 47 while the FAQ's
//      "30 ... Of the other 15" still added up to 45;
//   4. one version across package.json, server.json (x2) and package-lock.json.
//
// Run: node test/readme-opening.test.mjs   (wired into `npm test`)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json"));
const srv = JSON.parse(read("server.json"));
const lock = JSON.parse(read("package-lock.json"));

// The catalog split the README describes: everything that is not account
// administration (monitor/webhook, feedback, account) or one of the two local
// helpers is a Reddit read.
const names = TOOLS.map((t) => t.name);
const admin = names.filter((n) => /monitor|webhook|feedback|account/.test(n));
const helpers = ["reddit_set_watch", "reddit_explain"].filter((n) => names.includes(n));
// #16: the tools that act as the customer's connected Reddit account (connect, status,
// disconnect, comment, submit, vote, dm) are neither reads nor account administration, and
// neither are the scheduled-action tools (create, list, cancel), which post or comment later.
const accountActions = TOOLS.filter((t) => /^\/api\/reddit\/(session|comment|submit|vote|dm|schedule)(\/|$)/.test(t.path || "")).map((t) => t.name);
const reads = names.length - admin.length - helpers.length - accountActions.length;
const others = names.length - reads;

// 1. the opening
const blocks = readme.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
const opening = blocks.find((b) => !b.startsWith("#") && !b.startsWith("[!["));
assert.ok(opening, "README.md has an opening paragraph after the H1 and badges");
assert.ok(
  opening.startsWith(`${pkg.name} is the official MCP server`),
  `the opening starts with "${pkg.name} is the official MCP server", got: ${opening.slice(0, 80)}`,
);
const words = opening.split(/\s+/).length;
assert.ok(words <= 130, `the opening is ${words} words; listings copy about the first 120`);
assert.ok(!/[–—]/.test(opening), "the opening carries no en or em dash");

// 2. the website line
const site = readme.match(/^Website: (\S+)\s*$/m);
assert.ok(site, 'README.md has a "Website: <url>" line under the opening');
assert.equal(site[1], srv.websiteUrl, "README Website line equals server.json websiteUrl");

// 3. every stated count
const claims = [
  { re: /\b(\d+) tools\b/g, want: names.length, what: "tools" },
  { re: /\b(\d+) Reddit reads\b/g, want: reads, what: "Reddit reads" },
  { re: /\b(\d+) Reddit-facing tools\b/g, want: reads, what: "Reddit-facing tools" },
  { re: /\bthe other (\d+)\b/gi, want: others, what: "the other N" },
];
let checked = 0;
for (const { re, want, what } of claims) {
  for (const m of readme.matchAll(re)) {
    checked += 1;
    assert.equal(Number(m[1]), want, `README states ${m[1]} ${what} but src/tools.js gives ${want}`);
  }
}
assert.ok(checked > 0, "found no tool-count claim in README.md; the count check would be vacuous");

// 4. one version
const versions = {
  "package.json": pkg.version,
  "server.json version": srv.version,
  "server.json packages[0].version": srv.packages?.[0]?.version,
  "package-lock.json": lock.version,
  'package-lock.json packages[""].version': lock.packages?.[""]?.version,
};
assert.equal(new Set(Object.values(versions)).size, 1, `one version everywhere: ${JSON.stringify(versions)}`);

console.log(
  `readme-opening: ${names.length} tools (${reads} Reddit reads, ${others} other), ${checked} count claim(s), version ${pkg.version}, website ${srv.websiteUrl}`,
);
