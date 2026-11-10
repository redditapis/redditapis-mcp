// server.json must satisfy the MCP Registry schema limits it declares (2025-12-11: description maxLength 100).
// 0.20.2's first cut was 183 characters and would have been rejected at publish; nothing else checked it.
import assert from "node:assert";
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.ok(typeof s.description === "string" && s.description.length >= 1 && s.description.length <= 100, `server.json description must be 1..100 chars, got ${s.description.length}`);
assert.ok(typeof s.title === "string" && s.title.length <= 100, "server.json title must be <= 100 chars");
assert.strictEqual(s.version, pkg.version, "server.json version matches package.json");
assert.ok(pkg.description.length <= 255, `package.json description must be <= 255 chars (npm truncates silently), got ${pkg.description.length}`);
for (const p of s.packages || []) assert.strictEqual(p.version, pkg.version, "each package entry's version matches package.json");
console.log(`server-json-limits: description ${s.description.length} chars, version ${s.version}: ok`);
