// remote-host.test.mjs: what a remote MCP host needs from this package.
//   - `redditapis-mcp/server` resolves to createServer (the subpath export)
//   - authHeaders replace the API key: sent on every call, no Authorization, no
//     "missing key" paywall
//   - a read that lands in an API restart (the gateway's HTML 502/503/504, or a
//     refused connection) is retried; JSON errors other than the read-side 503
//     upstream_unavailable / 408 and 503 upstream_timeout (one retry each), transport
//     timeouts and writes are not
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

const { createServer } = await import("redditapis-mcp/server");
assert.equal(typeof createServer, "function");
ok("the ./server subpath export resolves to createServer");

const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>\r\n";

function seq(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    if (r.hang) {
      // Never answers; settles only when the client aborts its own timer.
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (r.onCall) r.onCall();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] ?? null }, text: async () => r.body };
  };
  return { fetchImpl, calls };
}
const sleeps = [];
const mk = (fetchImpl, extra = {}) =>
  createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); }, retryDelaysMs: [3, 8], ...extra });

{
  const { fetchImpl, calls } = seq([{ status: 200, body: "{}" }]);
  const s = mk(fetchImpl, { apiKey: undefined, authHeaders: { "x-internal-secret": "s", "x-internal-key-id": "kid" } });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].headers["x-internal-key-id"], "kid");
  assert.equal(calls[0].headers.Authorization, undefined);
  ok("authHeaders are sent instead of the API key, and no missing-key paywall fires");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }, { status: 200, body: '{"posts":[]}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [3]);
  ok("a read that hits the gateway's HTML 502 is retried and returns the real answer");
}
{
  sleeps.length = 0;
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const { fetchImpl, calls } = seq([refused, { status: 503, body: "<!DOCTYPE html><html>503</html>" }, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [3, 8]);
  ok("a refused connection then an HTML 503 are ridden out within two retries");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 3);
  ok("retries are bounded: after two, the gateway error is reported as before");
}
{
  const { fetchImpl, calls } = seq([{ status: 502, body: '{"error":"Auth backend error"}' }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("the API's own JSON 502 is never retried");
}
{
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/submit", { subreddit: "test", title: "t" }, "POST");
  assert.equal(calls.length, 1);
  ok("a WRITE is never retried, even through a gateway 502");
}
// 0.10.1: the API's own transient 503 upstream_unavailable on a READ gets ONE retry
// after its retry_after; a 429 too_many_concurrent_reads never does.
const API_503 = '{"error":"upstream_unavailable","message":"This request could not be completed right now. It was not billed. Please retry shortly.","retry_after":2}';
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503 }, { status: 200, body: '{"posts":[]}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000], "waits the body's retry_after seconds, not the gateway delays");
  ok("a read refused with the API's JSON 503 upstream_unavailable is retried once and returns the real answer");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 2, "exactly one retry, then the error is reported");
  assert.match(r.content[0].text, /upstream_unavailable/);
  ok("the API transient retry is bounded to one");
}
// 0.10.2: the API's 408 upstream_timeout on a READ (a read that did not complete in
// time, not billed) gets the same ONE retry after its retry_after; a 408 with any
// other body, and a 408 on a write, never do.
const API_408 = '{"error":"upstream_timeout","message":"The read did not complete in time. It was not billed. Please retry shortly.","retry_after":2}';
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 408, body: API_408 }, { status: 200, body: '{"posts":[]}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000], "waits the body's retry_after seconds");
  ok("a read answered 408 upstream_timeout is retried once and returns the real answer");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 408, body: API_408 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 2, "exactly one retry, then the error is reported");
  assert.match(r.content[0].text, /upstream_timeout/);
  assert.match(r.content[0].text, /did not complete in time; retry after the retry_after seconds/, "the 408 hint names the retry");
  ok("the 408 retry is bounded to one and the error carries the 408 hint");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 408, body: '{"error":"request_timeout"}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1, "a 408 with another error value is not the API's transient timeout and is not retried");
  ok("only the top-level error value upstream_timeout earns the 408 retry");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 408, body: API_408 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/monitor/add", { subreddit: "x" }, "POST");
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1, "a write is never retried on a 408");
  ok("a 408 on a write is never retried");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: '{"error":"upstream_unavailable","retry_after":60}' }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [5000], "retry_after is clamped to 5 s");
  const { fetchImpl: f2 } = seq([{ status: 503, body: '{"error":"upstream_unavailable"}' }, { status: 200, body: "{}" }]);
  sleeps.length = 0;
  await mk(f2).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [2000], "a missing retry_after defaults to 2 s");
  ok("retry_after is honoured within 1..5 s");
}
{
  const { fetchImpl, calls } = seq([{ status: 503, body: '{"error":"x","detail":{"error":"upstream_unavailable","retry_after":2}}' }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("only the TOP-LEVEL error value counts: a nested upstream_unavailable is not retried (review 2026-10-14)");
}
{
  sleeps.length = 0;
  const { fetchImpl } = seq([{ status: 503, body: '{"error":"upstream_unavailable","retry_after":"2"}' }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [2000], "a string retry_after is read as a number");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 429, body: '{"error":"too_many_concurrent_reads","message":"Too many reads are already in flight on this API key.","retry_after":2}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.match(r.content[0].text, /under the limit the message names/);
  ok("a 429 too_many_concurrent_reads is never retried and tells the model to lower concurrency");
}
{
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503 }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/submit", { subreddit: "test", title: "t" }, "POST");
  assert.equal(calls.length, 1);
  ok("a WRITE is never retried on the API's JSON 503 either");
}
{
  const { fetchImpl, calls } = seq([{ status: 503, body: '{"error":"service_unavailable","message":"maintenance"}' }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("a JSON 503 with any other error value is not retried (negative control)");
}
{
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { fetchImpl, calls } = seq([abort, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  assert.match(r.content[0].text, /timed out/);
  ok("a timeout is not retried");
}

{
  sleeps.length = 0;
  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const { fetchImpl, calls } = seq([dns, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.match(r.content[0].text, /ENOTFOUND/);
  ok("a DNS failure is not retried (it cannot fix itself) and its code is reported");
}
{
  sleeps.length = 0;
  const r = await mk(fetch, { baseUrl: "http://127.0.0.1:59981" }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.deepEqual(sleeps, [3, 8]);
  assert.match(r.content[0].text, /ECONNREFUSED/);
  ok("a REAL refused connection (closed local port) is retried twice, then reported with its code");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 504, body: "<html>504 Gateway Time-out</html>" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("a gateway 504 is not retried (the app may already have done, and billed, the work)");
}

{
  // A REAL socket that answers 200 headers and then drops mid-body: the API has
  // already handled the request, so it must be sent exactly once.
  let hits = 0;
  const srv = createHttp((req, res) => { hits++; res.writeHead(200, { "content-length": "1000" }); res.write("{\"partial\":"); setTimeout(() => req.socket.destroy(), 20); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  sleeps.length = 0;
  const r = await mk(fetch, { baseUrl: `http://127.0.0.1:${srv.address().port}` }).callEndpoint("/api/reddit/search", { q: "x" });
  srv.close();
  assert.equal(hits, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(r.isError, true);
  ok("a response dropped mid-body is never re-sent (the API already handled it): exactly 1 hit");
}
{
  // Closed after the request arrived but before any headers: also possibly handled.
  let hits = 0;
  const srv = createHttp((req) => { hits++; setTimeout(() => req.socket.destroy(), 20); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  sleeps.length = 0;
  await mk(fetch, { baseUrl: `http://127.0.0.1:${srv.address().port}` }).callEndpoint("/api/reddit/search", { q: "x" });
  srv.close();
  assert.equal(hits, 1);
  ok("a socket closed after the request arrived is never re-sent: exactly 1 hit");
}

// 0.10.5: the API answers a read whose wall-clock budget ran out with 503 and the
// same upstream_timeout value (it used to be 408). Same unbilled per-read refusal,
// so the same ONE retry, the "did not complete in time" hint, Retry-After honoured,
// and the whole call kept inside the client timeout.
const API_503_TIMEOUT = '{"error":"upstream_timeout","message":"The read did not complete in time. It was not billed. Please retry shortly.","retry_after":5}';
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503_TIMEOUT }, { status: 200, body: '{"posts":[]}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [5000], "waits the body's retry_after seconds");
  ok("a read answered 503 upstream_timeout is retried once and returns the real answer");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503_TIMEOUT }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 2, "exactly one retry, then the error is reported");
  assert.match(r.content[0].text, /^HTTP 503 \(the read did not complete in time; retry after the retry_after seconds\)/, "the 503 upstream_timeout carries the did-not-complete hint");
  assert.doesNotMatch(r.content[0].text, /upstream API error/, "not the generic 5xx hint");
  ok("the 503 upstream_timeout retry is bounded to one and the error carries the did-not-complete hint");
}
{
  // CONTROL: a 503 upstream_unavailable keeps the generic 5xx hint.
  sleeps.length = 0;
  const { fetchImpl } = seq([{ status: 503, body: API_503 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.match(r.content[0].text, /upstream API error/);
  ok("control: 503 upstream_unavailable keeps the generic 5xx hint");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503_TIMEOUT }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/monitor/add", { subreddit: "x" }, "POST");
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1, "a write is never retried on a 503 upstream_timeout");
  ok("a 503 upstream_timeout on a write is never retried");
}
{
  // Retry-After header when the body names no retry_after; the body wins when both are set.
  sleeps.length = 0;
  const { fetchImpl } = seq([{ status: 503, body: '{"error":"upstream_timeout"}', headers: { "retry-after": "4" } }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [4000], "the Retry-After header is honoured when the body has no retry_after");
  sleeps.length = 0;
  const { fetchImpl: f2 } = seq([{ status: 503, body: '{"error":"upstream_timeout","retry_after":3}', headers: { "retry-after": "5" } }, { status: 200, body: "{}" }]);
  await mk(f2).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [3000], "the body's retry_after wins over the header");
  sleeps.length = 0;
  const { fetchImpl: f3 } = seq([{ status: 503, body: '{"error":"upstream_timeout"}', headers: { "retry-after": "60" } }, { status: 200, body: "{}" }]);
  await mk(f3).callEndpoint("/api/reddit/search", { q: "x" });
  assert.deepEqual(sleeps, [5000], "a header wait is clamped to 5 s too");
  ok("Retry-After is honoured (body first, then header), clamped 1..5 s");
}
{
  // The budget-spent shape: the refusal arrives 24 s into a 30 s client timeout. A
  // 5 s wait leaves 1 s, under the retry floor, so the call answers now with the
  // hint instead of being cut off mid-retry.
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503_TIMEOUT, onCall: () => { clock += 24000; } }, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl, { nowImpl: () => clock }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1, `no retry that cannot finish inside the client timeout, got ${calls.length} calls`);
  assert.deepEqual(sleeps, []);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not complete in time/);
  ok("a refusal too late for a retry inside the client timeout is answered at once, with the hint");
}
{
  // CONTROL at 22 s: 30 - 22 - 5 = 3 s left, exactly the floor, so the retry is sent.
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl, calls } = seq([{ status: 503, body: API_503_TIMEOUT, onCall: () => { clock += 22000; } }, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl, { nowImpl: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 2);
  assert.equal(r.isError, undefined);
  ok("control: with 3 s left after the wait the retry is still sent");
}
{
  // The retried attempt is aborted at what is LEFT of the client timeout, never a fresh
  // full timer: timeoutMs 10 s, refusal at 6 s, 1 s wait, 3 s left, the hanging retry is
  // cut at 3000 ms (real timer, so this case takes ~3 s).
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl, calls } = seq([
    { status: 503, body: '{"error":"upstream_timeout","retry_after":1}', onCall: () => { clock += 6000; } },
    { hang: true },
  ]);
  const r = await mk(fetchImpl, { timeoutMs: 10000, nowImpl: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 2);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out after 3000ms/, `the retry is bounded by what is left, got: ${r.content[0].text}`);
  ok("the retried attempt is aborted at what is left of the client timeout (3000 ms of 10000)");
}

{
  // Review probe (0.11.0): a gateway 502 AFTER the API retry must not sleep its fixed
  // delay on a fresh timer. timeoutMs 10 s: refusal at 6 s, 1 s wait (3 s left), then an
  // HTML 502 at 7.5 s: the gateway retry would need its delay plus 3 s, which is not
  // left, so the 502 is answered at once and the call ends inside 10 s.
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl, calls } = seq([
    { status: 503, body: '{"error":"upstream_timeout","retry_after":1}', onCall: () => { clock += 6000; } },
    { status: 502, body: "<html>bad gateway</html>", onCall: () => { clock += 500; } },
    { hang: true },
  ]);
  const r = await mk(fetchImpl, { timeoutMs: 10000, retryDelaysMs: [3000, 8000], nowImpl: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 2, `no third attempt outside the client timeout, got ${calls.length}`);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HTTP 502/);
  assert.ok(clock <= 10000, `the call ended inside the client timeout, clock ${clock}`);
  ok("a gateway retry that cannot finish inside the client timeout is not sent (review probe)");
}
{
  // CONTROL: the same sequence with the default 30 s timeout retries the gateway page
  // (7.5 s + 3 s delay leaves 19.5 s) and the third attempt gets what is left, not 30 s.
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl, calls } = seq([
    { status: 503, body: '{"error":"upstream_timeout","retry_after":1}', onCall: () => { clock += 6000; } },
    { status: 502, body: "<html>bad gateway</html>", onCall: () => { clock += 500; } },
    { status: 200, body: "{}" },
  ]);
  const r = await mk(fetchImpl, { retryDelaysMs: [3000, 8000], nowImpl: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.equal(r.isError, undefined);
  ok("control: with budget left the gateway retry is still sent, inside the client timeout");
}
{
  // LOW: a shortened attempt's timeout message names the client timeout it was cut from.
  sleeps.length = 0;
  let clock = 0;
  const { fetchImpl } = seq([
    { status: 503, body: '{"error":"upstream_timeout","retry_after":1}', onCall: () => { clock += 6000; } },
    { hang: true },
  ]);
  const r = await mk(fetchImpl, { timeoutMs: 10000, nowImpl: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.match(r.content[0].text, /timed out after 3000ms \(the retry had that much of the 10000ms client timeout left\)/, r.content[0].text);
  ok("a shortened retry's timeout message names the client timeout");
}

console.log(`\nremote-host: ${n} passed, 0 failed`);
