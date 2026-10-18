// read-price.test.mjs: the instructions never name a read price the caller did
// not pass (backlog #102). The hosted server passes the rate its billing charges;
// the local server names no figure. A published "$0.002" here went stale the day
// read plans moved the read rate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, buildInstructions, readPriceSentence, INSTRUCTIONS } from "../src/server.js";

let pass = 0;
const ok = (n) => { pass += 1; console.log(`  ok  ${n}`); };

async function instructionsOf(opts) {
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl: async () => { throw new Error("no network"); }, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = client.getInstructions();
  await client.close();
  return text;
}

{
  const hosted = await instructionsOf({ inlineCredentials: false, readRateUsd: 0.0015 });
  assert.match(hosted, /\(most \$0\.0015\)/);
  assert.ok(!/\$0\.002(?![0-9])/.test(hosted), "the hosted server at the launch rate never says $0.002");
  const today = await instructionsOf({ inlineCredentials: false, readRateUsd: 0.002 });
  assert.match(today, /\(most \$0\.002\)/);
  ok("the hosted server names exactly the rate it is given");
}

{
  const local = await instructionsOf({});
  assert.equal(local, INSTRUCTIONS);
  assert.ok(!/\$0\.00/.test(local), "the local server names no read figure");
  assert.match(local, /prices: redditapis\.com\/pricing/);
  ok("the local server names no figure and points at the pricing page");
}

{
  for (const bad of [undefined, null, "", "0.0015", 0, -1, NaN, Infinity]) {
    const s = readPriceSentence(bad);
    if (bad === "0.0015") { assert.match(s, /\$0\.0015/); continue; }
    assert.match(s, /pricing/, `rate ${String(bad)} must fall back to the figure-free sentence`);
  }
  assert.equal(buildInstructions({ readRateUsd: 0.0015 }).startsWith("redditapis.com MCP server. Read tools bill per call (most $0.0015)"), true);
  ok("a missing, non-positive or non-finite rate falls back to the figure-free sentence");
}

{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\$0\.00\d/.test(src), "src/server.js must not write a read price literal");
  ok("no read price literal in the server source");
}

console.log(`read-price: ${pass} passed, 0 failed`);
