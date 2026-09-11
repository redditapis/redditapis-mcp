# Changelog

## 0.6.0 (2026-09-11)

A minor rather than a patch because a tool was added: anyone pinned to 0.5.x opts in rather than receiving it silently, the same rule the 0.5.0 and 0.4.0 entries below state.

### Added

- **`reddit_user_achievements`.** A user's public achievements, the trophies on their reddit.com/user/<name>/achievements page, with name, description, granted timestamp and icons. An account with none returns an empty list, so a zero count is a real answer.

### Changed

- **`reddit_search` no longer steers you into site-wide `sort=top`.** Reddit orders `top`, `new` and `comments` by that one number over a LOOSELY matched set (OCR image text and comments count, and the word "reddit" is in almost every large post), so a generic multi-word query with `sort=top` and no `subreddit` returned the site-wide viral listing rather than the topic. Measured 2026-09-11: `q=reddit api pricing`, `sort=top`, `t=year` returned r/MadeMeSmile at 107k upvotes and a bathroom remodel; `sort=relevance` on the same query returned API-pricing threads; the quoted phrase returned exact matches only; `q=pgvector` was on topic on any sort. The tool description and the `sort` enum text now say only `relevance` weights match quality and point at `sort=relevance` plus `sort_type=score`, a quoted phrase, or a `subreddit` scope. The worked example no longer models `sort=top`.

### Housekeeping

- The authoring repo had fallen behind the published package: 0.5.3 shipped from the org repo on 2026-09-06 without landing here, so `src/index.js` in this repo still exited on a missing key. That change and its test are now back in the authoring repo, and this release is cut from it.

## 0.5.3 (2026-09-06)

### Fixed

- **A registry scanner can now read the tool catalog without a key.** `src/index.js` used to `process.exit(1)` when `REDDITAPIS_KEY` was unset, so a directory that spawns the server to enumerate its tools got no answer to `initialize` and nothing from `tools/list`, and listed the server as uninspectable. Measured 2026-09-06 by speaking raw MCP stdio to the published 0.5.2 with an empty env. The server now warns and continues; a tool CALL with no key fails at the call with a clear message, and no `Bearer undefined` header is ever sent. Not a security relaxation: this is a stdio server, whoever spawns it already has local execution. Test: `test/scannable-without-key.test.mjs`. (This entry was written on 2026-09-11; the 0.5.3 release carried no changelog line.)

## 0.5.2 (2026-09-06)

### Added

- **`reddit_post_visibility`.** Is a post still publicly visible, or did it quietly stop being so? A removed Reddit post still returns when you fetch it by id, with its title and score, so asking the post does not answer the question. This fetches the post and then one page of its author's submitted listing and compares them, returning a verdict of `live`, `not_visible` or `undecidable` with a plain-language reason and a `confident` flag. It never says WHY a post is not visible: a moderator removal, an admin removal, a spam filter and an author who has hidden their post history are indistinguishable from outside, and only one of them is a removal. `undecidable` is a real answer, not a failure. Two upstream calls, billed as one request at $0.004.

## 0.5.1 (2026-09-06)

### Fixed

- **The npm package page was showing a description cut off mid-word.** `package.json` carried a 394-character description; npm stores at most 255 and truncates the rest without an error or a warning, so the visible end of the description on npmjs.com was the fragment `register/test/dele`. 139 characters were being silently discarded. Measured against `registry.npmjs.org` rather than guessed. The description is now 249 characters and ends as a sentence, and `scripts/prepublish-tenant-check.mjs` refuses to publish one that is over the bound or that does not end in a full stop, the second check being the one that catches a cut string regardless of its length.

## 0.5.0 (2026-09-06)

### Added

- **`reddit_home_feed`, the caller's own front page.** A shared account pool can never answer "what is on MY home feed", so this reads it with your own Reddit session, sent as headers rather than in the URL. Part of the same change that gave nine existing read tools an authenticated mode: send `x-reddit-session` and `x-reddit-loid` and a private, restricted or member-only subreddit is readable as the account that belongs there, instead of coming back empty. Send neither and the read is served anonymously from the pool exactly as before, so existing integrations are untouched.
- **`reddit_verify_comments`, verify up to a hundred comments in one call.**
- **`reddit_feedback_list`, find a report whose id you lost.** `GET /feedback` with cursor paging and a type filter, so a report you sent and did not record is still reachable.

