// Unit tests for the tool catalog + query/path builders. No server or network:
// validates every tool is well-formed and that buildQuery/buildPath are correct,
// so the catalog can't regress without the test spawning stdio or hitting the API.
import assert from "node:assert/strict";
import { TOOLS, buildQuery, buildPath } from "../src/tools.js";

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

check("catalog covers the 12 read endpoints", () => {
  assert.equal(TOOLS.length, 12);
});

check("every path param {x} has a matching shape key", () => {
  for (const t of TOOLS) {
    const params = [...t.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of params) assert.ok(p in t.shape, `${t.name}: path param {${p}} has no shape entry`);
  }
});

check("no tool is marked write/destructive (this is a reads MCP)", () => {
  for (const t of TOOLS) {
    assert.ok(!t.write, `${t.name} unexpectedly write`);
    assert.ok(!t.destructive, `${t.name} unexpectedly destructive`);
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
