// src/watch.js, the local half of reddit_set_watch.
//
// WHAT THIS IS. Standing up a working Reddit watch takes three calls today:
// register a delivery target, create the monitor, test the target. Each one
// needs its own vocabulary (filter_spec nesting, the anchor rule, the webhook
// kind inference), and the first one a caller gets wrong fails late, as a 400
// or a 402 from the API. This module turns a sentence into those calls, in
// order, with the two rules that can be checked WITHOUT a round trip checked
// locally first.
//
// IT IS A COMPILER, NOT A MODEL. Every rule below is a regular expression and a
// documented transformation. There is no language model in this path and no
// network call in the compile step, so the same sentence always compiles to the
// same filter and `understood` can be handed back for a human to check.
//
// THE TWO LOCAL REFUSALS, both of which the API also enforces:
//   1. ANCHOR. A monitor is anchored by a subreddit list, a keyword, or both; a
//      request with neither is refused (apps/api/src/lib/monitor-filter.js).
//      Refusing locally costs nothing and names the missing half.
//   2. RESERVED. subreddit ['all'] is refused with subreddit_reserved (400),
//      because r/all is Reddit's site-wide listing and not a subreddit. The
//      compiler drops it and says so rather than building a request that 400s.
//
// PLAN AWARENESS IS A FIELD READ, NOT A GUESS. GET /api/reddit/monitor/list is
// free and returns a `slots` object that states the account's capabilities
// outright (measured live 2026-10-02):
//   {used, total, tier, is_free, cadence_s, sitewide_slots,
//    distinct_subreddits_used, distinct_subreddits_total,
//    comments_allowed, scoped_allowed, sitewide_allowed}
// `scoped_allowed` is the flag that decides whether a sentence naming r/SaaS can
// be built as written. On a plan without it, a sentence that ALSO carries a
// keyword is compiled to the sitewide equivalent (same keyword, every
// subreddit) and the swap is reported in `notes`; a sentence with no keyword has
// no sitewide equivalent, so the request goes as written and the API's own
// answer is relayed. A `slots` object that is missing or shaped differently
// means the preflight stays silent and the API decides, because the API is the
// authority on its own entitlements.
//
// ORDER OF OPERATIONS, chosen for the failure mode rather than for the happy
// path: the monitor is created FIRST and the delivery target second. A monitor
// with no webhook_ids delivers to every active webhook on the account, so a
// monitor that outlives a failed webhook registration is still a working watch.
// The reverse order would leave a registered webhook pointing at nothing when
// the monitor hits a slot limit.

import { buildWatchSummary } from "./watch-text.js";

// ── the compiler ────────────────────────────────────────────────────────────
//
// SEGMENT FIRST, THEN DERIVE EACH FIELD FROM ITS OWN SPAN. This used to match
// every field with its own regular expression over the WHOLE sentence, and that
// design has exactly one failure mode which it produces over and over: two
// clauses read the same words and one of them is wrong.
//
// It was found four times before the shape was admitted. "except giveaway with
// at least 5 upvotes" put the score phrase inside the excluded term. Then
// 'for pricing except "giveaway"' put the EXCLUDED phrase into `q`, so `q` and
// `exclude_terms[0]` were the same string and the monitor could never deliver
// anything, while reporting a monitor id and a green test. Then "for posts
// about pricing" kept the scaffolding and watched for the literal phrase
// "posts about pricing". Then 'for "comment moderation"' read the word comment
// out of the user's own keyword and quietly switched the watch to comments
// only, missing every post. Patching the pairs one at a time produced three
// green suites over four live defects, because each patch taught the tests the
// shape that had just been fixed and nothing about the class.
//
// So the sentence is cut into clauses ONCE, by the markers that start them, and
// after that every field reads only its own span:
//   keyword  <- the spans that are not another clause
//   exclude  <- the span after except / without / ignoring
//   score    <- the score phrase itself, which consumes only its own words
//   kind     <- the words left after the subreddits, the quotes and the derived
//               keywords are removed, so a keyword can never set it
// A quoted phrase belongs to whichever span contains it, which is what makes
// an exclusion stay an exclusion.
//
// AND WHEN SOMETHING THE USER WROTE IS DROPPED OR REWRITTEN, IT GETS A NOTE.
// Every defect above was silent, and silence is what made each one expensive:
// the result said `watching`, carried a monitor id and a green test delivery,
// and the watch did nothing. An empty `notes` on a lossy compile is itself the
// bug, so the note is part of the contract and is asserted per case.

