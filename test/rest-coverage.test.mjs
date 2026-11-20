// Every documented REST route the feedback named has an MCP tool (feedback a62b44d6, 2026-11-19).
//
// Run: node test/rest-coverage.test.mjs
//
// THE GAP. DM threads and messages, comment by id, expanded comments, can-post, the two batch reads and login were
// documented REST routes with no tool, so an agent on MCP alone could not reach them; nothing failed, the capability
// was simply absent. This pins each route to a tool by method and path, plus the session check that shipped beside
// them, and that the read-shaped ones are not marked as writes.
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools.js";

const REQUIRED = [
  ["POST", "/api/reddit/dm/threads", false],
  ["POST", "/api/reddit/dm/messages", false],
  ["GET", "/api/reddit/comment/{id}", false],
  ["GET", "/api/reddit/post/{id}/comments/expanded", false],
  ["GET", "/api/reddit/sub/{name}/can-post", false],
  ["GET", "/api/reddit/subreddits/batch", false],
  ["GET", "/api/reddit/users/batch", false],
  ["POST", "/api/reddit/login", true],
];

let n = 0;
for (const [method, path, write] of REQUIRED) {
  const tool = TOOLS.find((t) => (t.method || "GET") === method && t.path === path);
  assert.ok(tool, `no MCP tool for ${method} ${path}`);
  assert.equal(Boolean(tool.write), write, `${tool.name}: write flag`);
  n++;
}
const threads = TOOLS.find((t) => t.path === "/api/reddit/dm/threads");
assert.ok(threads.shape.limit && threads.shape.after, "reddit_dm_threads exposes the limit/after paging");
console.log(`ok ${n} documented REST routes each have an MCP tool; DM threads page with limit/after`);