### Fixed

- **A foreign-tenant token that `git push` shipped and `npm pack` did not.** The published tarball was clean, so this never reached a customer through npm, but the string was in the repo.
- The stuck-lock test used the wrong queue-directory env var and wrote to the real home directory instead of its fixture.
- `send` now releases the queue lock across the network, a 409 carries no hint, and a posted draft fails soft rather than stranding the queue.

### Why a minor rather than a patch

The catalog moved from 38 tools to 41. A client enumerating tools sees three it did not have, which is a capability change, so anyone pinned to 0.4.x opts in rather than receiving it silently.

### Note on the gap this closes

0.4.0 was published on 2026-09-04 and the registry served it unchanged for two days while HEAD moved 50 commits ahead. Because both the registry and the repo said `0.4.0`, every version-based freshness check read clean while the BYTES differed: `src/index.js`, `src/tools.js` and `README.md` all diverged, and customers running `npx redditapis-mcp` were enumerating 38 tools against a repo that shipped 41. Found by `ship-chain.sh`, which compares the published tarball to HEAD file by file rather than comparing version strings.

## 0.4.0 (2026-09-04)

### Added

- **`reddit_feedback_send` and `reddit_feedback_get`, report a bug or a gap to the redditapis.com team from inside the session you are already in.** Modelled on Claude Code's own feedback tool: the model drafts a report at a high-signal moment (a call failed in a way that is not your key, credits or a rate limit and you had to work around it; you asked for something no tool covers; a documented field came back empty or wrong; you were plainly frustrated with a result) into a local queue at `~/.redditapis/feedback-queue.json` (override with `REDDITAPIS_FEEDBACK_DIR`, at most 10 drafts), and nothing is sent until you review the queue and name the drafts to send. Each draft carries the last failing call's endpoint, status and request id, your MCP client's name and this package's version, filled in automatically, so a report is actionable without a follow-up. `reddit_feedback_send` takes `action` (`draft`, `list`, `send`, `discard`); `reddit_feedback_get` reads a sent report's status and the team's response. Both are free and need only your API key. The trigger list also ships as the server's MCP `instructions`, so a client that honours them nudges its model at the right moments, and every non-credential error body (anything but 401/402/429) now ends with a one-line pointer to the tool. This takes the catalog to 38 tools (34 documented in the table above plus the 4 cookie-authenticated user-history reads).
- **Catalog support for local handlers.** A tool may declare `local: "<handler>"` in `src/tools.js` and name its local-only args in `localArgs`; those args are consumed in this package and never sent to the API. `src/index.js` refuses to boot if a catalog entry names a handler it does not implement, and the catalog test pins that every `localArgs` entry is a real key of the tool's shape, so neither flag can turn into a silent passthrough.

### Fixed

- `test/smoke.mjs` asserted a tool count of 32 against a catalog of 36; it now derives the expected count from the catalog it lists.

## 0.3.0 (2026-08-16)

### Added

- **`exclude_subreddits` and `exclude_terms` on `reddit_monitor_add` and `reddit_monitor_update`.** Per-monitor subreddit exclusion for sitewide keyword watches, and term exclusion for every monitor. Published as a minor rather than a patch because a real capability was added; anyone pinned to 0.2.x opts in rather than receiving it silently. (This entry was written retroactively on 2026-09-04: the version shipped with no changelog line.)

