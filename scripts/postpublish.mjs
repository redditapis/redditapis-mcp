#!/usr/bin/env node
// postpublish.mjs: everything that must happen after `npm publish`, each step
// run to the end whatever the previous one did, and the exit code the worst of
// them. Two steps, two separate failures:
//
//   1. scripts/registry-drift.mjs --publish   the official MCP registry entry
//   2. scripts/hosted-hub-parity.mjs          does the hosted hub still state the OLD tool count?
//
// `a && b` would skip the hub check whenever the registry step failed, and a
// registry lag (measured, minutes) is the common case right after a publish.
// npm has already published when this runs, so nothing here is reversible; the
// job is to tell the publisher plainly what is still behind.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm 10 runs postpublish even under `npm publish --dry-run`; nothing here may run then,
// because registry-drift --publish would push the MCP Registry entry for real.
if (process.env.npm_config_dry_run === "true") {
  console.log("[postpublish] dry-run: skipped");
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STEPS = [
  ["official MCP registry", ["scripts/registry-drift.mjs", "--publish"]],
  ["hosted hub tool count", ["scripts/hosted-hub-parity.mjs"]],
];

let worst = 0;
for (const [label, argv] of STEPS) {
  console.log(`[postpublish] ${label}: node ${argv.join(" ")}`);
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: "inherit" });
  const code = typeof r.status === "number" ? r.status : 2;
  console.log(`[postpublish] ${label}: exit ${code}`);
  worst = Math.max(worst, code);
}
if (worst !== 0) console.error(`[postpublish] ${worst === 2 ? "a step could not evaluate" : "a step reports drift"}: see above. The npm publish itself already succeeded.`);
process.exit(worst);
