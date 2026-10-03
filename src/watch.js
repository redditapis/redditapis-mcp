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

// r/Name or /r/Name. Reddit subreddit names are 3-21 characters of
// [A-Za-z0-9_], starting with a letter or digit.
const SUBREDDIT_RE = /(?:^|[\s,.;:("'[])\/?r\/([A-Za-z0-9][A-Za-z0-9_]{1,20})(?![A-Za-z0-9_])/g;

// Quoted phrases become keyword terms. Straight double quotes, curly double
// quotes and curly single quotes only: a straight apostrophe is far more often
// a contraction ("don't") than a quote, and treating it as one turns half a
// sentence into a keyword.
const QUOTED_RE = /"([^"]{1,200})"|“([^”]{1,200})”|‘([^’]{1,200})’/g;

// The clause that introduces a keyword when nothing is quoted.
const KEYWORD_LEAD_RE =
  /\b(?:mentions? of|mentioning|that mentions?|who mentions?|talking about|talks about|keyword|about|for)\s+(.+)$/i;

// WHERE A CLAUSE STOPS. Every clause in one of these sentences runs until the
// next instruction starts, and the clauses are written in any order, so the
// same stop list serves all of them.
//
// THE EXCLUSION CLAUSE USED TO HAVE A SHORTER STOP LIST THAN THE KEYWORD CLAUSE,
// and an end-to-end smoke over stdio caught what that costs: "except giveaway
// with at least 5 upvotes" compiled the score phrase INTO the excluded term, so
// the monitor suppressed the literal string "giveaway with at least 5 upvotes",
// which nothing on Reddit says, while the score floor it also parsed correctly
// stayed. A filter that silently excludes nothing is worse than one that fails,
// because it looks like it worked. One shared stop list, no second copy to
// drift.
const CLAUSE_STOP_SRC =
  "[.;]|$" +
  "|\\b(?:with\\s+)?(?:a\\s+)?(?:at least|minimum of|min(?:imum)?|over|above)\\s+\\d" +
  "|\\bscore\\b" +
  "|\\band (?:deliver|send|post|notify|alert)\\b" +
  "|\\bdeliver(?:ed)? to\\b|\\bsend to\\b";

const KEYWORD_STOP_RE = new RegExp(
  `\\s*(?:\\b(?:except|excluding|but not|ignoring|ignore|without)\\b|${CLAUSE_STOP_SRC})`,
  "i",
);

const EXCLUDE_RE = new RegExp(
  `\\b(?:except|excluding|but not|ignoring|ignore|without)\\s+(.+?)(?=\\s*(?:${CLAUSE_STOP_SRC}))`,
  "i",
);

const MIN_SCORE_RE =
  /\b(?:at least|minimum of|min(?:imum)?|over|above)\s+(\d{1,7})\s*\+?\s*(?:upvotes?|points?|score|karma)\b/i;
const MIN_SCORE_ALT_RE = /\bscore\s+(?:of\s+)?(?:at least|over|above|>=?)\s*(\d{1,7})\b/i;

// Filler the keyword clause picks up from ordinary English.
const LEADING_FILLER_RE = /^(?:the|a|an|any|all|new|every)\s+/i;
const TRAILING_NOISE_RE =
  /\s*\b(?:posts?|comments?|threads?|submissions?|posts? and comments?|mentions?|in|on|from|to|anywhere|site[- ]?wide|sitewide)\b[\s.]*$/i;

const RESERVED_SUBREDDITS = new Set(["all", "popular"]);

function cleanTerm(s) {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[,:;.\s]+|[,:;.\s]+$/g, "");
  return t;
}

