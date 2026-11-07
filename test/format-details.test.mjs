// format-details.test.mjs: the comment-tree `format` param and the list
// `include_details` param, called over the protocol (createServer + an
// in-memory client), so the test sees the query string a host's call produces.
// No network, no real key.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${m}`); };

function recordingFetch(body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { calls, impl };
}

async function connect(fetchImpl) {
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const query = (url) => new URL(url).searchParams;

// 1. reddit_post_comments: format is an optional raw|normalized enum, passed as a query param
{
  const f = byName.reddit_post_comments.shape.format;
  assert.ok(f, "reddit_post_comments declares format");
  assert.ok(f.safeParse(undefined).success, "format is optional");
  assert.ok(f.safeParse("raw").success && f.safeParse("normalized").success);
  assert.equal(f.safeParse("flat").success, false, "format refuses a value outside raw|normalized");

  const { calls, impl } = recordingFetch({ post: {}, comments: [], meta: { format: "normalized" } });
  const c = await connect(impl);
  await c.callTool({ name: "reddit_post_comments", arguments: { permalink: "/r/a/comments/abc/x/", format: "normalized" } });
  await c.callTool({ name: "reddit_post_comments", arguments: { permalink: "/r/a/comments/abc/x/" } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/reddit\/comments\?/);
  assert.equal(query(calls[0].url).get("format"), "normalized");
  assert.equal(query(calls[1].url).has("format"), false, "absent format is not sent, so the API's raw default applies");
  ok("reddit_post_comments passes format=normalized through and sends nothing when it is absent");
}

// 2. include_details on the user search and the three subreddit browse lists
for (const name of ["reddit_search_users", "reddit_subreddits_popular", "reddit_subreddits_new", "reddit_subreddits_default"]) {
  const s = byName[name].shape.include_details;
  assert.ok(s, `${name} declares include_details`);
  assert.ok(s.safeParse(undefined).success, `${name}: include_details is optional`);
  assert.equal(s.safeParse("yes").success, false, `${name}: include_details is a boolean`);

  const { calls, impl } = recordingFetch({ users: [], subreddits: [], after: null });
  const c = await connect(impl);
  const base = name === "reddit_search_users" ? { q: "spez" } : {};
  await c.callTool({ name, arguments: { ...base, include_details: true } });
  await c.callTool({ name, arguments: { ...base } });
  assert.equal(query(calls[0].url).get("include_details"), "true", `${name} sends include_details=true`);
  assert.equal(query(calls[1].url).has("include_details"), false, `${name}: absent include_details is not sent`);
  ok(`${name} passes include_details through and omits it by default`);
}

// 2b. include_bodies on post search
{
  const s = byName.reddit_search.shape.include_bodies;
  assert.ok(s, "reddit_search declares include_bodies");
  assert.ok(s.safeParse(undefined).success, "include_bodies is optional");
  assert.equal(s.safeParse("yes").success, false, "include_bodies is a boolean");
  const { calls, impl } = recordingFetch({ posts: [], after: null });
  const c = await connect(impl);
  await c.callTool({ name: "reddit_search", arguments: { q: "rust", include_bodies: true } });
  await c.callTool({ name: "reddit_search", arguments: { q: "rust" } });
  assert.equal(query(calls[0].url).get("include_bodies"), "true", "reddit_search sends include_bodies=true");
  assert.equal(query(calls[1].url).has("include_bodies"), false, "absent include_bodies is not sent");
  assert.match(byName.reddit_search.description, /include_bodies/);
  ok("reddit_search passes include_bodies through, omits it by default, and its description names it");
}

// 3. descriptions name the new fields a caller reads back
assert.match(byName.reddit_post_comments.description, /sort_defaulted/);
assert.match(byName.reddit_subreddit_posts.description, /sort_served/);
assert.match(byName.reddit_monitor_webhook_list.description, /url_masked/);
assert.match(byName.reddit_monitor_deliveries.description, /attempts/);
assert.match(byName.reddit_monitor_deliveries.description, /retries/);
assert.match(byName.reddit_search_users.description, /unavailable_fields/);
ok("descriptions name sort_defaulted, sort_served, url_masked, attempts, retries and unavailable_fields");

console.log(`format-details: ${n} checks passed`);