// Subreddits, in two forms. A pasted link is how people actually name a
// community, and reading only the bare form sent the watch SITE-WIDE on a
// pasted URL while consuming the account's one free site-wide slot.
const SUBREDDIT_URL_RE =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*reddit\.com\/r\/([A-Za-z0-9][A-Za-z0-9_]{1,20})(?![A-Za-z0-9_])\/?/gi;
// The bare form. The leading class deliberately excludes "/", so a path such as
// docs/r/readme is not a subreddit; the URL form above is how a real link gets in.
const SUBREDDIT_RE = /(?:^|[\s,.;:("'[])\/?r\/([A-Za-z0-9][A-Za-z0-9_]{1,20})(?![A-Za-z0-9_])/g;

// Quoted phrases become terms. Straight double quotes, curly double quotes and
// curly single quotes only: a straight apostrophe is far more often a
// contraction ("don't") than a quote, and treating it as one turns half a
// sentence into a keyword.
const QUOTED_RE = /"([^"]{1,200})"|“([^”]{1,200})”|‘([^’]{1,200})’/g;

// The clause that introduces a keyword.
const KEYWORD_LEAD_RE =
  /\b(?:mentions? of|mentioning|that mentions?|who mentions?|talking about|talks about|keyword|about|for)\s+(.+)$/i;

// Scaffolding between a lead word and the phrase actually being watched for:
// "for POSTS ABOUT pricing", "for ANYTHING MENTIONING kubernetes". Stripped only
// when the words before the inner lead are scaffolding nouns, so a real keyword
// that happens to contain "about" or "for" ("a tool for teams") is left alone.
const SCAFFOLD_RE =
  /^(?:(?:new|all|any|the)\s+)*(?:posts?|comments?|threads?|submissions?|mentions?|anything|anyone|everything|everyone|people|someone|somebody|users?|redditors?)\s+(?:that\s+|which\s+)?(?:about|mentioning|mentions?|discussing|discuss(?:es)?|talking about|talks about|referencing|references?|regarding|on|of)\s+/i;

const MIN_SCORE_RE =
  /\b(?:at least|minimum of|min(?:imum)?|over|above)\s+(\d{1,7})\s*\+?\s*(?:upvotes?|points?|score|karma)\b/i;
const MIN_SCORE_ALT_RE = /\bscore\s+(?:of\s+)?(?:at least|over|above|>=?)\s*(\d{1,7})\b/i;

// Filler an ordinary English clause carries into a keyword.
const LEADING_FILLER_RE = /^(?:the|a|an|any|all|new|every)\s+/i;
const TRAILING_NOISE_RE =
  /\s*\b(?:posts?|comments?|threads?|submissions?|posts? and comments?|mentions?|in|on|from|to|anywhere|site[- ]?wide|sitewide)\b[\s.]*$/i;

const RESERVED_SUBREDDITS = new Set(["all", "popular"]);

// The markers that start a clause, and how much of the sentence each consumes.
//   "rest" runs to the next marker or the end of the sentence.
//   "self" consumes only its own words, so the text after it is a fresh span
//          and a keyword written after a score phrase is not thrown away.
const CLAUSE_MARKERS = [
  { kind: "exclude", consumes: "rest", re: /\b(?:except|excluding|but not|ignoring|ignore|without)\b/gi },
  {
    kind: "score",
    consumes: "self",
    re: /\b(?:with\s+)?(?:a\s+)?(?:at least|minimum of|min(?:imum)?|over|above)\s+\d{1,7}\s*\+?\s*(?:upvotes?|points?|score|karma)\b|\bscore\s+(?:of\s+)?(?:at least|over|above|>=?)\s*\d{1,7}\b/gi,
  },
  { kind: "deliver", consumes: "rest", re: /\b(?:and\s+(?:deliver|send|post|notify|alert)\b|deliver(?:ed)?\s+to\b|send\s+to\b)/gi },
];

function cleanTerm(s) {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[,:;.\s]+|[,:;.\s]+$/g, "");
  return t;
}

/**
 * Cut a sentence into clauses. Exported so the tests can assert the cut itself
 * rather than only its consequences: when a field comes out wrong, the question
 * is always whether the clause or the field rule was at fault.
 *
 * @returns {{kind: "keyword"|"exclude"|"score"|"deliver", text: string}[]}
 */
