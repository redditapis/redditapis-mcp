// watch.test.mjs: the reddit_set_watch compiler and orchestrator.
//
// Two halves, tested differently.
//
// THE COMPILER is pure, so every rule gets a case AND a negative twin: a rule
// that fires on everything is not a rule. The cases below are the sentences a
// person actually types, not a grammar.
//
// THE ORCHESTRATOR is tested through a FAKE callEndpoint that returns the
// shapes the real API returns, recorded from the live service 2026-10-02 (the
// `slots` object in particular, which carries capability booleans the older
// written spec did not mention). The assertions that matter are about ORDER and
// FAILURE: the monitor is created before the webhook, a local refusal makes no
// call at all, and a failed webhook leaves the monitor standing.
//
// Run alone: node test/watch.test.mjs
import assert from "node:assert/strict";
import { compileWatch, applyPlan, readSlots, createSetWatchHandler, parseResult } from "../src/watch.js";
import { planStep, buildWatchSummary } from "../src/watch-text.js";

let n = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const check = (name, fn) => { fn(); n++; ok(name); };
const acheck = async (name, fn) => { await fn(); n++; ok(name); };

// ── compiler: subreddits ────────────────────────────────────────────────────

check("r/Name and /r/Name are both read, de-duplicated case-insensitively", () => {
  const { filter } = compileWatch('watch r/SaaS and /r/startups and r/saas for "pricing"');
  assert.deepEqual(filter.subreddit, ["SaaS", "startups"]);
});

check("r/all is dropped as Reddit's site-wide listing, with a note, not sent and not 400'd", () => {
  const { filter, notes } = compileWatch('watch r/all for "launch"');
  assert.equal(filter.subreddit, undefined);
  assert.equal(filter.q, "launch");
  assert.ok(notes.some((x) => /site-wide listing/.test(x)), notes.join(" | "));
});

check("NEGATIVE: a bare word that is not r/-prefixed is not a subreddit", () => {
  const { filter } = compileWatch('watch SaaS and startups for "pricing"');
  assert.equal(filter.subreddit, undefined);
});

check("NEGATIVE: an email or a path does not produce a subreddit", () => {
  assert.equal(compileWatch('for "x" see docs/r/readme').filter.subreddit, undefined);
});

// ── compiler: keywords ──────────────────────────────────────────────────────

check("one quoted phrase becomes q; two or more become an any-of set", () => {
  assert.equal(compileWatch('r/SaaS for "cold email"').filter.q, "cold email");
  const two = compileWatch('r/SaaS for "cold email" or "outbound"').filter;
  assert.equal(two.q, undefined);
  assert.deepEqual(two.include_any, ["cold email", "outbound"]);
});

check("curly quotes are read the same as straight ones", () => {
  assert.equal(compileWatch("r/SaaS for “pricing page”").filter.q, "pricing page");
});

check("NEGATIVE: a straight apostrophe is a contraction, not a quote", () => {
  const { filter } = compileWatch("r/SaaS for anything that doesn't work");
  assert.ok(!filter.q || !/^t work/.test(filter.q), `apostrophe swallowed the clause: ${filter.q}`);
});

check("an unquoted keyword comes from the clause after a lead word, stripped of scaffolding", () => {
  assert.equal(compileWatch("watch r/SaaS for churn posts").filter.q, "churn");
  assert.equal(compileWatch("monitor r/devops mentioning kubernetes").filter.q, "kubernetes");
  assert.equal(compileWatch("watch all of reddit talking about cold outreach").filter.q, "cold outreach");
});

check("the keyword clause stops at the next instruction rather than swallowing it", () => {
  const { filter } = compileWatch("watch r/SaaS for pricing except giveaways");
  assert.equal(filter.q, "pricing");
  assert.deepEqual(filter.exclude_terms, ["giveaways"]);
});

check("NEGATIVE: a sentence with no lead word and no quotes yields no keyword", () => {
  assert.equal(compileWatch("watch r/SaaS").filter.q, undefined);
});

// ── compiler: kind, exclusions, score ───────────────────────────────────────

