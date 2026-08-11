// Unit tests for the tool catalog + query/path builders. No server or network:
// validates every tool is well-formed and that buildQuery/buildPath are correct,
// so the catalog can't regress without the test spawning stdio or hitting the API.
import assert from "node:assert/strict";
import { TOOLS, buildQuery, buildPath, buildBody } from "../src/tools.js";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`PASS  ${name}`); };

check("every tool has a unique name, path, description, and shape", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.ok(t.name && /^reddit_[a-z_]+$/.test(t.name), `bad name: ${t.name}`);
    assert.ok(!names.has(t.name), `duplicate name: ${t.name}`);
    names.add(t.name);
    assert.ok(t.path && t.path.startsWith("/api/reddit/"), `bad path: ${t.path}`);
    assert.ok(typeof t.description === "string" && t.description.length > 40, `weak description: ${t.name}`);
    assert.ok(t.shape && typeof t.shape === "object", `missing shape: ${t.name}`);
  }
});

check("catalog covers the 22 read endpoints plus 10 monitor/webhook management tools", () => {
  assert.equal(TOOLS.length, 32);
});

check("every path param {x} has a matching shape key", () => {
  for (const t of TOOLS) {
    const params = [...t.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of params) assert.ok(p in t.shape, `${t.name}: path param {${p}} has no shape entry`);
  }
});

// This used to be "no tool is marked write/destructive" -- a hard invariant
// that the whole catalog was reads-only. Monitor/webhook management (2026-08-11,
// task #43) deliberately breaks that: those tools configure the caller's OWN
// redditapis.com account (an alerting subscription), never Reddit itself, so
// they are a different risk class from the comment/vote/DM writes this catalog
// still excludes. The invariant that survives: every GET tool is still a pure
// read, and every write is one of the 10 named monitor/webhook tools -- so a
// future addition can't silently start mutating state without being caught here.
const WRITE_TOOL_NAMES = new Set([
  "reddit_monitor_add", "reddit_monitor_update", "reddit_monitor_remove",
  "reddit_monitor_webhook_create", "reddit_monitor_webhook_test", "reddit_monitor_webhook_delete",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set(["reddit_monitor_remove", "reddit_monitor_webhook_delete"]);

check("only the 6 named monitor/webhook tools are writes; everything else is a pure read", () => {
  for (const t of TOOLS) {
    const method = t.method || "GET";
    if (WRITE_TOOL_NAMES.has(t.name)) {
      assert.equal(method, "POST", `${t.name}: a write tool must be POST`);
      assert.ok(t.write === true, `${t.name}: expected write: true`);
    } else {
      assert.equal(method, "GET", `${t.name}: expected a plain read (GET)`);
      assert.ok(!t.write, `${t.name} unexpectedly marked write`);
    }
  }
  // Every name in the allowlist must actually exist in the catalog -- catches
  // a rename that would otherwise leave this check vacuously passing.
  const names = new Set(TOOLS.map((t) => t.name));
  for (const n of WRITE_TOOL_NAMES) assert.ok(names.has(n), `expected write tool ${n} not found in catalog`);
});

check("only remove/delete tools are destructive", () => {
  for (const t of TOOLS) {
    assert.equal(Boolean(t.destructive), DESTRUCTIVE_TOOL_NAMES.has(t.name), `${t.name}: destructive flag mismatch`);
  }
});

check("every write tool's filterSpecFields (if any) are all present in its own shape", () => {
  for (const t of TOOLS) {
    for (const f of t.filterSpecFields || []) {
      assert.ok(f in t.shape, `${t.name}: filterSpecFields names "${f}" but shape has no such key`);
    }
  }
});

check("buildQuery skips empty/null/undefined and stringifies", () => {
  assert.equal(buildQuery({ a: 1, b: "x", c: undefined, d: null, e: "" }), "a=1&b=x");
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery(null), "");
  assert.equal(buildQuery({ q: "rust vs go" }), "q=rust+vs+go");
});

check("buildPath interpolates path params and removes them from the query rest", () => {
  const r = buildPath("/api/reddit/sub/{name}/top", { name: "science", t: "week", limit: 5 });
  assert.equal(r.path, "/api/reddit/sub/science/top");
  assert.deepEqual(r.rest, { t: "week", limit: 5 });
});

check("buildPath url-encodes path params and leaves non-templated paths untouched", () => {
  assert.equal(buildPath("/api/reddit/user/{name}", { name: "a b/c" }).path, "/api/reddit/user/a%20b%2Fc");
  const r = buildPath("/api/reddit/posts", { subreddit: "x", sort: "top" });
  assert.equal(r.path, "/api/reddit/posts");
  assert.deepEqual(r.rest, { subreddit: "x", sort: "top" });
});

check("a missing path param resolves to empty rather than throwing", () => {
  assert.equal(buildPath("/api/reddit/post/{id}", {}).path, "/api/reddit/post/");
});

check("buildBody nests filterSpecFields under filter_spec and leaves the rest top-level", () => {
  const tool = { filterSpecFields: ["subreddit", "q"] };
  const body = buildBody(tool, { subreddit: ["SaaS"], q: "launch", cadence_s: 300, baseline_item_id: undefined });
  assert.deepEqual(body, { cadence_s: 300, filter_spec: { subreddit: ["SaaS"], q: "launch" } });
});

check("buildBody omits filter_spec entirely when no filterSpecFields are present in args", () => {
  assert.deepEqual(buildBody({ filterSpecFields: ["subreddit", "q"] }, { id: "mon_1", active: false }), { id: "mon_1", active: false });
});

check("buildBody with no filterSpecFields declared sends everything top-level", () => {
  assert.deepEqual(buildBody({}, { id: "wh_1" }), { id: "wh_1" });
});

check("buildBody drops undefined but keeps false/0/empty-string args (real values, not omissions)", () => {
  assert.deepEqual(buildBody({}, { active: false, min_score: 0, group: "", skip: undefined }), { active: false, min_score: 0, group: "" });
});

check("search tools describe `t` as applying to 'relevance' (bug #11), listings keep the top/controversial caveat", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  // Reddit's SEARCH endpoint applies `t` to the whole result set, including the
  // 'relevance' and 'top' sorts, so the tool must NOT tell callers it is ignored,
  // and should steer them to bound a broad relevance query (else old viral posts win).
  for (const n of ["reddit_search", "reddit_search_comments", "reddit_search_media"]) {
    const d = byName[n].shape.t.description;
    assert.ok(typeof d === "string" && d.length > 0, `${n}: t has no description`);
    assert.doesNotMatch(d, /ignored for other sorts/i, `${n}: t must not claim it is ignored for relevance search`);
    assert.match(d, /relevance/i, `${n}: t description should say it applies to relevance`);
  }
  // A subreddit LISTING really does restrict `t` to top/controversial, so keep that.
  assert.match(
    byName["reddit_subreddit_posts"].shape.t.description,
    /top.*controversial/i,
    "reddit_subreddit_posts: listing t should keep the top/controversial caveat",
  );
});

console.log(`\n==== ${pass} tests passed ====`);
