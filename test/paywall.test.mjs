// paywall.test.mjs: a missing key, a rejected key and an empty balance come back
// as an agent-actionable payload (needs + the exact page to send the user to),
// in the text every client reads AND as structuredContent. Any other failure
// keeps its existing hint, so a 500 is never dressed up as "top up".
import assert from "node:assert/strict";
import { createServer, paywallFor, SIGNUP_URL, TOP_UP_URL, API_KEYS_URL } from "../src/server.js";

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

function fakeFetch(status, body = "{}") {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  });
}
const payloadOf = (r) => JSON.parse(r.content[0].text.split("\n\n").pop());

// No key at all: an account is what is needed, and the text still names the key.
{
  const s = createServer({ apiKey: undefined, baseUrl: "https://api.test", fetchImpl: fakeFetch(200) });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Missing REDDITAPIS_KEY/);
  assert.equal(r.structuredContent.needs, "account");
  assert.equal(r.structuredContent.action_url, SIGNUP_URL);
  assert.deepEqual(payloadOf(r), r.structuredContent);
  ok("no key: needs=account, signup URL, same payload in text and structuredContent");
}

// 402: out of credits, send the user to top up, and say the failed call was not charged.
{
  const s = createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl: fakeFetch(402, '{"error":"insufficient_credits"}') });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.structuredContent.needs, "credits");
  assert.equal(r.structuredContent.action_url, TOP_UP_URL);
  assert.match(r.content[0].text, /out of credits/);
  assert.match(r.content[0].text, /HTTP 402/);
  ok("402: needs=credits, top-up URL, upstream status kept as detail");
}

// 401: a rejected key, point at the key page rather than signup.
{
  const s = createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl: fakeFetch(401) });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.structuredContent.needs, "valid_key");
  assert.equal(r.structuredContent.action_url, API_KEYS_URL);
  ok("401: needs=valid_key, API keys URL");
}

// CONTROL: a 500 is not a paywall and keeps the ordinary hint.
{
  const s = createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl: fakeFetch(500) });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.structuredContent, undefined);
  assert.match(r.content[0].text, /^HTTP 500/);
  assert.equal(paywallFor(500), null);
  ok("control: a 500 carries no paywall payload");
}

// Every paywall URL is on the product's own site, over https.
for (const u of [SIGNUP_URL, TOP_UP_URL, API_KEYS_URL]) assert.match(u, /^https:\/\/www\.redditapis\.com\//);
ok("every paywall URL is https on www.redditapis.com");

console.log(`\npaywall: ${n} passed, 0 failed`);