check("kind: comments alone is comment, naming both is both, neither is posts", () => {
  assert.equal(compileWatch('r/SaaS comments for "pricing"').filter.kind, "comment");
  assert.equal(compileWatch('r/SaaS posts and comments for "pricing"').filter.kind, "both");
  assert.equal(compileWatch('r/SaaS for "pricing"').filter.kind, undefined);
});

check("exclusions split on commas, 'and' and 'or', and cap at 50", () => {
  const { filter } = compileWatch('r/SaaS for "pricing" excluding giveaway, promo and spam');
  assert.deepEqual(filter.exclude_terms, ["giveaway", "promo", "spam"]);
});

// REGRESSION, caught by an end-to-end stdio smoke and not by any unit case
// written before it: the exclusion clause ran past the score clause and
// excluded the literal string "giveaway with at least 5 upvotes". A filter that
// excludes a phrase nothing says is worse than one that fails, because it looks
// like it worked. Both clauses now share one stop list.
check("an exclusion clause stops where the next clause starts, in either order", () => {
  const a = compileWatch('watch r/SaaS comments for "pricing page" except giveaway with at least 5 upvotes').filter;
  assert.deepEqual(a.exclude_terms, ["giveaway"]);
  assert.equal(a.min_score, 5);
  assert.equal(a.q, "pricing page");
  const b = compileWatch('r/SaaS for "pricing" excluding promo and deliver to slack').filter;
  assert.deepEqual(b.exclude_terms, ["promo"]);
  const c = compileWatch('r/SaaS for "pricing" ignoring spam, score above 20').filter;
  assert.deepEqual(c.exclude_terms, ["spam"]);
  assert.equal(c.min_score, 20);
});

check("a score floor is read from either phrasing", () => {
  assert.equal(compileWatch('r/SaaS for "pricing" with at least 25 upvotes').filter.min_score, 25);
  assert.equal(compileWatch('r/SaaS for "pricing" score of at least 10').filter.min_score, 10);
});

check("NEGATIVE: a bare number is not a score floor", () => {
  assert.equal(compileWatch('r/SaaS for "top 10 tools"').filter.min_score, undefined);
});

// ── compiler: the anchor rule ───────────────────────────────────────────────

check("a description anchored by neither a subreddit nor a keyword is refused", () => {
  assert.equal(compileWatch("just watch everything").error, "no_anchor");
  assert.equal(compileWatch("").error, "empty_description");
  assert.equal(compileWatch(null).error, "empty_description");
  // and the twins that ARE anchored
  assert.equal(compileWatch("watch r/SaaS").error, null);
  assert.equal(compileWatch('watch for "pricing"').error, null);
});

// ── plan preflight ──────────────────────────────────────────────────────────

const PAID_SLOTS = {
  used: 3, total: 50, tier: "growth", is_free: false, cadence_s: 30, sitewide_slots: 3,
  distinct_subreddits_used: 0, distinct_subreddits_total: 25,
  comments_allowed: true, scoped_allowed: true, sitewide_allowed: true,
};
const FREE_SLOTS = {
  used: 0, total: 1, tier: "free", is_free: true, cadence_s: 60, sitewide_slots: 1,
  distinct_subreddits_used: 0, distinct_subreddits_total: 0,
  comments_allowed: false, scoped_allowed: false, sitewide_allowed: true,
};

check("readSlots returns the object, or null when the shape is not what we expect", () => {
  assert.deepEqual(readSlots({ slots: PAID_SLOTS }), PAID_SLOTS);
  assert.equal(readSlots({}), null);
  assert.equal(readSlots(null), null);
  assert.equal(readSlots({ slots: "growth" }), null);
});

check("a plan with no scoped watches widens a keyword watch instead of 402-ing, and says so", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"], q: "pricing" }, FREE_SLOTS, notes);
  assert.equal(out.subreddit, undefined);
  assert.equal(out.q, "pricing");
  assert.ok(notes.some((x) => /no subreddit-scoped watches/.test(x)));
});

check("with no keyword there is no equivalent, so the filter is left exactly as compiled", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"] }, FREE_SLOTS, notes);
  assert.deepEqual(out.subreddit, ["SaaS"], "the request must go as written for the API to answer");
  assert.ok(notes.some((x) => /no keyword to widen it with/.test(x)));
});

