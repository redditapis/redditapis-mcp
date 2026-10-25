// flairs-schedule.test.mjs: the subreddit post-flair read and the three
// scheduled-action tools, called over the protocol (createServer + an in-memory
// client), so the test sees the request a host's call actually produces.
//
// Every fake response is the SHAPE the live API sends for that route: the flairs
// 503 is {"error":"session_required","code":"SESSION_REQUIRED",message}, a
// schedule create answers 201 {action}, a cancel of an unknown id answers 404
// {"error":...,"code":"NOT_FOUND"}. No network, no real key.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, hintFor } from "../src/server.js";
import { TOOLS, takesInlineCredentials } from "../src/tools.js";

let n = 0;
const ok = (m) => { n += 1; console.log(`  ok  ${m}`); };

// A fetch that records every request and answers with the queued response.
function recordingFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers || {}, body: init?.body });
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

const ACTION = {
  id: "5f0c2a8e-8f3e-4c0b-9d0a-2b7d1c6e9a11",
  type: "post",
  status: "scheduled",
  run_at: "2026-10-21T15:00:00.000Z",
  request: { subreddit: "SaaS", kind: "self", title: "t", flair_id: "a1b2" },
  created_at: "2026-10-20T18:02:11.000Z",
  finished_at: null,
  result: null,
  error: null,
  billed: false,
};

// 1. the catalog: four new tools, paths and methods as the API serves them
{
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(by.reddit_subreddit_flairs.path, "/api/reddit/sub/{name}/flairs");
  assert.equal(by.reddit_subreddit_flairs.method || "GET", "GET");
  assert.ok(!by.reddit_subreddit_flairs.write);
  assert.equal(by.reddit_scheduled_create.path, "/api/reddit/schedule");
  assert.equal(by.reddit_scheduled_create.method, "POST");
  assert.equal(by.reddit_scheduled_list.path, "/api/reddit/schedule");
  assert.equal(by.reddit_scheduled_list.method || "GET", "GET");
  assert.equal(by.reddit_scheduled_cancel.path, "/api/reddit/schedule/cancel");
  assert.equal(by.reddit_scheduled_cancel.method, "POST");
  assert.ok(by.reddit_scheduled_create.write && by.reddit_scheduled_cancel.write && by.reddit_scheduled_cancel.destructive);
  // Each description states what it costs.
  assert.match(by.reddit_subreddit_flairs.description, /Billed at the read rate/);
  assert.match(by.reddit_subreddit_flairs.description, /not charged/);
  assert.match(by.reddit_scheduled_create.description, /Scheduling is free; a run that succeeds is billed at the write rate/);
  assert.match(by.reddit_scheduled_create.description, /With no connected session it answers 400 SESSION_NOT_CONNECTED/);
  assert.match(by.reddit_scheduled_list.description, /Free\.$/);
  assert.match(by.reddit_scheduled_cancel.description, /Free\.$/);
  // None takes a cookie, a token or a proxy, so a host without inline credentials still lists them.
  for (const t of ["reddit_subreddit_flairs", "reddit_scheduled_create", "reddit_scheduled_list", "reddit_scheduled_cancel"]) {
    assert.equal(takesInlineCredentials(by[t]), false, `${t} must not take inline credentials`);
    const nested = by[t].shape.request?.shape ? Object.keys(by[t].shape.request.shape) : [];
    for (const k of nested) assert.ok(!/session|loid|token|cookie|proxy|csrf/i.test(k), `${t}.request.${k} is credential-shaped`);
  }
  ok("catalog: paths, methods, write and destructive flags, cost sentences, no credential arguments");
}

// 2. both server modes list all four
{
  for (const inlineCredentials of [true, false]) {
    const client = await connect(async () => { throw new Error("no network"); }, { inlineCredentials });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const t of ["reddit_subreddit_flairs", "reddit_scheduled_create", "reddit_scheduled_list", "reddit_scheduled_cancel"]) {
      assert.ok(names.has(t), `${t} missing with inlineCredentials=${inlineCredentials}`);
    }
    await client.close();
  }
  ok("all four are listed with and without inline credentials");
}

// 3. flairs: a GET to the path with the name interpolated and no query
{
  const f = recordingFetch(200, { subreddit: "SaaS", flairs: [{ id: "a1b2", text: "Question", editable: false }], count: 1 });
  const client = await connect(f.impl);
  const r = await client.callTool({ name: "reddit_subreddit_flairs", arguments: { name: "SaaS" } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.test/api/reddit/sub/SaaS/flairs");
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].body, undefined);
  assert.match(r.content[0].text, /"flairs"/);
  await client.close();
  ok("flairs: GET /api/reddit/sub/SaaS/flairs, no body, answer passed through");
}