export function segment(text) {
  const src = String(text || "");
  const hits = [];
  for (const m of CLAUSE_MARKERS) {
    const re = new RegExp(m.re.source, m.re.flags);
    for (const hit of src.matchAll(re)) {
      hits.push({ kind: m.kind, consumes: m.consumes, start: hit.index, end: hit.index + hit[0].length, match: hit[0] });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  // Drop a marker that starts inside one already accepted, so "at least 5
  // upvotes" is one score clause and not a score clause plus whatever its words
  // happen to match.
  const taken = [];
  for (const h of hits) if (!taken.length || h.start >= taken[taken.length - 1].end) taken.push(h);

  const out = [];
  let pos = 0;
  for (let i = 0; i < taken.length; i++) {
    const h = taken[i];
    if (h.start < pos) continue;
    const head = cleanTerm(src.slice(pos, h.start));
    if (head) out.push({ kind: "keyword", text: head });
    if (h.consumes === "self") {
      out.push({ kind: h.kind, text: h.match });
      pos = h.end;
    } else {
      const next = taken.slice(i + 1).find((n) => n.start >= h.end);
      const stop = next ? next.start : src.length;
      out.push({ kind: h.kind, text: cleanTerm(src.slice(h.end, stop)) });
      pos = stop;
    }
  }
  const tail = cleanTerm(src.slice(pos));
  if (tail) out.push({ kind: "keyword", text: tail });
  return out;
}

/** Every quoted phrase in one span, de-duplicated case-insensitively. */
function quotedIn(span) {
  const out = [];
  for (const m of String(span).matchAll(QUOTED_RE)) {
    const t = cleanTerm(m[1] ?? m[2] ?? m[3]);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** The phrase a keyword span is actually about, or null. */
function keywordFrom(span) {
  const lead = String(span).match(KEYWORD_LEAD_RE);
  if (!lead) return null;
  let tail = cleanTerm(lead[1]).replace(LEADING_FILLER_RE, "");
  // Strip scaffolding repeatedly, bounded, so "all posts about" reduces fully
  // without a crafted sentence being able to loop here.
  for (let i = 0; i < 3 && SCAFFOLD_RE.test(tail); i++) tail = cleanTerm(tail.replace(SCAFFOLD_RE, ""));
  tail = cleanTerm(tail.replace(TRAILING_NOISE_RE, ""));
  tail = cleanTerm(tail.replace(TRAILING_NOISE_RE, ""));
  return tail && tail.length <= 200 ? tail : null;
}

/**
 * Compile a plain-words watch description into a monitor filter.
 *
 * Pure: no I/O, no clock, no randomness. Returns the filter the API takes, a
 * plain-English `understood` record of what each phrase became, and `notes`
 * naming anything that was dropped or rewritten.
 *
 * @param {string} text
 * @returns {{filter: object, understood: object, notes: string[], error: string|null}}
 */
export function compileWatch(text) {
  const notes = [];
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!raw) {
    return { filter: {}, understood: {}, notes, error: "empty_description" };
  }

  // 1. Subreddits, link form first so the link's own text cannot then be read
  //    as a keyword.
  const subs = [];
  const dropped = [];
  const addSub = (name) => {
    if (RESERVED_SUBREDDITS.has(name.toLowerCase())) {
      if (!dropped.includes(name)) dropped.push(name);
      return;
    }
    if (!subs.some((x) => x.toLowerCase() === name.toLowerCase())) subs.push(name);
  };
  let body = raw.replace(SUBREDDIT_URL_RE, (_, name) => { addSub(name); return " "; });
  body = body.replace(SUBREDDIT_RE, (_, name) => { addSub(name); return " "; });
  body = body.replace(/\s+/g, " ").trim();
  if (dropped.length) {
    notes.push(
      `r/${dropped.join(", r/")} names Reddit's site-wide listing rather than a subreddit, so it was dropped from the subreddit list; a watch with no subreddit list already covers every subreddit.`,
    );
  }

  // 2. Cut the sentence into clauses. Everything below reads one span only.
  const spans = segment(body);
  const keywordSpans = spans.filter((s) => s.kind === "keyword").map((s) => s.text);
  const excludeSpans = spans.filter((s) => s.kind === "exclude").map((s) => s.text);

  // 3. Keywords, from the keyword spans and nowhere else.
  const quoted = [];
  for (const span of keywordSpans) {
    for (const t of quotedIn(span)) if (!quoted.some((x) => x.toLowerCase() === t.toLowerCase())) quoted.push(t);
  }

  let q;
  let includeAny;
  if (quoted.length === 1) {
    q = quoted[0];
  } else if (quoted.length > 1) {
    includeAny = quoted.slice(0, 50);
  } else {
    const candidates = [];
    for (const span of keywordSpans) {
      const k = keywordFrom(span);
      if (k && !candidates.some((x) => x.toLowerCase() === k.toLowerCase())) candidates.push(k);
    }
    if (candidates.length) q = candidates[0];
    if (candidates.length > 1) {
      notes.push(
        `The description carries more than one phrase to watch for; ${JSON.stringify(candidates[0])} was used and ${candidates.slice(1).map((c) => JSON.stringify(c)).join(", ")} was not. Quoting each phrase matches any of them.`,
      );
    }
  }

  // 4. Exclusions, from the exclusion spans and nowhere else. A quoted
  //    exclusion is the phrase; otherwise the span splits on list punctuation.
  let excludeTerms;
  const exTerms = [];
  for (const span of excludeSpans) {
    const qs = quotedIn(span);
    const parts = qs.length
      ? qs
      : span.split(/\s*(?:,|\bor\b|\band\b)\s*/i).map((p) => cleanTerm(p)).filter(Boolean);
    for (const p of parts) {
      if (p.length <= 200 && !exTerms.some((x) => x.toLowerCase() === p.toLowerCase())) exTerms.push(p);
    }
  }
  if (exTerms.length) excludeTerms = exTerms.slice(0, 50);

  // 5. Score floor, from the score spans the cut already isolated.
  let minScore;
  for (const span of spans.filter((x) => x.kind === "score").map((x) => x.text)) {
    const ms = span.match(MIN_SCORE_RE) || span.match(MIN_SCORE_ALT_RE);
    if (ms) { minScore = Number(ms[1]); break; }
  }

  // 6. Match kind, LAST and only from what is left over.
  //
  // This used to read the whole sentence, so 'for "comment moderation"' found
  // the word comment inside the user's own keyword and switched the watch to
  // comments only, missing every post, with nothing said. The kind is a
  // property of how the sentence describes the watch, never of the phrase being
  // watched for, so the subreddits, every quoted span and every derived term
  // come out before the question is asked.
  let kindSource = body;
  for (const span of keywordSpans) {
    for (const t of quotedIn(span)) kindSource = kindSource.split(t).join(" ");
  }
  for (const t of [q, ...(includeAny || []), ...(exTerms || [])]) {
    if (t) kindSource = kindSource.split(t).join(" ");
  }
  const saysComments = /\bcomments?\b/i.test(kindSource);
  const saysPosts = /\bposts?\b|\bsubmissions?\b|\bthreads?\b/i.test(kindSource);
  let kind;
  if (saysComments && saysPosts) kind = "both";
  else if (saysComments) kind = "comment";

  const filter = {};
  if (subs.length) filter.subreddit = subs.slice(0, 50);
  if (q) filter.q = q;
  if (includeAny) filter.include_any = includeAny.slice(0, 50);
  if (excludeTerms) filter.exclude_terms = excludeTerms;
  if (kind) filter.kind = kind;
  if (minScore !== undefined) filter.min_score = minScore;

  const anchored = Boolean(filter.subreddit || filter.q || filter.include_any);
  const understood = {
    subreddits: filter.subreddit || null,
    keyword: filter.q || null,
    any_of: filter.include_any || null,
    excluded_terms: filter.exclude_terms || null,
    match_kind: filter.kind || "post",
    min_score: filter.min_score ?? null,
    scope: filter.subreddit ? "named subreddits" : "every subreddit",
  };

  return { filter, understood, notes, error: anchored ? null : "no_anchor" };
}

// ── plan preflight ──────────────────────────────────────────────────────────

/**
 * Read the account's capability flags from a monitor list response.
 * Returns null when the response is missing or shaped differently, which means
 * the preflight stays silent and the API decides.
 */
export function readSlots(listBody) {
  const s = listBody && typeof listBody === "object" ? listBody.slots : null;
  if (!s || typeof s !== "object") return null;
  return s;
}

/**
 * Apply the account's capabilities to a compiled filter.
 *
 * The only rewrite made here is the one with a genuine equivalent: a plan
 * without subreddit-scoped watches cannot run `subreddit: [...]`, but the same
 * keyword over every subreddit finds the same conversations in a wider net. A
 * filter with no keyword has no such equivalent, so it is left exactly as
 * compiled and the API answers for itself.
 */
export function applyPlan(filter, slots, notes) {
  const out = { ...filter };
  if (!slots) return out;
  const hasKeyword = Boolean(out.q || out.include_any);

  if (out.subreddit && slots.scoped_allowed === false) {
    if (hasKeyword) {
      delete out.subreddit;
      notes.push(
        `This account's plan carries no subreddit-scoped watches, so the watch was built over every subreddit with the same keyword instead of being limited to the subreddits named. A plan with scoped watches would narrow it back to those subreddits.`,
      );
    } else {
      notes.push(
        `This account's plan carries no subreddit-scoped watches and the description carries no keyword to widen it with, so the request went as written.`,
      );
    }
  }
  if (out.kind && out.kind !== "post" && slots.comments_allowed === false) {
    notes.push(
      `This account's plan carries no comment matching, so the request went as written and the API's own answer stands.`,
    );
  }
  return out;
}

// ── the handler ─────────────────────────────────────────────────────────────

// Each leg carries the composite tool's own name, so the provenance ledger
// attributes a monitor read made by reddit_set_watch to reddit_set_watch rather
// than to nothing.
const AS_SET_WATCH = { name: "reddit_set_watch" };

const MONITOR_FILTER_SPEC_FIELDS = [
  "subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms",
  "domain", "include_any", "include_all", "search_in", "group", "min_score",
  "min_relevance", "nsfw",
];

/** Parse a callEndpoint success result's JSON body; null when it is not JSON. */
export function parseResult(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fail(message, extra = {}) {
  const payload = { status: "not_created", message, ...extra };
  return {
    isError: true,
    content: [{ type: "text", text: `${message}\n\n${JSON.stringify(payload)}` }],
    structuredContent: payload,
  };
}

/**
 * Build the reddit_set_watch handler.
 *
 * @param {object} deps
 * @param {Function} deps.callEndpoint the server's REST caller, already bound to
 *        this caller's credentials.
 */
export function createSetWatchHandler({ callEndpoint }) {
  return async function setWatch(args = {}) {
    const { watch, deliver_to: deliverTo, cadence_s: cadenceS, test_delivery: testDelivery } = args;

    // 1. Compile. No network call has happened yet, so a sentence that cannot
    //    be compiled costs nothing and the refusal names the missing half.
    const { filter, understood, notes, error } = compileWatch(watch);
    if (error === "empty_description") {
      return fail("No watch description was given. A watch is built from a sentence naming a subreddit, a keyword, or both.", { understood });
    }
    if (error === "no_anchor") {
      return fail(
        "The description named neither a subreddit (written as r/Name) nor a keyword (a quoted phrase, or a phrase after 'for' or 'mentioning'). A monitor is anchored by one or the other, so nothing was created and no request was sent.",
        { understood },
      );
    }

    // 2. Plan preflight. Free, unmetered, and a stated field rather than an
    //    inference. A failure here is not fatal: the API is the authority.
    let slots = null;
    const listRes = await callEndpoint("/api/reddit/monitor/list", {}, "GET", AS_SET_WATCH);
    if (!listRes?.isError) slots = readSlots(parseResult(listRes));

    const finalFilter = applyPlan(filter, slots, notes);

    // 3. Create the monitor first: a monitor without a webhook still delivers
    //    to every active webhook on the account, so it survives step 4 failing.
    const addArgs = { ...finalFilter };
    if (cadenceS !== undefined) addArgs.cadence_s = cadenceS;
    const addRes = await callEndpoint(
      "/api/reddit/monitor/add",
      addArgs,
      "POST",
      { ...AS_SET_WATCH, filterSpecFields: MONITOR_FILTER_SPEC_FIELDS },
    );
    if (addRes?.isError) {
      const text = addRes.content?.[0]?.text || "";
      const payload = {
        status: "not_created",
        message: "The monitor was not created. The compiled filter and the API's own answer are below; nothing else was registered.",
        understood,
        compiled_filter: finalFilter,
        notes,
        api_response: text.slice(0, 1200),
        plan: slots,
      };
      return {
        isError: true,
        content: [{ type: "text", text: `${payload.message}\n\n${text}\n\n${JSON.stringify(payload)}` }],
        structuredContent: payload,
      };
    }
    const monitor = parseResult(addRes);
    const monitorId = monitor?.monitor?.id || monitor?.id || null;

    // 4. Delivery target, when one was given.
    let delivery = null;
    if (deliverTo) {
      const whRes = await callEndpoint("/api/reddit/monitor/webhook/create", { url: deliverTo }, "POST", AS_SET_WATCH);
      if (whRes?.isError) {
        delivery = {
          registered: false,
          detail: (whRes.content?.[0]?.text || "").slice(0, 600),
        };
        notes.push(
          "The delivery target was not registered. The monitor exists and delivers to every active webhook already on the account.",
        );
      } else {
        const wh = parseResult(whRes);
        const webhook = wh?.webhook || wh || {};
        // THE SIGNING SECRET IS RETURNED, NOT COUNTED. It used to be read only
        // to set a boolean and then dropped, while the summary said it was in
        // the result. The API returns it exactly once and the webhook list
        // never returns it again, so a watch set up this way left its owner
        // permanently unable to verify a delivery signature, and told them
        // otherwise. Passing it through is what the single-purpose webhook tool
        // already does; anything less makes this path strictly worse than the
        // three calls it replaces.
        delivery = {
          registered: true,
          webhook_id: webhook.id ?? null,
          kind: webhook.kind ?? null,
          secret: typeof webhook.secret === "string" ? webhook.secret : null,
          secret_shown_once: typeof webhook.secret === "string",
          test: null,
        };
        if (!webhook.id) {
          notes.push(
            "The delivery target was registered but came back without an id, so this monitor could not be pointed at it and no test delivery was sent. Its matches go to every active webhook on the account.",
          );
        }

        // Point this monitor at the new target, so its matches do not fan out
        // to every webhook the account happens to hold.
        if (monitorId && webhook.id) {
          const upd = await callEndpoint(
            "/api/reddit/monitor/update",
            { id: monitorId, webhook_ids: [webhook.id] },
            "POST",
            { ...AS_SET_WATCH, filterSpecFields: MONITOR_FILTER_SPEC_FIELDS },
          );
          delivery.targeted = !upd?.isError;
          if (upd?.isError) {
            notes.push(
              "This monitor could not be pointed at the new delivery target, so its matches go to every active webhook on the account.",
            );
          }
        } else if (webhook.id) {
          // A SKIPPED STEP THAT SAYS NOTHING READS AS A COMPLETED ONE. The
          // monitor id is missing here, so the re-point never ran, and without
          // this the summary would still report a registered target as though
          // its matches were routed to it.
          delivery.targeted = false;
          notes.push(
            "The created monitor did not come back with an id, so it could not be pointed at the new delivery target. Its matches go to every active webhook on the account.",
          );
        }

        const wantsTest = testDelivery !== false;
        if (wantsTest && webhook.id) {
          const testRes = await callEndpoint("/api/reddit/monitor/webhook/test", { id: webhook.id }, "POST", AS_SET_WATCH);
          const body = parseResult(testRes);
          // TRI-STATE, because this product's own instructions tell a caller
          // that unknown is not healthy. `ok !== false` read a missing or
          // unparseable body as a SUCCESSFUL test delivery, which is the one
          // answer the caller must not be given on no evidence.
          delivery.test = testRes?.isError
            ? { ok: false, reason: null, hint: null, status: null, detail: (testRes.content?.[0]?.text || "").slice(0, 600) }
            : {
                ok: body?.ok === true ? true : body?.ok === false ? false : null,
                reason: body?.reason ?? null,
                hint: body?.hint ?? null,
                status: body?.status ?? null,
                detail: body?.detail ?? null,
              };
        }
      }
    }

    const payload = {
      status: "watching",
      monitor: monitor?.monitor ?? monitor ?? null,
      understood,
      compiled_filter: finalFilter,
      delivery,
      notes,
      plan: slots,
    };
    return {
      content: [{ type: "text", text: `${buildWatchSummary(payload)}\n\n${JSON.stringify(payload)}` }],
      structuredContent: payload,
    };
  };
}
