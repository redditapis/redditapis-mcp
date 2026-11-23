// request-shape.test.mjs: the 0.22.0 tools send the request their REST route takes (method, path, body keys),
// called over the protocol (createServer + an in-memory client). Also pins the cross-field refusals
// (reddit_profile_avatar one-of, reddit_post_comments conflicting post) and the zod-version-proof array guard
// in the alias table. No network.
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { aliasesFor, isArraySchema } from "../src/input-aliases.js";

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${m}`); };

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url: new URL(String(url)), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
};
const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl });
const [a, b] = InMemoryTransport.createLinkedPair();
const c = new Client({ name: "t", version: "1" });
await Promise.all([server.connect(a), c.connect(b)]);

async function call(name, args) {
  const before = calls.length;
  const r = await c.callTool({ name, arguments: args });
  return { r, req: calls.length > before ? calls[calls.length - 1] : null };
}

// 1. method, path and body keys for each new or changed tool
{
  const CASES = [
    ["reddit_profile_description", { description: "hello" }, "POST", "/api/reddit/profile/description", ["description"]],
    ["reddit_profile_display_name", { display_name: "Hi" }, "POST", "/api/reddit/profile/display-name", ["display_name"]],
    ["reddit_profile_avatar", { image_url: "https://example.com/a.png", kind: "banner" }, "POST", "/api/reddit/profile/avatar", ["image_url", "kind"]],
    ["reddit_monitor_webhook_update", { id: "wh_1", delivery_mode: "daily", active: false }, "POST", "/api/reddit/monitor/webhook/update", ["active", "delivery_mode", "id"]],
    ["reddit_session_check", {}, "POST", "/api/reddit/session/check", []],
  ];
  for (const [tool, args, method, path, keys] of CASES) {
    const { r, req } = await call(tool, args);
    assert.ok(!r.isError, `${tool}: ${JSON.stringify(r.content)}`);
    assert.equal(req.method, method, `${tool}: method`);
    assert.equal(req.url.pathname, path, `${tool}: path`);
    assert.deepEqual(Object.keys(req.body || {}).sort(), keys, `${tool}: body keys`);
    assert.equal([...req.url.searchParams.keys()].length, 0, `${tool}: a POST puts nothing in the query`);
  }
  const { r, req } = await call("reddit_political_ads", { sort: "top", t: "week", limit: 5 });
  assert.ok(!r.isError);
  assert.equal(req.method, "GET");
  assert.equal(req.url.pathname, "/api/reddit/political-ads");
  assert.deepEqual(Object.fromEntries(req.url.searchParams), { sort: "top", t: "week", limit: "5" });
  assert.equal(req.body, undefined);
  ok(`${CASES.length + 1} tools send their route's method, path and inputs`);
}

// 2. reddit_profile_avatar: exactly one image source, refused before any request otherwise
{
  for (const args of [{}, { image_url: "https://example.com/a.png", image_base64: "iVBORw0KGgo=" }]) {
    const { r, req } = await call("reddit_profile_avatar", args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /exactly one of `image_url` or `image_base64`/);
    assert.equal(req, null, "no request was made");
  }
  const { r } = await call("reddit_profile_avatar", { image_base64: "iVBORw0KGgo=" });
  assert.ok(!r.isError);
  ok("reddit_profile_avatar refuses neither or both image sources without a request");
}

// 3. reddit_post_comments: two inputs naming different posts are refused; the same post twice is fine
{
  const clash = await call("reddit_post_comments", { permalink: "/r/x/comments/abc123/t/", post_id: "zzz999" });
  assert.equal(clash.r.isError, true);
  assert.match(clash.r.content[0].text, /name different posts/);
  assert.equal(clash.req, null);
  const viaAlias = await call("reddit_post_comments", { url: "https://www.reddit.com/r/x/comments/abc123/t/", id: "zzz999" });
  assert.equal(viaAlias.r.isError, true, "the id alias is checked too");
  const same = await call("reddit_post_comments", { permalink: "/r/x/comments/abc123/t/", post_id: "t3_abc123" });
  assert.ok(!same.r.isError);
  assert.equal(same.req.url.searchParams.get("post_id"), "t3_abc123");
  ok("reddit_post_comments refuses a permalink/url and post_id naming different posts");
}

// 4. the array guard works on the installed zod: a required array `subreddit` gets no `name` alias
{
  assert.equal(isArraySchema(z.array(z.string())), true);
  assert.equal(isArraySchema(z.string()), false);
  const fake = { name: "t", path: "/api/reddit/x", shape: { subreddit: z.array(z.string().min(1)).min(1) } };
  assert.deepEqual(aliasesFor(fake), [], "no `name` alias on a required array subreddit");
  const single = { name: "t", path: "/api/reddit/x", shape: { subreddit: z.string().min(1) } };
  assert.deepEqual(aliasesFor(single).map((x) => x.alias), ["name"]);
  ok("a required z.array subreddit is not aliased; a required string one is");
}

console.log(`\nrequest-shape: ${n} passed`);