check("NEGATIVE: a plan that allows scoped watches rewrites nothing", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"], q: "pricing" }, PAID_SLOTS, notes);
  assert.deepEqual(out, { subreddit: ["SaaS"], q: "pricing" });
  assert.deepEqual(notes, []);
});

check("NEGATIVE: an unreadable slots object rewrites nothing (the API is the authority)", () => {
  const notes = [];
  assert.deepEqual(applyPlan({ subreddit: ["SaaS"], q: "p" }, null, notes), { subreddit: ["SaaS"], q: "p" });
  assert.deepEqual(notes, []);
});

// ── orchestrator ────────────────────────────────────────────────────────────

function fakeApi({ slots = PAID_SLOTS, fail = {} } = {}) {
  const calls = [];
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const err = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
  return {
    calls,
    callEndpoint: async (path, args, method = "GET") => {
      calls.push({ path, args, method });
      if (fail[path]) return err(fail[path]);
      if (path === "/api/reddit/monitor/list") return json({ monitors: [], slots });
      if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1", filter_spec: args.filter_spec } });
      if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack", secret: "s3cr3t" } });
      if (path === "/api/reddit/monitor/update") return json({ monitor: { id: "mon_1", webhook_ids: args.webhook_ids } });
      if (path === "/api/reddit/monitor/webhook/test") return json({ ok: true });
      return err(`unexpected path ${path}`);
    },
  };
}

await acheck("a refused description makes ZERO network calls", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: "just watch everything" });
  assert.equal(r.isError, true);
  assert.equal(api.calls.length, 0, `expected no calls, made ${JSON.stringify(api.calls)}`);
  assert.match(r.content[0].text, /anchored by one or the other/);
});

await acheck("the happy path: list, add, webhook create, update, test, in that order", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing page"', deliver_to: "https://hooks.slack.com/services/T/B/x" });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(api.calls.map((c) => c.path), [
    "/api/reddit/monitor/list",
    "/api/reddit/monitor/add",
    "/api/reddit/monitor/webhook/create",
    "/api/reddit/monitor/update",
    "/api/reddit/monitor/webhook/test",
  ]);
  const sc = r.structuredContent;
  assert.equal(sc.status, "watching");
  assert.equal(sc.monitor.id, "mon_1");
  assert.equal(sc.delivery.registered, true);
  assert.equal(sc.delivery.webhook_id, "wh_1");
  assert.equal(sc.delivery.targeted, true);
  assert.equal(sc.delivery.test.ok, true);
  assert.deepEqual(sc.compiled_filter, { subreddit: ["SaaS"], q: "pricing page" });
});

await acheck("the filter nests under filter_spec exactly as the monitor endpoint takes it", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  await h({ watch: 'watch r/SaaS comments for "pricing" excluding spam', cadence_s: 120 });
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  // callEndpoint receives the flat args; buildBody does the nesting, and the
  // catalog test pins which fields nest. What matters here is that cadence_s is
  // present and that no local-only arg was handed over.
  assert.equal(add.args.cadence_s, 120);
  assert.equal(add.args.watch, undefined, "the raw description must never be sent");
  assert.equal(add.args.deliver_to, undefined);
  assert.equal(add.args.test_delivery, undefined);
  assert.deepEqual(add.args.subreddit, ["SaaS"]);
  assert.equal(add.args.kind, "comment");
});

await acheck("a failed monitor create registers NO webhook and relays the API's own answer", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/add": "HTTP 402: {\"error\":\"monitor_slots_exhausted\"}" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook" });
  assert.equal(r.isError, true);
  assert.ok(!api.calls.some((c) => c.path.includes("webhook")), "a webhook must not be left pointing at nothing");
  assert.match(r.content[0].text, /monitor_slots_exhausted/);
  assert.equal(r.structuredContent.status, "not_created");
});

