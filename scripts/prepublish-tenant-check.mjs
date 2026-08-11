#!/usr/bin/env node
// prepublishOnly gate: proves the files npm is ABOUT TO PUBLISH carry no
// foreign-tenant identity, before they leave this machine.
//
// Scanning `apps/mcp/` directly (the naive version of this check) always
// false-positives: AGENTS.md self-referentially explains that this directory
// sits inside `officialForkoff/reddit-api`, and the parent checkout's own git
// remote resolves to that repo too. Neither ships. So this assembles the
// REAL publish set -- exactly what `npm pack` would put in the tarball, read
// from npm itself via `--dry-run --json` rather than hand-copied from the
// `files` field in package.json, which would silently go stale if `files`
// ever changed here without this script being updated too -- into a scratch
// directory and scans only that.
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG_ROOT, encoding: "utf8" });
const [{ files }] = JSON.parse(packJson);
const paths = files.map((f) => f.path);

const scratch = mkdtempSync(join(tmpdir(), "redditapis-mcp-prepublish-"));
const dest = join(scratch, "package");
mkdirSync(dest, { recursive: true });
for (const rel of paths) {
  const src = join(PKG_ROOT, rel);
  const out = join(dest, rel);
  mkdirSync(dirname(out), { recursive: true });
  cpSync(src, out);
}

let ok = false;
try {
  execFileSync(
    "python3",
    [join(process.env.HOME, ".claude/scripts/tenant-isolation-scan.py"), "--tenant", "redditapis", "--path", dest],
    { stdio: "inherit" },
  );
  ok = true;
} catch {
  ok = false;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (!ok) {
  console.error("\n[prepublish-tenant-check] BLOCKED: the publish set failed the tenant isolation scan. Not publishing.");
  process.exit(1);
}
console.log(`[prepublish-tenant-check] PASS: ${paths.length} publish-set file(s) clean of foreign-tenant identity.`);