/**
 * Compile a plain-words watch description into a monitor filter.
 *
 * Pure: no I/O, no clock, no randomness. Returns the filter the API takes, a
 * plain-English `understood` record of what each phrase became, and `notes`
 * describing anything that was dropped or rewritten.
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

  // 1. Subreddits.
  const subs = [];
  const dropped = [];
  for (const m of raw.matchAll(SUBREDDIT_RE)) {
    const name = m[1];
    if (RESERVED_SUBREDDITS.has(name.toLowerCase())) {
      if (!dropped.includes(name)) dropped.push(name);
      continue;
    }
    if (!subs.some((s) => s.toLowerCase() === name.toLowerCase())) subs.push(name);
  }
  if (dropped.length) {
    notes.push(
      `r/${dropped.join(", r/")} names Reddit's site-wide listing rather than a subreddit, so it was dropped from the subreddit list; a watch with no subreddit list already covers every subreddit.`,
    );
  }

  // 2. Match kind. "comments" alone means comments; naming both means both.
  const saysComments = /\bcomments?\b/i.test(raw);
  const saysPosts = /\bposts?\b|\bsubmissions?\b|\bthreads?\b/i.test(raw);
  let kind;
  if (saysComments && saysPosts) kind = "both";
  else if (saysComments) kind = "comment";

  // 3. Keywords. Every quoted phrase is a term; two or more become an OR set,
  //    which is what "watch for X or Y" means and what a single `q` cannot say.
  const quoted = [];
  for (const m of raw.matchAll(QUOTED_RE)) {
    const t = cleanTerm(m[1] ?? m[2] ?? m[3]);
    if (t && !quoted.some((q) => q.toLowerCase() === t.toLowerCase())) quoted.push(t);
  }

  let q;
  let includeAny;
  if (quoted.length === 1) {
    q = quoted[0];
  } else if (quoted.length > 1) {
    includeAny = quoted;
  } else {
    // Nothing quoted: take the clause after a keyword lead, with the subreddit
    // tokens and the next instruction stripped off it.
    const withoutSubs = raw.replace(SUBREDDIT_RE, " ").replace(/\s+/g, " ").trim();
    const lead = withoutSubs.match(KEYWORD_LEAD_RE);
    if (lead) {
      let tail = lead[1];
      const stop = tail.match(KEYWORD_STOP_RE);
      if (stop && stop.index > 0) tail = tail.slice(0, stop.index);
      tail = cleanTerm(tail).replace(LEADING_FILLER_RE, "");
      // Trailing nouns such as "posts" or "in" are sentence scaffolding, not
      // part of the phrase being watched for. Applied twice so "posts in"
      // reduces fully.
      tail = cleanTerm(tail.replace(TRAILING_NOISE_RE, ""));
      tail = cleanTerm(tail.replace(TRAILING_NOISE_RE, ""));
      if (tail && tail.length <= 200) q = tail;
    }
  }

  // 4. Exclusions.
  let excludeTerms;
  const ex = raw.match(EXCLUDE_RE);
  if (ex) {
    const parts = ex[1]
      .split(/\s*(?:,|\bor\b|\band\b)\s*/i)
      .map((p) => cleanTerm(p.replace(/^["“‘]|["”’]$/g, "")))
      .filter((p) => p && p.length <= 200);
    if (parts.length) excludeTerms = parts.slice(0, 50);
  }

  // 5. Score floor.
  let minScore;
  const ms = raw.match(MIN_SCORE_RE) || raw.match(MIN_SCORE_ALT_RE);
  if (ms) minScore = Number(ms[1]);

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
        delivery = {
          registered: true,
          webhook_id: webhook.id ?? null,
          kind: webhook.kind ?? null,
          secret_shown_once: typeof webhook.secret === "string",
          test: null,
        };

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
        }

        const wantsTest = testDelivery !== false;
        if (wantsTest && webhook.id) {
          const testRes = await callEndpoint("/api/reddit/monitor/webhook/test", { id: webhook.id }, "POST", AS_SET_WATCH);
          const body = parseResult(testRes);
          delivery.test = testRes?.isError
            ? { ok: false, detail: (testRes.content?.[0]?.text || "").slice(0, 600) }
            : { ok: body?.ok !== false, reason: body?.reason ?? null, hint: body?.hint ?? null, status: body?.status ?? null, detail: body?.detail ?? null };
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