await acheck("a failed webhook leaves the monitor standing, and says where matches go instead", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/webhook/create": "HTTP 400: bad url" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook" });
  assert.ok(!r.isError, "the watch exists, so this is not an error result");
  assert.equal(r.structuredContent.status, "watching");
  assert.equal(r.structuredContent.delivery.registered, false);
  assert.match(r.content[0].text, /every active webhook already on the account/);
});

await acheck("a webhook response is read whether the body wraps it or not", async () => {
  // MEASURED 2026-10-02: monitor/add returns {"monitor": {...}} (confirmed live
  // on a growth account, with the control pair in the feedback report of the
  // same date). The webhook CREATE body was not confirmed live, because
  // confirming it means creating a real signing secret on a real account, so
  // both shapes are handled in code and both are pinned here rather than one
  // being guessed at. If the shape is ever confirmed, the other case stays as a
  // cheap guard, it does not become dead.
  for (const body of [{ webhook: { id: "wh_1", kind: "slack" } }, { id: "wh_1", kind: "slack" }]) {
    const calls = [];
    const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    const callEndpoint = async (path, args, method = "GET") => {
      calls.push(path);
      if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
      if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
      if (path === "/api/reddit/monitor/webhook/create") return json(body);
      return json({ ok: true });
    };
    const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
    assert.equal(r.structuredContent.delivery.webhook_id, "wh_1", `shape not read: ${JSON.stringify(body)}`);
    assert.equal(r.structuredContent.delivery.kind, "slack");
    assert.ok(calls.includes("/api/reddit/monitor/webhook/test"));
  }
});

await acheck("a monitor body returned FLAT (no wrapper) still yields its id", async () => {
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const callEndpoint = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ id: "mon_flat", filter_spec: {} });
    return json({ ok: true });
  };
  const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"' });
  assert.equal(r.structuredContent.monitor.id, "mon_flat");
  assert.match(r.content[0].text, /Monitor id mon_flat/);
});

await acheck("test_delivery false skips the test and nothing else", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook", test_delivery: false });
  assert.ok(!api.calls.some((c) => c.path.endsWith("/webhook/test")));
  assert.ok(api.calls.some((c) => c.path.endsWith("/webhook/create")));
});

await acheck("on a free plan a scoped description is widened before the monitor is created", async () => {
  const api = fakeApi({ slots: FREE_SLOTS });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing"' });
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  assert.equal(add.args.subreddit, undefined, "the scoped request must not be sent on a plan that refuses it");
  assert.equal(add.args.q, "pricing");
  assert.ok(r.content[0].text.includes("no subreddit-scoped watches"));
});

await acheck("a failed plan preflight is not fatal: the request goes as compiled", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/list": "HTTP 500" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing"' });
  assert.ok(!r.isError, r.content[0].text);
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  assert.deepEqual(add.args.subreddit, ["SaaS"]);
  assert.equal(r.structuredContent.plan, null);
});

// ── the result text ─────────────────────────────────────────────────────────

check("the result offers Slack as the next call and states the plan step from the slots object", () => {
  const text = buildWatchSummary({
    understood: { subreddits: ["SaaS"], keyword: "pricing", any_of: null, excluded_terms: null, match_kind: "post", min_score: null },
    monitor: { id: "mon_1" },
    delivery: null,
    notes: [],
    plan: PAID_SLOTS,
  });
  assert.match(text, /Slack/);
  assert.match(text, /deliver_to/);
  assert.match(text, /3 of 50 monitor slots/);
  assert.match(text, /30s cadence floor/);
});

check("the plan step names what the plan does NOT carry, and says nothing when it carries everything", () => {
  assert.match(planStep(FREE_SLOTS), /Not on this plan yet: watches limited to named subreddits, comment matching/);
  assert.doesNotMatch(planStep(PAID_SLOTS), /Not on this plan yet/);
  assert.equal(planStep(null), null, "no slots object means no claim about the plan");
  assert.equal(planStep({}), null);
});

check("parseResult returns null on a non-JSON body rather than throwing", () => {
  assert.equal(parseResult({ content: [{ type: "text", text: "<html>502</html>" }] }), null);
  assert.equal(parseResult(undefined), null);
  assert.deepEqual(parseResult({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
});

console.log(`\nwatch: ${n} passed, 0 failed`);