## 0.2.0
- **10 new monitor/webhook management tools** (task #43), the first WRITES this
  catalog has ever carried. Unlike the reddit comment/vote/DM writes this MCP
  still excludes, these configure the caller's OWN redditapis.com account (an
  alerting subscription), never Reddit itself:
  - **`reddit_monitor_add`** / **`reddit_monitor_list`** / **`reddit_monitor_update`** /
    **`reddit_monitor_remove`** — create, list, update (pause/resume/re-filter/
    re-cadence), and permanently delete a monitor. Requires an active plan to
    create/update (monitoring has no free tier); reading your own list never does.
  - **`reddit_monitor_health`** — per-monitor delivered/failed/suppressed counts and
    whether the delivery ceiling has been hit.
  - **`reddit_monitor_deliveries`** — the actual Reddit posts a monitor's webhook
    has received, not just counts (task #47, the feature the operator asked for
    directly: "can they check which all posts their webhook has received").
  - **`reddit_monitor_webhook_create`** / **`reddit_monitor_webhook_list`** /
    **`reddit_monitor_webhook_test`** / **`reddit_monitor_webhook_delete`** —
    register a delivery target (secret shown once), list registered webhooks
    (secret never re-shown), send a one-off test delivery, and permanently
    delete one.
  - All 10 verified live end to end against production (real create/update/
    pause/resume/remove/re-add round trips, a real signed test delivery), not
    just unit-tested against a mock.
  - `remove`/`webhook_delete` are marked `destructive: true`; every write is
    `write: true`; every other tool remains a pure, `readOnlyHint: true` read.
  - Fixed two pre-existing drifts found while touching this file: the reported
    `VERSION` was hardcoded `"0.1.0"` while the package had shipped up to
    0.1.12 for months (now read live from package.json, so it can't drift
    again), and `test/tools.test.mjs` / `test/smoke.mjs` both hardcoded stale
    tool counts (12 and 11) against an actual catalog of 22 -- neither test
    file had been updated as the catalog grew.
  - Brings the tool count to 32 (22 reads + 10 monitor/webhook writes).

## 0.1.12
- reddit_search gains advanced filters applied to the returned page (the pullpush
  filter-power model): min_score/max_score, min_comments/max_comments, is_video,
  is_self, over_18, locked, stickied, spoiler, contest_mode, and sort_type
  (score/num_comments/created). Because filtering is post-hoc on a page, the
  response adds a meta object (fetched, returned, filtered_out); paginate with
  after to filter more. No price change ($0.002), no new endpoint.

## 0.1.11
- Two new read tools for subreddit governance (both $0.002, one upstream read each):
  - **`reddit_subreddit_moderators`** (`GET /api/reddit/sub/{name}/moderators`),
    a subreddit's moderator team: each moderator's username, id, mod permissions,
    flair text, and the time they were added. Returns a `moderators` list.
  - **`reddit_subreddit_wiki`** (`GET /api/reddit/sub/{name}/wiki/{page}`), a
    subreddit's wiki page by name and page: the page's markdown and HTML content,
    a may-revise flag, and the last revision's metadata. Returns a single object.
    The page may be multi-segment, for example index, rules, or config/sidebar.
  - Brings the published read-only tool count to 22.

## 0.1.10
- Three new read tools for community DISCOVERY (all $0.002, one upstream read each):
  - **`reddit_subreddits_popular`** (`GET /api/reddit/subreddits/popular`), browse
    the most-subscribed, trending subreddits right now, no keyword needed.
  - **`reddit_subreddits_new`** (`GET /api/reddit/subreddits/new`), browse the
    newest subreddits, the communities most recently created.
  - **`reddit_subreddits_default`** (`GET /api/reddit/subreddits/default`), browse
    Reddit's default front-page set of subreddits.
  - Each returns a `subreddits` list (same per-item shape as
    `reddit_subreddit_about`) plus an `after` cursor, and takes only `after` +
    `limit`. These BROWSE communities; `reddit_search_communities` SEARCHES by
    keyword. Brings the published read-only tool count to 20.

## 0.1.9
- Two new read tools (both $0.002, one upstream read each):
  - **`reddit_subreddit_rules`** (`GET /api/reddit/sub/{name}/rules`), a
    subreddit's posting rules: each rule's name, description, what it applies to
    (posts, comments, or all), violation reason, priority, and creation date,
    plus Reddit's site-wide rules. Check a community's rules before posting.
  - **`reddit_by_id`** (`GET /api/reddit/by_id/{fullnames}`) — bulk-fetch posts
    by comma-separated t3_ fullnames (up to 100) in one call. Same post shape as
    the subreddit listings. Hydrate ids you already have without a call per post.
  - Brings the published read-only tool count to 17.

## 0.1.8
- **`reddit_deep_comment_search`** gains a research mode: pass `group_by="author"`
  to get the distinct PEOPLE who mentioned your query (ranked by matching-comment
  count, then total score) instead of a flat comment list. Each author carries
  `comment_count`, `total_score`, the `subreddits` they matched in, and their
  `top_comment`. `max_authors` caps the people returned; `meta.authors_capped`
  flags a trim. `[deleted]` accounts are dropped. No price change (still $0.02).

