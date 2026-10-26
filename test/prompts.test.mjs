// prompts/list and prompts/get carry every playbook (capability parity with the
// sibling API product, row #45). A client with tools and resources but no
// prompts has nothing to offer as a slash command; this pins that each playbook
// is listed, titled, described, and served as the same bytes resources/read gives.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { PLAYBOOKS, playbookUri } from "../src/playbooks.js";

let pass = 0;
const ok = (m) => { pass += 1; console.log(`  [ok  ] ${m}`); };

async function connect() {
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl: async () => { throw new Error("no network in this test"); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const client = await connect();

{
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), PLAYBOOKS.map((p) => p.name), "prompts/list must carry every playbook, in order");
  for (const p of prompts) assert.ok(p.title && p.description && p.description.length > 80, `${p.name} needs a title and a real description`);
  ok(`prompts/list carries all ${prompts.length} playbooks, each titled and described`);
}

{
  for (const p of PLAYBOOKS) {
    // `arguments` is optional on prompts/get: the call that leaves it out must work.
    const got = await client.request({ method: "prompts/get", params: { name: p.name } }, GetPromptResultSchema);
    const res = got.messages.find((m) => m.content.type === "resource");
    assert.ok(res, `${p.name}: the prompt must embed the playbook as a resource`);
    assert.equal(res.content.resource.uri, playbookUri(p.slug));
    assert.equal(res.content.resource.text, p.body, `${p.name}: the prompt's text must be the playbook's bytes`);
    const read = await client.readResource({ uri: playbookUri(p.slug) });
    assert.equal(read.contents[0].text, res.content.resource.text, `${p.name}: prompt and resources/read must serve the same bytes`);
  }
  ok("prompts/get works with no arguments field and serves each playbook as the bytes resources/read gives");
}

{
  await assert.rejects(client.request({ method: "prompts/get", params: { name: "no_such_playbook" } }, GetPromptResultSchema), /not found|unknown|No such/i, "an unknown prompt must be refused");
  ok("an unknown prompt name is refused");
}

console.log(`\n${pass}/3 passed.`);
await client.close();