// 4. flairs with no session: the unbilled 503 gets a sentence that is not "upstream error", and is not retried
{
  const f = recordingFetch(503, { error: "session_required", code: "SESSION_REQUIRED", message: "Reddit lists this subreddit's post flairs only to signed-in accounts. This call was not charged." });
  const client = await connect(f.impl);
  const r = await client.callTool({ name: "reddit_subreddit_flairs", arguments: { name: "SaaS" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^HTTP 503 \(Reddit serves this only to a signed-in account/);
  assert.match(r.content[0].text, /Not charged/);
  assert.doesNotMatch(r.content[0].text, /upstream API error/);
  assert.equal(f.calls.length, 1, "a session_required 503 is not retried");
  await client.close();
  // Negative control: a 503 with another error keeps the upstream hint.
  assert.match(hintFor(503, "/api/reddit/sub/x/flairs", "upstream_unavailable"), /upstream API error/);
  assert.match(hintFor(503, "/api/reddit/sub/x/moderators", "session_required"), /signed-in account/);
  ok("flairs 503 SESSION_REQUIRED: named, not charged, not retried; other 503s keep the upstream hint");
}

// 5. schedule create: POST JSON body with type, run_at and the nested request, exactly as given
{
  const f = recordingFetch(201, { action: ACTION });
  const client = await connect(f.impl);
  const args = {
    type: "post",
    run_at: "2026-10-21T15:00:00Z",
    request: { subreddit: "SaaS", kind: "self", title: "t", text: "body", flair_id: "a1b2" },
  };
  const r = await client.callTool({ name: "reddit_scheduled_create", arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(f.calls[0].url, "https://api.test/api/reddit/schedule");
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].body), args);
  await client.close();

  // Unix seconds and a comment body travel unchanged too.
  const g = recordingFetch(201, { action: { ...ACTION, type: "comment" } });
  const c2 = await connect(g.impl);
  const args2 = { type: "comment", run_at: 1792000000, request: { post_url: "https://www.reddit.com/r/SaaS/comments/abc123/x/", text: "hi" } };
  const r2 = await c2.callTool({ name: "reddit_scheduled_create", arguments: args2 });
  assert.ok(!r2.isError, r2.content?.[0]?.text);
  assert.deepEqual(JSON.parse(g.calls[0].body), args2);
  await c2.close();
  ok("schedule create: POST /api/reddit/schedule with { type, run_at, request } (ISO and Unix seconds, post and comment)");
}

// 6. schedule create refuses a bad type before any request is sent
{
  const f = recordingFetch(201, { action: ACTION });
  const client = await connect(f.impl);
  const r = await client.callTool({ name: "reddit_scheduled_create", arguments: { type: "vote", run_at: "2026-10-21T15:00:00Z", request: {} } });
  assert.equal(r.isError, true);
  assert.equal(f.calls.length, 0, "an invalid type never reaches the API");
  await client.close();
  ok("schedule create: an unknown type is refused by the schema, no request sent");
}

// 7. schedule list: a GET with status and limit as the query
{
  const f = recordingFetch(200, { actions: [ACTION], count: 1 });
  const client = await connect(f.impl);
  const r = await client.callTool({ name: "reddit_scheduled_list", arguments: { status: "scheduled", limit: 10 } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/api/reddit/schedule");
  assert.equal(u.searchParams.get("status"), "scheduled");
  assert.equal(u.searchParams.get("limit"), "10");
  assert.equal(f.calls[0].method, "GET");
  await client.close();
  ok("schedule list: GET /api/reddit/schedule?status=scheduled&limit=10");
}

// 8. schedule cancel: POST { id }, and an unknown id gets the scheduled-action 404 sentence
{
  const f = recordingFetch(200, { cancelled: true, action: { ...ACTION, status: "cancelled" }, message: "Cancelled." });
  const client = await connect(f.impl);
  const r = await client.callTool({ name: "reddit_scheduled_cancel", arguments: { id: ACTION.id } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(f.calls[0].url, "https://api.test/api/reddit/schedule/cancel");
  assert.deepEqual(JSON.parse(f.calls[0].body), { id: ACTION.id });
  await client.close();

  const g = recordingFetch(404, { error: "No scheduled action with this id on this account.", code: "NOT_FOUND" });
  const c2 = await connect(g.impl);
  const r2 = await c2.callTool({ name: "reddit_scheduled_cancel", arguments: { id: ACTION.id } });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /No scheduled action with that id on this account/);
  assert.doesNotMatch(r2.content[0].text, /subreddit, post id/);
  await c2.close();

  const h = recordingFetch(200, {});
  const c3 = await connect(h.impl);
  const r3 = await c3.callTool({ name: "reddit_scheduled_cancel", arguments: { id: "not-a-uuid" } });
  assert.equal(r3.isError, true);
  assert.equal(h.calls.length, 0, "a non-UUID id never reaches the API");
  await c3.close();
  ok("schedule cancel: POST { id }; 404 names the scheduled action, not a subreddit; a non-UUID id is refused locally");
}

console.log(`flairs-schedule: ${n} passed, 0 failed`);
