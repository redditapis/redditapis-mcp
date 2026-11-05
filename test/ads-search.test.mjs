// ads-search.test.mjs: reddit_ads_search called over the protocol (createServer +
// an in-memory client), so the test sees the request a host's call produces.
// The fake response is the shape GET /api/reddit/ads/search answers:
// { ads[], count, after, has_more }. No network, no real key.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TOOLS, takesInlineCredentials } from "../src/tools.js";

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${m}`); };

function recordingFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { calls, impl };
}

async function connect(fetchImpl, opts = {}) {
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const PAGE = {
  ads: [{
    id: "t3_abc123",
    campaign_id: "c1",
    advertiser: "acme",
    title: "Ship faster",
    outbound_url: "https://shop.example.com/x",
    domain: "shop.example.com",
    call_to_action: "Learn More",
    subreddits: ["SaaS", "startups"],
    first_seen_at: "2026-10-01T00:00:00.000Z",
    last_seen_at: "2026-11-01T00:00:00.000Z",
    sightings: 7,
  }],
  count: 1,
  after: "cur_2",
  has_more: true,
};

// 1. the catalog entry
const tool = TOOLS.find((t) => t.name === "reddit_ads_search");
{
  assert.ok(tool, "reddit_ads_search is in the catalog");
  assert.equal(tool.path, "/api/reddit/ads/search");
  assert.equal(tool.method || "GET", "GET");
  assert.ok(!tool.write, "a read, not a write");
  assert.ok(!takesInlineCredentials(tool), "takes no cookie or proxy, so a remote host lists it");
  assert.match(tool.description, /^Search the Reddit ads library: promoted posts advertisers run on Reddit/);
  assert.match(tool.description, /Reddit's own house ads are excluded\. Newest first; page with cursor\./);
  assert.match(tool.description, /Billed at the read rate, the same as a post search\.$/);
  assert.deepEqual(
    Object.keys(tool.shape).sort(),
    ["advertiser", "campaign_id", "cursor", "domain", "limit", "q", "since", "subreddit", "until"],
  );
  ok("catalog: path, GET, read, nine optional params, description states the read rate");
}

// 2. the schema refuses what the endpoint refuses
{
  const z = tool.shape;
  assert.ok(z.q.safeParse("x".repeat(200)).success);
  assert.ok(!z.q.safeParse("x".repeat(201)).success, "q over 200 characters is refused");
  assert.ok(z.limit.safeParse(1).success && z.limit.safeParse(100).success);
  assert.ok(!z.limit.safeParse(0).success && !z.limit.safeParse(101).success && !z.limit.safeParse(2.5).success);
  for (const k of Object.keys(z)) assert.ok(z[k].safeParse(undefined).success, `${k} is optional`);
  ok("schema: q at most 200, limit an integer 1 to 100, every param optional");
}

// 3. over the protocol: every arg becomes a query param on the right path
{
  const f = recordingFetch(200, PAGE);
  const client = await connect(f.impl);
  const listed = (await client.listTools()).tools.find((t) => t.name === "reddit_ads_search");
  assert.ok(listed, "the server lists reddit_ads_search");
  assert.equal(listed.annotations?.readOnlyHint, true);
  const res = await client.callTool({
    name: "reddit_ads_search",
    arguments: { q: "crm", advertiser: "u/acme", domain: "shop.example.com", subreddit: "r/SaaS", campaign_id: "c1", since: "2026-10-01", until: "2026-11-01", limit: 50, cursor: "cur_1" },
  });
  assert.ok(!res.isError, "the call succeeds");
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/api/reddit/ads/search");
  assert.equal(f.calls[0].method || "GET", "GET");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    q: "crm", advertiser: "u/acme", domain: "shop.example.com", subreddit: "r/SaaS", campaign_id: "c1",
    since: "2026-10-01", until: "2026-11-01", limit: "50", cursor: "cur_1",
  });
  const text = res.content.map((c) => c.text || "").join("");
  assert.match(text, /"has_more":\s*true/);
  assert.match(text, /"after":\s*"cur_2"/);
  await client.close();
  ok("protocol: GET /api/reddit/ads/search with every filter, the page comes back with after and has_more");
}

// 4. no args is a legal call (the newest ads)
{
  const f = recordingFetch(200, { ads: [], count: 0, after: null, has_more: false });
  const client = await connect(f.impl);
  const res = await client.callTool({ name: "reddit_ads_search", arguments: {} });
  assert.ok(!res.isError);
  assert.equal(new URL(f.calls[0].url).search, "");
  await client.close();
  ok("protocol: no arguments sends no query string");
}

// 5. a host without inline credentials still lists it
{
  const client = await connect(recordingFetch(200, PAGE).impl, { inlineCredentials: false });
  assert.ok((await client.listTools()).tools.some((t) => t.name === "reddit_ads_search"));
  await client.close();
  ok("remote host (inlineCredentials false) lists reddit_ads_search");
}

console.log(`ads-search: ${n} passed`);
