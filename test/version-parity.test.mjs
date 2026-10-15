// server.json is what the official MCP registry publishes from. Its two version
// fields must equal package.json, or a release advertises an old tool surface.
// prepublishOnly also checks this, but only at publish time, after the merge:
// 0.10.3 merged with server.json still at 0.10.2 (2026-10-15). This test runs
// the same comparison in `npm test`, so the mismatch fails before the merge.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const srv = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

assert.equal(srv.version, pkg.version, "server.json version must equal package.json version");
assert.equal(srv.packages?.[0]?.version, pkg.version, "server.json packages[0].version must equal package.json version");
console.log(`version-parity: package.json and server.json (x2) all ${pkg.version}`);
