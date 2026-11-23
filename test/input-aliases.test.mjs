// input-aliases.test.mjs: username/query/post_id are accepted as aliases of
// name/q/id (feedback 85f3f21b), called over the protocol (createServer + an
// in-memory client), so the test sees the request a host's call produces. The
// alias is moved onto the canonical name and never sent to the API. No network.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${m}`); };

function recordingFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
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

const { calls, impl } = recordingFetch();
const c = await connect(impl);
const url = () => new URL(calls[calls.length - 1].url);

// 1. username -> name on the user tools
{
  const r = await c.callTool({ name: "reddit_user_profile", arguments: { username: "spez" } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(url().pathname, "/api/reddit/user/spez");
  assert.equal(url().searchParams.has("username"), false, "the alias is never sent");
  await c.callTool({ name: "reddit_user_comments", arguments: { username: "spez", limit: 5 } });
  assert.equal(url().pathname, "/api/reddit/user/spez/comments");
  ok("reddit_user_profile and reddit_user_comments accept username for name");
}

// 2. query -> q on the search tools
{
  const r = await c.callTool({ name: "reddit_search", arguments: { query: "python" } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(url().searchParams.get("q"), "python");
  assert.equal(url().searchParams.has("query"), false);
  await c.callTool({ name: "reddit_search_communities", arguments: { query: "rust" } });
  assert.equal(url().searchParams.get("q"), "rust");
  ok("reddit_search and reddit_search_communities accept query for q");
}

// 3. post_id -> id on the post tools
{
  const r = await c.callTool({ name: "reddit_post", arguments: { post_id: "1sgjld3" } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(url().pathname, "/api/reddit/post/1sgjld3");
  await c.callTool({ name: "reddit_post_duplicates", arguments: { post_id: "1sgjld3" } });
  assert.equal(url().pathname, "/api/reddit/post/1sgjld3/duplicates");
  ok("reddit_post and reddit_post_duplicates accept post_id for id");
}

// 4. the canonical names still work, and are what the schema documents
{
  await c.callTool({ name: "reddit_user_profile", arguments: { name: "spez" } });
  assert.equal(url().pathname, "/api/reddit/user/spez");
  const { tools } = await c.listTools();
  const t = tools.find((x) => x.name === "reddit_user_profile");
  assert.ok(t.inputSchema.properties.name, "name is published");
  assert.ok(t.inputSchema.properties.username, "username is published as its alias");
  assert.match(t.inputSchema.properties.username.description, /Alias of `name`/);
  // A monitor id is not a post id: post_id is not offered there.
  const m = tools.find((x) => x.name === "reddit_monitor_remove");
  assert.equal(m.inputSchema.properties.post_id, undefined);
  ok("canonical names still work; aliases are published only where they mean the canonical input");
}

// 5. neither, or both with different values, is refused before any request
{
  const before = calls.length;
  const none = await c.callTool({ name: "reddit_user_profile", arguments: {} });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /`name` is required \(or its alias `username`\)/);
  const both = await c.callTool({ name: "reddit_search", arguments: { q: "a", query: "b" } });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /both sent with different values/);
  assert.equal(calls.length, before, "no request was made");
  ok("a missing required input and a conflicting alias are refused without a request");
}

// 6. every alias added in 0.22.0 produces the same request as its canonical name
{
  calls.length = 0;
  const lastReq = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(r.content)}`);
    const last = calls[calls.length - 1];
    // Same request regardless of argument order: sorted query params, parsed body.
    const u = new URL(last.url);
    u.searchParams.sort();
    return { url: u.toString(), method: last.method, body: last.body ? JSON.parse(last.body) : undefined };
  };
  const CASES = [
    ["reddit_subreddit_about", { subreddit: "python" }, { name: "python" }],
    ["reddit_subreddit_top", { subreddit: "python", t: "week" }, { name: "python", t: "week" }],
    ["reddit_subreddit_can_post", { subreddit: "python" }, { name: "python" }],
    ["reddit_subreddit_wiki", { subreddit: "python", page: "index" }, { name: "python", page: "index" }],
    ["reddit_subreddit_posts", { name: "python", sort: "new" }, { subreddit: "python", sort: "new" }],
    ["reddit_comment_by_id", { comment_id: "abc123" }, { id: "abc123" }],
    ["reddit_post_comments", { id: "1sgjld3" }, { post_id: "1sgjld3" }],
    ["reddit_post_comments_expanded", { post_id: "1sgjld3" }, { id: "1sgjld3" }],
    ["reddit_typeahead", { query: "pyth", subreddit: "learnpython" }, { q: "pyth", sub: "learnpython" }],
    ["reddit_user_submitted", { username: "spez" }, { name: "spez" }],
    ["reddit_submit", { name: "test", kind: "self", title: "t", text: "b" }, { subreddit: "test", kind: "self", title: "t", text: "b" }],
    ["reddit_dm", { username: "spez", message: "hi" }, { to_username: "spez", message: "hi" }],
  ];
  for (const [tool, aliased, canonical] of CASES) {
    const a = await lastReq(tool, aliased);
    const b = await lastReq(tool, canonical);
    assert.deepEqual(a, b, `${tool}: the alias call and the canonical call sent different requests`);
    const sent = new URL(a.url);
    for (const k of Object.keys(aliased)) {
      if (!(k in canonical)) {
        assert.equal(sent.searchParams.has(k), false, `${tool}: alias ${k} leaked into the query`);
        if (a.body) assert.equal(k in a.body, false, `${tool}: alias ${k} leaked into the body`);
      }
    }
  }
  ok(`${CASES.length} tools: each 0.22.0 alias sends exactly the request its canonical name sends`);
}

// 7. the post_comments route takes permalink, url or post_id; an existing permalink call is unchanged
{
  await c.callTool({ name: "reddit_post_comments", arguments: { permalink: "/r/x/comments/abc123/t/" } });
  assert.equal(url().searchParams.get("permalink"), "/r/x/comments/abc123/t/");
  assert.equal(url().searchParams.has("post_id"), false);
  const { tools } = await c.listTools();
  const dm = tools.find((x) => x.name === "reddit_dm");
  assert.match(dm.inputSchema.properties.username.description, /Alias of `to_username`/);
  const about = tools.find((x) => x.name === "reddit_subreddit_about");
  assert.match(about.inputSchema.properties.subreddit.description, /Alias of `name`/);
  // A search filter named subreddit is not a required subreddit: `name` is not offered there.
  const search = tools.find((x) => x.name === "reddit_search");
  assert.equal(search.inputSchema.properties.name, undefined);
  ok("permalink still works on reddit_post_comments; aliases are published with their canonical name");
}

console.log(`\ninput-aliases: ${n} passed`);