## 0.1.7
- Three new read tools (all $0.002, one upstream read each):
  - **`reddit_user_submitted`** (`GET /api/reddit/user/{name}/submitted`) — a
    user's submitted POSTS, the sibling of `reddit_user_comments`. Same post
    shape as the subreddit listings.
  - **`reddit_subreddit_comments`** (`GET /api/reddit/sub/{name}/comments`), the
    subreddit NEW-COMMENT stream (every new comment across a community, not one
    post's thread). Same comment shape as `reddit_user_comments`.
  - **`reddit_subreddit_about`** (`GET /api/reddit/sub/{name}/about`), a
    subreddit's public metadata (title, public description, subscriber count,
    active-user count, creation date, type, NSFW flag). Returns a single object.
  - Brings the published read-only tool count to 15.

## 0.1.6
- `reddit_deep_comment_search` v1.1, driven by a customer report that there was
  no reliable way to expand a search past the first few posts:
  - **Pagination.** The response `after` cursor is now honoured on input — pass it
    back as `after` to expand the next batch of parent posts. Each call stays
    bounded, so a caller can page as deep as they want. (The cursor was previously
    returned but ignored.)
  - **`limit` cap raised 10 -> 25** parent posts per call.
  - **`max_comments`** optional cap on how many comments are returned; the
    highest-scored are kept.
  - Comments now come back **sorted by score** (highest first).
  - Honest completeness meta: `comments_matched` (found) vs `comments_returned`
    (after cap) vs `capped`, alongside `truncated`.
  - Matching now runs on the **visible comment text at word boundaries** (link
    URLs stripped), so a result always mentions the query where a reader can see
    it — fixes the false positives from matching inside link URLs / as substrings.

## 0.1.5
- Description honesty pass, three tool descriptions promised fields the live
  response does not return. All found by the new V-DESC gate
  (reconcile-description-shape.mjs), which probes EVERY tool against the live API
  and asserts no description claims a field the response lacks:
  - `reddit_search_media` claimed a `permalink`; the response carries `url`. Corrected.
  - `reddit_subreddit_posts` claimed `flair` and `media`; neither is in the
    `/posts` response (fields are title, author, upvotes, comments, permalink, url,
    text). Removed.
  - `reddit_post` claimed `body/selftext` and `media`; `/post/{id}` returns `text`
    (no `body`, no `selftext`, no `media`). Corrected to `text`.

## 0.1.4
- New tool `reddit_deep_comment_search`. Where `reddit_search_comments` returns
  the parent posts (Reddit's comment search never hands back the comment), this
  returns the ACTUAL matching comments with body, score, author, a comment-deep
  permalink, and the parent post. It fetches each matching post's comment tree
  and filters the bodies. Premium call (`limit` = parent posts to expand, 1-10).
  Best-effort: a deleted or deeply-nested comment may be missed. Also cross-links
  the two tools in their descriptions.

## 0.1.3
- `reddit_search_comments` description no longer overpromises. It previously
  claimed to "Return matching comments with author, body, score" and to find
  "opinions/answers buried in threads", but the endpoint returns PARENT POSTS,
  not comment objects: Reddit's comment search is a MODE that matches comment
  text and hands back the t3 posts, and does not expose which comment matched or
  its body. The openapi spec already said this; the MCP tool description and the
  README table had drifted and still promised comment bodies/scores the response
  never contained. A customer relied on the old text and reported it as a bug.
  The description now states the real behaviour. No API surface change.

## 0.1.2
- `reddit_search` and `reddit_search_comments` now describe the `t` time window
  accurately. Unlike a subreddit listing, search applies `t` to the `relevance`
  and `top` sorts as well, and when it is omitted Reddit defaults to `all` — so a
  broad relevance query surfaces old high-upvote posts that only loosely match.
  The tool description now says so, which materially changes the queries an agent
  writes. No API surface change.

## 0.1.1
- Corrected package metadata.


## 0.1.0
- Initial release: 11 read tools over the redditapis.com API (subreddit listings,
  post/comment/community/user/media search, comment tree, subreddit top posts,
  user profile + comments). Stdio transport, Bearer auth, per-request timeout.
