# Changelog

## 0.3.2
- **Security: 10 Dependabot alerts closed (3 high, 6 moderate, 1 low)**, all in
  transitive dependencies pulled in by `@modelcontextprotocol/sdk` (never a
  direct dependency of this package): `hono` (SSR output cross-user
  disclosure, ReDoS in CORS/language middleware, header handling in the proxy
  helper), `fast-uri` (host confusion via a backslash authority delimiter),
  `ip-address` (three separate SSRF/trust-boundary bypasses via octal,
  IPv4-mapped, and CIDR-suffix address confusion), and `@hono/node-server`
  (path traversal on Windows). Fixed by a clean reinstall against the
  existing `@modelcontextprotocol/sdk: ^1.0.0` range, which already permitted
  the patched versions; no version constraint changed, only the resolved
  tree (SDK 1.29.0 to 1.30.0, hono to 4.13.2, fast-uri to 3.1.5, ip-address
  to 10.5.0, @hono/node-server to 2.1.1). This server only imports the SDK's
  stdio transport (confirmed: `src/index.js` never imports `hono` or the
  SDK's HTTP transport), so `hono` and `@hono/node-server` never load at
  runtime here; `fast-uri` and `ip-address` sit deeper in the SDK's own
  dependency tree and were not individually traced. Fixed regardless, since
  Dependabot flags them independent of reachability and a clean scan is
  the point.

## 0.3.1
- **Fix: the server no longer exits at startup when `REDDITAPIS_KEY` is missing.**
  A registry connectivity scanner (Smithery, Glama, the official MCP registry,
  Claude Connectors Directory) spins up the server with no real credential to
  enumerate `tools/list`. Exiting before the transport connects made every
  automated scan fail outright and read as a generic connectivity error rather
  than a missing-key error, which is most of why this listing scored low on
  every registry's capability-quality checks. Tools now register and
  `tools/list` responds regardless of whether a key is present; an actual tool
  call with no key still fails clearly, at the point of the call, with the
  same style of message the existing 401 branch already used.
- Adds `server.json` (official MCP server manifest: description, homepage,
  repository, npm package identifier, and the `REDDITAPIS_KEY` config field
  with a title and description) to the repo and to the published package, so
  registry submissions have a durable, versioned source instead of a local,
  never-committed file.

## 0.3.0
- 4 new READ tools for the caller's own private Reddit listings (upvoted,
  saved, hidden, gilded), each requiring the caller's own Reddit session
  cookie obtained via `POST /api/reddit/login`.
- Pagination docs clarified across every listing tool: `listing_status` on the
  final page distinguishes `complete` (nothing missing) from `truncated`/
  `unknown` (Reddit stopped serving a busy listing early), so a client no
  longer reads a null `after` cursor as proof of a complete result set.
- This CHANGELOG entry is retroactive; 0.3.0 published without one, along with
  drifting one npm publish ahead of what GitHub had committed. Both are
  corrected as part of the 0.3.1 pass.

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
