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
    calls.push({ url: String(url), method: init?.method });
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

console.log(`\ninput-aliases: ${n} passed`);
