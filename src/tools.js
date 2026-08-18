// Tool catalog + pure query/path builders for redditapis-mcp.
// Kept separate from the server wiring (index.js) so it can be unit-tested
// without spawning the stdio transport.
//
// Each tool maps 1:1 to a REST endpoint at https://api.redditapis.com/api/reddit.
// Tool arg names map 1:1 to endpoint query params, EXCEPT path params written as
// {name}/{id} in a tool's `path` (e.g. /api/reddit/sub/{name}/top), which are
// interpolated into the URL and removed from the query string.
//
// WRITES: reddit writes (comment/vote/DM -- posting AS the customer to Reddit
// itself) are a separate authenticated surface and remain intentionally out of
// scope here, that boundary is unchanged. Monitor/webhook management (2026-08-11,
// task #43) is a DIFFERENT kind of write: it configures the customer's OWN
// redditapis.com account (an alerting subscription), the same risk class as
// reading their own usage -- it never posts, votes, or DMs anywhere. Those tools
// are marked `write: true` (and `destructive: true` for remove/delete), which
// index.js turns into MCP's `readOnlyHint`/`destructiveHint` annotations so a
// client can surface a confirmation before calling them.
//
// BODY-BEARING TOOLS: a POST tool's args become a JSON request body instead of
// a query string (see buildBody below). `filterSpecFields` on a tool declares
// which of its args nest under `filter_spec` in that body; everything else in
// `shape` stays top-level (id, cadence_s, active, url, kind, ...).
import { z } from "zod";

// Shared Zod input-schema fragments.
const LIMIT = {
  limit: z.number().int().min(1).max(100).optional().describe(
    "Max items to return (1 to 100). The API clamps out-of-range values; endpoint default applies if omitted.",
  ),
};
// Shared by every listing and search tool, so the rule about what an EMPTY
// cursor means is stated once rather than pasted into a dozen tool descriptions
// where one of them would eventually be missed.
const AFTER = {
  after: z.string().optional().describe(
    "Opaque pagination cursor. Pass back the previous response's `after` value EXACTLY as it was returned; the format is not stable and a hand-written Reddit fullname loses the paging depth the cursor carries. Omit on the first call. " +
      "When `after` comes back null there is no next page to request, and that does NOT reliably mean you have every item: Reddit often stops serving a busy listing long before it runs out. Read `listing_status` on that final response instead. It is `complete`, `truncated` or `unknown`, and ONLY `complete` means nothing is missing. Never report `truncated` or `unknown` to a user as the end of the data; say the answer is partial and widen across sorts, timeframes or search terms.",
  ),
};
// Sort vocabularies differ by endpoint (they map to different Reddit listings):
// posts/listings, search, and user-comments each accept a distinct set.
const SORT_POSTS = {
  sort: z.enum(["new", "hot", "top", "rising", "controversial", "best"]).optional().describe(
    "Sort order for a subreddit listing. 'hot' = trending now, 'new' = most recent (default), 'top' = highest score in the `t` window, 'rising' = gaining fast, 'controversial' = polarizing, 'best' = Reddit's blended rank.",
  ),
};
const SORT_SEARCH = {
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional().describe(
    "Sort order for search. 'relevance' = best match (default), 'top' = highest score in the `t` window, 'new' = most recent, 'hot' = trending, 'comments' = most-discussed.",
  ),
};
const SORT_USER = {
  sort: z.enum(["new", "hot", "top", "controversial"]).optional().describe(
    "Sort order for a user's comments. 'new' = most recent (default), 'hot', 'top' (in the `t` window), 'controversial'.",
  ),
};
const TIME = {
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe(
    "Time window, only applied when sort is 'top' or 'controversial'. E.g. 'week' = top of the past week. Ignored for other sorts.",
  ),
};
// Search honours `t` differently from a subreddit listing: it bounds the whole
// result set (including the 'relevance' and 'top' sorts), not just top/controversial.
// Omitting it makes Reddit default to 'all', which lets old high-upvote posts win a
// broad 'relevance' query, so search gets a separate, search-accurate description.
const TIME_SEARCH = {
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe(
    "Time window that bounds which posts the search returns, e.g. 'week' = only posts from the past week. Unlike a subreddit listing, search applies this to the 'relevance' and 'top' sorts too. When omitted, Reddit defaults to 'all', so a broad 'relevance' query surfaces old high-upvote posts that only loosely match. Pass 'week' or 'month' to keep results recent and on-topic.",
  ),
};
const NSFW = {
  nsfw: z.enum(["true", "false"]).optional().describe(
    "Set 'true' to include over-18 / NSFW results. Omit or 'false' to exclude them (default).",
  ),
};
const QUERY = {
  q: z.string().min(1).describe(
    "Search query text. Supports Reddit search syntax (e.g. `subreddit:webdev`, `author:spez`, `\"exact phrase\"`, `title:...`).",
  ),
};
// Auth-scoped private-listing cookie fragment (upvoted/saved/hidden/gilded).
// These four are READS, but of PRIVATE data Reddit only serves to the account
// that owns it, so -- unlike every other read tool above -- they need the
// caller's own Reddit session cookies, obtained from POST /api/reddit/login
// (a REST call, not an MCP tool here). GET can't carry cookies as a body, so
// they travel as flat query-string args, same convention routes/vote.js uses
// for its flat POST-body cookie fields.
const LISTING_COOKIES = {
  reddit_session: z.string().min(1).describe(
    "Reddit account session cookie. Obtain it by calling POST /api/reddit/login on the REST API first (not an MCP tool) and reusing the `reddit_session` cookie it returns. Required.",
  ),
  loid: z.string().min(1).describe(
    "Reddit account loid cookie, from the same POST /api/reddit/login response. Required.",
  ),
  csrf_token: z.string().optional().describe(
    "Reddit CSRF cookie, from the same login response. Not required for a read (CSRF only guards state-changing calls) but harmless to pass if you have it.",
  ),
};

// ── monitoring filter_spec fragments, shared by monitor_add and monitor_update ──
// v1 is SUBREDDIT-SCOPED ONLY (all-Reddit keyword monitoring is not available),
// matching apps/api/src/lib/monitor-filter.js's own validation exactly, so a
// tool call fails fast in the client rather than round-tripping a 400.
//
// THE "POSTS ONLY" HALF OF THIS COMMENT WAS STALE AND COST A REAL GAP. It said
// comment monitoring was "validated but rejected server-side", which stopped
// being true when comment monitoring shipped (migrations 009/010, PRs
// #532/#537/#541). Because `kind` was never added here, the capability was
// unreachable from MCP entirely: verified live 2026-08-13 by setting
// filter_spec.kind="both" over raw REST and watching real comment deliveries
// land within two minutes, on a tier the pricing page sells as "posts and
// comments". A stale comment is a defect report, not documentation.
// SITEWIDE (2026-08-13). `subreddit` is OPTIONAL now: omit it and pass `q` to
// watch ALL of Reddit for that keyword. Leaving it required here would repeat
// the exact failure the comment above describes -- a shipped, sold capability
// that no MCP client can reach because one schema field was never relaxed,
// with nothing anywhere reporting an error.
const MONITOR_SUBREDDIT_DESC =
  "Subreddits to watch, without the r/ prefix (e.g. ['SaaS', 'startups']). 1 to 50. " +
  "OMIT this entirely (and set `q`) to watch ALL of Reddit for a keyword -- a monitor must be anchored by " +
  "either a subreddit list or a keyword, never neither. Do NOT pass ['all']: r/all is Reddit's site-wide " +
  "listing rather than a subreddit, so it is refused with 400 subreddit_reserved. Sitewide monitors are " +
  "capped per plan tier (see reddit_monitor_list's `slots`) and cover POSTS only.";
const MONITOR_SUBREDDIT = {
  subreddit: z.array(z.string().min(1)).min(1).max(50).optional().describe(MONITOR_SUBREDDIT_DESC),
};
const MONITOR_FILTER_FIELDS = {
  // SITEWIDE ONLY BY DESIGN, and the description says so in the first clause
  // because an agent that passes it alongside `subreddit` gets a 400 and needs
  // to know from the schema, not from the error, which of the two to drop.
  exclude_subreddits: z.array(z.string().min(1)).max(50).optional().describe(
    "Subreddits to SUPPRESS, without the r/ prefix (e.g. ['politics', 'AskReddit']). SITEWIDE MONITORS ONLY: pass this only when you have OMITTED `subreddit` and anchored the monitor with `q`. Passing it together with `subreddit` is rejected with a field-level 400 -- a monitor that names its subreddits should drop the unwanted name from that list instead. Up to 50, matched exactly like `subreddit` so 'r/Politics', '/r/politics' and 'politics' are one entry. This is the noise control for an all-of-Reddit keyword watch: it filters DELIVERY only, so it never changes what is polled, never frees quota, and never affects matching in any other subreddit. Independent of exclude_terms -- an item is dropped if either fires.",
  ),
  q: z.string().max(200).optional().describe(
    "Free-text keyword or phrase to match. Matched against the fields in `search_in` (default title+body+url). Omit to match every new post in the watched subreddits.",
  ),
  author: z.string().max(200).optional().describe("Only match posts by this Reddit username (without u/)."),
  exclude_terms: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "Posts containing any of these terms are suppressed even if they otherwise match. Use to cut noise (e.g. exclude 'giveaway' from a brand-mention monitor).",
  ),
  domain: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "Outbound link domains to watch for (e.g. ['example.com']). Matches the post's link URL, any URL inside a self-post/comment body, and a crosspost's original link, including one that only appeared in the original post's body. Exact-or-subdomain match only: 'example.com' matches 'blog.example.com' but never 'notexample.com'. Does NOT resolve shortened links (bit.ly, t.co).",
  ),
  include_any: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "At least ONE of these terms must appear (OR match) for the post to qualify, on top of any `q`."
  ),
  include_all: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "EVERY one of these terms must appear (AND match) for the post to qualify, on top of any `q`."
  ),
  search_in: z.array(z.enum(["title", "body", "url", "permalink"])).min(1).optional().describe(
    "Which fields keyword/term matching is scoped to. Default ['title', 'body', 'url']. Narrow to avoid false positives, e.g. a term that only appears in a URL slug matching a post that never mentions it in prose. All four resolve on comments as well as posts: on a comment, 'title' matches the title of the THREAD the comment sits under (a comment has no title of its own), which also applies through the default scope and can deliver every comment under a busy matching thread. Scope to ['body'] if you only want comments that say the term themselves.",
  ),
  group: z.string().max(64).optional().describe(
    "Optional label to bundle multiple matches into one delivery instead of one webhook call per match. Omit for one delivery per matching item.",
  ),
  kind: z.enum(["post", "comment", "both"]).optional().describe(
    "What to watch in the named subreddits: 'post' (default when omitted), 'comment', or 'both'. Comment monitoring requires a Growth, Pro or Scale plan -- on a lower tier this returns `comment_monitoring_requires_higher_tier` (402). Comments run roughly 7x the volume of posts, so expect proportionally more deliveries and check reddit_monitor_health's delivery ceiling before enabling it on a busy subreddit.",
  ),
  min_score: z.number().int().optional().describe("Only match posts with at least this many upvotes."),
  nsfw: z.boolean().optional().describe("Set false to EXCLUDE NSFW/over-18 posts. Omitted or true both mean NSFW is allowed through -- there is no exclude-by-default; you must explicitly pass false to filter it out. POSTS ONLY: nsfw=false is REJECTED with a field-level 400 when kind is 'comment' or 'both', because Reddit flags NSFW on a post and never on an individual comment, so there is no field to filter a comment on. Run a kind='post' monitor to keep NSFW filtering, and cut unwanted comment text with exclude_terms."),
};
// Per-monitor webhook targeting (task #66, migration 009). NOT a filter_spec
// field -- stays top-level in the request body, same as cadence_s/active, so
// it is deliberately absent from MONITOR_FILTER_FIELDS/filterSpecFields.
const MONITOR_WEBHOOK_IDS = {
  webhook_ids: z.array(z.string().min(1)).max(20).optional().describe(
    "Restrict delivery to specific webhook(s) instead of every active webhook on the account. Pass id(s) from reddit_monitor_webhook_create/reddit_monitor_webhook_list. Omit (or pass an empty array) for the default: deliver to every active webhook you've registered. Every id must be a webhook you own -- returns `webhook_not_found` (400) otherwise.",
  ),
};
const MONITOR_ID = {
  id: z.string().min(1).describe("The monitor's id, from reddit_monitor_add's response or reddit_monitor_list."),
};
const WEBHOOK_ID = {
  id: z.string().min(1).describe("The webhook's id, from reddit_monitor_webhook_create's response or reddit_monitor_webhook_list."),
};

// The tool catalog. Path params are {name}/{id} placeholders. Monitor/webhook
// tools additionally carry `write`/`destructive` and, for POST tools whose
// body nests a filter_spec, `filterSpecFields` (see buildBody below).
export const TOOLS = [
  {
    name: "reddit_subreddit_posts",
    path: "/api/reddit/posts",
    description:
      "List posts from a subreddit by sort order. Use this to read a community's feed: newest, hot/trending, top-of-week, rising, etc. Returns post title, author, score, comment count, and permalink, plus an `after` cursor for paging. When `after` comes back null the response carries `listing_status`: `complete` means no older posts and is only claimed when the whole run came back in under one page, `truncated` means Reddit's cap cut you off, and `unknown` means we cannot tell, so do NOT report `unknown` as the end of the data. A busy feed that Reddit simply stops serving reports `unknown`, not `complete`, so treat `unknown` as an incomplete answer and widen across sorts, timeframes or search rather than paging deeper. Example: subreddit='programming' sort='top' t='week'.",
    shape: {
      subreddit: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'programming', 'AskReddit'). Required.",
      ),
      ...SORT_POSTS,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_search",
    path: "/api/reddit/search",
    description:
      "Search Reddit posts across all of Reddit or within one subreddit. Returns matching posts with author, score, comments, permalink, and an `after` cursor. Use for topic/keyword research, brand monitoring, or finding discussions. Scope to a community with `subreddit`. Optional advanced filters narrow the results by minimum/maximum score, comment count, media type, and post flags, with an optional re-sort of the page. Because filters are applied to the returned page, the response then carries a `meta` object with page-completeness counts, so a filtered result is never mistaken for the whole set; paginate with `after` to filter more. Example: q='rust vs go' sort='top' t='year'.",
    shape: {
      ...QUERY,
      subreddit: z.string().optional().describe(
        "Optional subreddit name (without r/) to restrict the search to one community. Omit to search all of Reddit.",
      ),
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...AFTER,
      ...NSFW,
      ...LIMIT,
      min_score: z.number().int().optional().describe("Keep only posts with score >= this (applied to the returned page)."),
      max_score: z.number().int().optional().describe("Keep only posts with score <= this."),
      min_comments: z.number().int().optional().describe("Keep only posts with comment count >= this."),
      max_comments: z.number().int().optional().describe("Keep only posts with comment count <= this."),
      is_video: z.boolean().optional().describe("true = only video posts, false = only non-video."),
      is_self: z.boolean().optional().describe("true = only self/text posts, false = only link posts."),
      over_18: z.boolean().optional().describe("Filter the page by NSFW flag (distinct from nsfw, which controls inclusion in the search)."),
      locked: z.boolean().optional().describe("Filter by the locked flag."),
      stickied: z.boolean().optional().describe("Filter by the stickied flag."),
      spoiler: z.boolean().optional().describe("Filter by the spoiler flag."),
      contest_mode: z.boolean().optional().describe("Filter by the contest_mode flag."),
      sort_type: z.enum(["score", "num_comments", "created"]).optional().describe("Re-sort the filtered page (descending) by this field."),
    },
  },
  {
    name: "reddit_post_comments",
    path: "/api/reddit/comments",
    description:
      "Fetch a single post and its comment tree by permalink. Returns the post plus threaded comments (author, body, score, replies) and an `after` cursor. Use after finding a post via search/listing to read the full discussion. Pass the post's `permalink` from a prior result.",
    shape: {
      permalink: z.string().min(1).describe(
        "The post permalink path from a prior post result, e.g. '/r/programming/comments/abc123/some_title/'. Required.",
      ),
    },
  },
  {
    name: "reddit_search_communities",
    path: "/api/reddit/search/communities",
    description:
      "Search for subreddits (communities) by name or topic. Returns matching subreddits with title, subscriber count, description, and NSFW flag. Use to discover where a topic is discussed before listing or searching its posts. Example: q='machine learning'.",
    shape: { ...QUERY, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_search_comments",
    path: "/api/reddit/search/comments",
    description:
      "Search Reddit by COMMENT text. Reddit's comment search matches your keyword against comment bodies but returns the PARENT POSTS, not the individual comments, so each result is a post whose discussion mentions your query, carrying that post's title, selftext, score, and comment count. Use it to surface threads where a topic comes up in the replies that plain post-title search would miss. Reddit does not expose which specific comment matched or its text, so this returns posts, not comment bodies. For the actual comment bodies, use reddit_deep_comment_search. Example: q='best mechanical keyboard' sort='top'.",
    shape: { ...QUERY, ...SORT_SEARCH, ...TIME_SEARCH, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_deep_comment_search",
    path: "/api/reddit/search/comments/deep",
    description:
      "Genuine comment search: returns the ACTUAL comments whose body matches your keyword, sorted by score (highest first), with body, score, author, a comment-deep permalink, and the parent post. Unlike reddit_search_comments (which returns the parent posts, a Reddit limitation), this fetches each matching post's comment tree and filters the comment bodies for you, so you get first-hand opinions and answers directly. Premium call (it fans out into several reads): `limit` sets how many parent POSTS to expand, 1-25 (default 5), not how many comments come back. To go deeper than one call, paginate: pass the response's `after` cursor back as `after` to expand the NEXT batch of parent posts. `max_comments` optionally caps how many comments come back (the top-scored are kept). Matching is on the visible comment text at word boundaries (link URLs are ignored), so a result always mentions your query where a reader can see it. Best-effort: a deleted or deeply-nested comment may be missed (meta.truncated flags when a tree was too deep). Set group_by='author' for the research mode that returns WHO is talking about your query (distinct people ranked by matching-comment count) instead of a flat comment list, capped by max_authors. Example: q='best mechanical keyboard' sort='top'.",
    shape: {
      ...QUERY,
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...NSFW,
      ...AFTER,
      limit: z.number().int().min(1).max(25).optional().describe(
        "Number of parent POSTS to expand into their comment trees (1-25, default 5). Each is one upstream read, so higher = deeper coverage but slower and more expensive. To go past 25, paginate with `after`.",
      ),
      max_comments: z.number().int().min(1).optional().describe(
        "Optional cap on how many comments are returned; the highest-scored are kept. Omit to return every match. meta.capped is true when this trimmed the result.",
      ),
      group_by: z.enum(["author"]).optional().describe(
        "Set to 'author' for the RESEARCH mode: instead of a flat comment list, return the distinct PEOPLE who mentioned your query, ranked by how many of their comments matched (then total score). Each author has comment_count, total_score, the subreddits they matched in, and their top comment. Omit for the normal comment list.",
      ),
      max_authors: z.number().int().min(1).optional().describe(
        "Only with group_by='author'. Optional cap on how many people are returned (the most prolific first). Omit to return everyone. meta.authors_capped is true when this trimmed the list.",
      ),
    },
  },
  {
    name: "reddit_search_media",
    path: "/api/reddit/search/media",
    description:
      "Search Reddit posts filtered to media (images, video, gifs). Returns media posts with the media URL/type, author, score, and the post url. Use `kind` to narrow to a media type. Example: q='aurora borealis' kind='image'.",
    shape: {
      ...QUERY,
      kind: z.enum(["image", "video", "gif", "all"]).optional().describe(
        "Media type filter. 'image', 'video', 'gif', or 'all' (default). Filters the raw Reddit results to that media kind.",
      ),
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...AFTER,
      ...NSFW,
      ...LIMIT,
    },
  },
  {
    name: "reddit_search_users",
    path: "/api/reddit/search/users",
    description:
      "Search for Reddit users (redditors) by name or keyword. Returns matching accounts with username, karma, and account age. Use to find a person's handle before fetching their profile or comments. Example: q='spez'.",
    shape: { ...QUERY, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_subreddit_top",
    path: "/api/reddit/sub/{name}/top",
    description:
      "Get the TOP posts of a subreddit for a time window. Shorthand for the highest-scoring posts of a community. Returns posts with score, author, comments, and permalink plus an `after` cursor. Example: name='science' t='month'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'science'). Required (path parameter).",
      ),
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_post",
    path: "/api/reddit/post/{id}",
    description:
      "Fetch a single Reddit post by its id. Returns the full post object (title, author, score, text, permalink, subreddit, url). Use when you already have a post id and want its details. Example: id='abc123' (the base-36 id, no t3_ prefix).",
    shape: {
      id: z.string().min(1).describe(
        "The post's base-36 id (e.g. 'abc123'), without the 't3_' fullname prefix. Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_user_profile",
    path: "/api/reddit/user/{name}",
    description:
      "Fetch a Reddit user's public profile by username. Returns account info: username, id, karma (post + comment), account age, verified/employee flags, and avatar. Use to vet or summarize a redditor. Example: name='spez'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_user_comments",
    path: "/api/reddit/user/{name}/comments",
    description:
      "List a Reddit user's recent comments. Returns comments with body, score, subreddit, parent link, and timestamp plus an `after` cursor. Use to understand what a redditor talks about or to gather their opinions. Example: name='spez' sort='top'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
      ...SORT_USER,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_submitted",
    path: "/api/reddit/user/{name}/submitted",
    description:
      "List a Reddit user's submitted POSTS (their post history, the sibling of reddit_user_comments). Returns posts with title, author, score, comment count, and permalink, plus an `after` cursor. Use to see what a redditor posts, not just what they comment on. Example: name='spez' sort='top'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_upvoted",
    path: "/api/reddit/user/{name}/upvoted",
    description:
      "List the posts and comments a Reddit account has UPVOTED. PRIVATE data -- Reddit only serves it to the account that owns it, so you must be logged in as `name` (see the `reddit_session`/`loid` args) or this returns 403. Mixed listing: each item is a post or a comment, tagged `kind`. Requires calling POST /api/reddit/login on the REST API first to get session cookies (not an MCP tool). Example: name='spez' (must match the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix. Must be the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_saved",
    path: "/api/reddit/user/{name}/saved",
    description:
      "List the posts and comments a Reddit account has SAVED. PRIVATE data -- Reddit only serves it to the account that owns it, so you must be logged in as `name` (see the `reddit_session`/`loid` args) or this returns 403. Mixed listing: each item is a post or a comment, tagged `kind`. Requires calling POST /api/reddit/login on the REST API first to get session cookies (not an MCP tool). Example: name='spez' (must match the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix. Must be the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_hidden",
    path: "/api/reddit/user/{name}/hidden",
    description:
      "List the posts and comments a Reddit account has HIDDEN. PRIVATE data -- Reddit only serves it to the account that owns it, so you must be logged in as `name` (see the `reddit_session`/`loid` args) or this returns 403. Mixed listing: each item is a post or a comment, tagged `kind`. Requires calling POST /api/reddit/login on the REST API first to get session cookies (not an MCP tool). Example: name='spez' (must match the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix. Must be the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_gilded",
    path: "/api/reddit/user/{name}/gilded",
    description:
      "List the posts and comments a Reddit account has received an award (gold) on. PRIVATE data -- Reddit only serves it to the account that owns it, so you must be logged in as `name` (see the `reddit_session`/`loid` args) or this returns 403. Mixed listing: each item is a post or a comment, tagged `kind`. Requires calling POST /api/reddit/login on the REST API first to get session cookies (not an MCP tool). Example: name='spez' (must match the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix. Must be the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_subreddit_comments",
    path: "/api/reddit/sub/{name}/comments",
    description:
      "Stream the NEWEST comments across an entire subreddit (Reddit's /r/<name>/comments feed), not one post's thread. Returns comments with body, author, score, subreddit, the parent post link, and timestamp, plus an `after` cursor. Poll it to catch new comments in a community as they are posted. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_subreddit_about",
    path: "/api/reddit/sub/{name}/about",
    description:
      "Fetch a subreddit's public metadata by name (Reddit's /r/<name>/about data). Returns the subreddit's title, public description, subscriber count, active-user count, creation timestamp, type, and NSFW flag. Use it to size or vet a community before listing or searching its posts. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_rules",
    path: "/api/reddit/sub/{name}/rules",
    description:
      "Fetch a subreddit's posting rules by name (Reddit's /r/<name>/about/rules data). Returns a `rules` list, each with name, description, what it applies to (posts, comments, or all), violation reason, priority, and creation date, plus a `site_rules` list of Reddit's site-wide rules. Use it to check a community's rules before posting or commenting. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_moderators",
    path: "/api/reddit/sub/{name}/moderators",
    description:
      "Fetch a subreddit's moderator team by name (Reddit's /r/<name>/about/moderators data). Returns a `moderators` list, each with `name`, `id`, `mod_permissions`, `flair_text`, and `added` (when they joined the mod team). Use it to see who moderates a community. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_wiki",
    path: "/api/reddit/sub/{name}/wiki/{page}",
    description:
      "Fetch a subreddit's wiki page by name and page (Reddit's /r/<name>/wiki/<page> data). Returns a single object with `content_md` and `content_html`, a `may_revise` flag, and the last revision (`revision_id`, `revision_date`, `revised_by`, `reason`). Use it to read a community's wiki, such as its rules or FAQ. The page may be multi-segment, for example index, rules, or config/sidebar. Example: name='python', page='index'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
      page: z.string().min(1).describe(
        "Wiki page name (e.g. 'index'). Required (path parameter). May be multi-segment like 'config/sidebar'.",
      ),
    },
  },
  {
    name: "reddit_by_id",
    path: "/api/reddit/by_id/{fullnames}",
    description:
      "Bulk-fetch posts by their t3_ fullnames in ONE call (up to 100), instead of a request per post. Pass a comma-separated list of fullnames you already have from a search or listing to hydrate them. Returns posts with title, author, score, comment count, and permalink, the same post shape as the listing endpoints. The result is NOT always one-to-one with your request, so read `meta`: `listing_status` is `complete` only when every fullname came back, `truncated` is the boolean to branch on, and `missing_fullnames` names exactly which ids did not. Example: fullnames='t3_abc123,t3_def456'.",
    shape: {
      fullnames: z.string().min(1).describe(
        "Comma-separated post fullnames, each a t3_ prefix followed by the base-36 id (e.g. 't3_abc123,t3_def456'). Up to 100. Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddits_popular",
    path: "/api/reddit/subreddits/popular",
    description:
      "Browse the most-subscribed, trending subreddits right now, no keyword needed. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging. This BROWSES communities by popularity; use reddit_search_communities instead to SEARCH communities by keyword.",
    shape: { ...AFTER, ...LIMIT },
  },
  {
    name: "reddit_subreddits_new",
    path: "/api/reddit/subreddits/new",
    description:
      "Browse the newest subreddits, the communities most recently created, no keyword needed. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging. This BROWSES communities by recency; use reddit_search_communities instead to SEARCH communities by keyword.",
    shape: { ...AFTER, ...LIMIT },
  },
  {
    name: "reddit_subreddits_default",
    path: "/api/reddit/subreddits/default",
    description:
      "Browse Reddit's default front-page set of subreddits, no keyword needed. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging. This BROWSES the default communities; use reddit_search_communities instead to SEARCH communities by keyword.",
    shape: { ...AFTER, ...LIMIT },
  },

  // ── monitoring: manage the caller's own account, never posts/votes/DMs Reddit itself ──
  {
    name: "reddit_monitor_add",
    path: "/api/reddit/monitor/add",
    method: "POST",
    write: true,
    filterSpecFields: ["subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms", "domain", "include_any", "include_all", "search_in", "group", "min_score", "nsfw"],
    description:
      "Create a new Reddit monitor: watch one or more subreddits, or ALL of Reddit, for new posts (or comments, via `kind`) matching a filter, and get every match delivered to a webhook you've registered with reddit_monitor_webhook_create. Omit `subreddit` and set `q` for a sitewide keyword monitor covering every subreddit at once (posts only). By default matches go to EVERY active webhook on your account; pass `webhook_ids` to route this monitor's matches to only specific webhook(s). Every redditapis.com account holds a free entitlement of ONE all-of-Reddit post watch at a 60s cadence (up to 10,000 deliveries a day), so no subscription is needed to create that monitor. Naming a `subreddit`, matching comments, a faster cadence and any additional watch require a paid plan. Needs at least one monitor slot free (see reddit_monitor_list's `slots`). Forward-looking only from the moment of creation, or from `baseline_item_id` if given -- it never backfills posts that already existed. Returns the created monitor (with its `id`) on success, or `subscription_required` (402) if the account holds no recognised entitlement at all, `subreddit_scope_requires_paid_plan` (402) if a free account named a `subreddit`, `monitor_slots_exhausted` (402) if the plan's slot limit is reached, `sitewide_slots_exhausted` (402) if the plan's separate sitewide cap is reached, `distinct_subreddit_limit_reached` (402) if the account already watches as many DIFFERENT subreddits as the plan covers (the limit counts distinct subreddits across all your monitors, not monitors, and the same subreddit in two monitors counts once; see reddit_monitor_list's `slots.distinct_subreddits_total`), `sitewide_comment_monitoring_not_available` (501) if a sitewide monitor asks for comments, `subreddit_reserved` (400) if `subreddit` names 'all', `subreddit_not_found` (400) if a named subreddit does not exist, or `webhook_not_found` (400) if a `webhook_ids` entry is not yours.",
    shape: {
      ...MONITOR_SUBREDDIT,
      ...MONITOR_FILTER_FIELDS,
      cadence_s: z.number().int().positive().optional().describe(
        "Requested poll interval in seconds. May only be SLOWER than the plan tier's floor, never faster -- a too-low value is silently clamped up to the tier's minimum. Omit to use the tier's default.",
      ),
      baseline_item_id: z.string().optional().describe(
        "A Reddit post fullname (e.g. 't3_abc123') to use as the starting point instead of 'now' -- matching starts strictly after this item. Omit to start from the moment of creation.",
      ),
      ...MONITOR_WEBHOOK_IDS,
    },
  },
  {
    name: "reddit_monitor_list",
    path: "/api/reddit/monitor/list",
    description:
      "List every monitor on the caller's account, with each one's filter, active state, and cadence, plus a `slots` object ({used, total, tier}) showing how many monitor slots are purchased vs in use. Reading your own list never requires an active plan (a lapsed subscription shows an empty or paused list, not an error). `webhook_ids` NULL DOES NOT MEAN THE MONITOR HAS NO DESTINATION: null is the default and means matches go to EVERY active webhook on the account, which is the normal healthy state. A non-empty array narrows delivery to just those webhook ids. Never report a monitor as having no delivery target on the strength of a null here -- to see where a monitor's matches actually went, read reddit_monitor_deliveries, whose rows carry the resolved `webhook_id`.",
    shape: {},
  },
  {
    name: "reddit_monitor_update",
    path: "/api/reddit/monitor/update",
    method: "POST",
    write: true,
    filterSpecFields: ["subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms", "domain", "include_any", "include_all", "search_in", "group", "min_score", "nsfw"],
    description:
      "Update an existing monitor: pause/resume it (`active`), change its poll interval (`cadence_s`), switch between posts and comments (`kind`), replace its filter entirely, or re-target which webhook(s) it delivers to (`webhook_ids`). IMPORTANT: if you pass ANY filter field (subreddit, q, kind, domain, etc.), it REPLACES the whole filter, it does not merge with the existing one -- resupply every field you want kept, including `subreddit` AND `kind` (omitting `kind` reverts that monitor to posts-only). Same rule for `webhook_ids`: passing it REPLACES the monitor's targeting outright (an empty array clears back to 'every active webhook'); omitting it entirely leaves the monitor's existing targeting untouched. Omit all filter/webhook_ids fields to change only `active`/`cadence_s`. Returns 404 `monitor_not_found` if the id does not exist or is not yours, or 400 `webhook_not_found` if a `webhook_ids` entry is not yours.",
    shape: {
      ...MONITOR_ID,
      ...{
        subreddit: z.array(z.string().min(1)).min(1).max(50).optional().describe(
          MONITOR_SUBREDDIT_DESC +
            " On an update, omitting this while passing another filter field makes the monitor SITEWIDE (the filter is replaced wholesale, not merged), so resupply it if you meant to keep the monitor scoped.",
        ),
      },
      ...MONITOR_FILTER_FIELDS,
      active: z.boolean().optional().describe("Set false to pause the monitor (stops matching/delivering), true to resume it."),
      cadence_s: z.number().int().positive().optional().describe("New poll interval in seconds, same tier-floor clamping as reddit_monitor_add."),
      ...MONITOR_WEBHOOK_IDS,
    },
  },
  {
    name: "reddit_monitor_remove",
    path: "/api/reddit/monitor/remove",
    method: "POST",
    write: true,
    destructive: true,
    description:
      "Delete a monitor. There is no undo endpoint -- it stops matching immediately, its slot is freed for a new monitor, and it disappears from reddit_monitor_list. Its past deliveries are NOT erased: they remain queryable via reddit_monitor_deliveries (both scoped by monitor_id and in the aggregate, no-id view) forever. Returns 404 `monitor_not_found` if the id does not exist or is not yours.",
    shape: { ...MONITOR_ID },
  },
  {
    name: "reddit_monitor_health",
    path: "/api/reddit/monitor/health",
    description:
      "Per-monitor health: whether it's active, its poll cadence, when it last matched something, and delivery counts for the last 24h (`delivered_24h`, `failed_24h`, `suppressed_24h`) plus whether its delivery ceiling has been hit (`ceiling_reached`) and what that ceiling is (`daily_delivery_ceiling`). `suppressed_24h` COUNTS TWO DIFFERENT THINGS AND `suppressed_breakdown` SPLITS THEM: `ceiling` (the monitor's daily cap was reached) and `stale` (the item was already older than the freshness window when we first saw it, so it was withheld rather than delivered as if it were new). A stale withhold is the usual reason a monitor's delivered count sits far below its matched count with no error anywhere, and it is the freshness gate working as intended -- nothing failed, the endpoint is fine, no limit on the plan rejected them, and retrying cannot recover the items. Do NOT read `suppressed_24h > 0` as 'this monitor is over its limit': `ceiling_reached` is the field that answers that, and a stale withhold deliberately does not set it. When `suppressed_breakdown.resolved` is false the counts do not add up to the total and `unresolved_reason` says why, so do not report a split off them; `ceiling_reached` stays conservative in that case rather than being cleared. THOSE COUNTS ONLY COVER POSTS WE FETCHED. A post we never fetched was never matched and leaves no row behind, so it is absent from all three counters rather than counted in any of them -- zeros there mean 'no matches recorded', never 'nothing was missed'. `coverage_24h` is the separate field that speaks to fetching, and its `status` is the one to read first: `complete` (every poll reached the point where the previous poll finished), `degraded` (at least one poll was truncated and posts were lost unrecoverably -- see `gaps[]`, `posts_in_window_at_least` and the estimated `posts_missed_estimate`), `partial` (nothing found, but not every kind of loss was checked -- see `unobserved_events`), or `unknown` (the check could not be run at all -- see `reason`). Do NOT report a monitor as healthy on `unknown` or `partial`, and do not treat a null count as zero: both mean the question went unanswered. `coverage_24h` is fed by the poll log and covers BOTH ways a poll loses posts unrecoverably (`listing_exhausted`, where Reddit stopped serving older posts, and `poll_overflow`, where the feed outran one poll's page budget); `observed_events` names what was actually checked, and a status of `complete` is only ever awarded when both were. WHAT `complete` DOES AND DOES NOT ESTABLISH: it means every poll that RAN got back to where the previous poll finished, AND that every feed was actually polled. The second half is `stream_liveness`, the field to read FIRST. `coverage_24h` is computed from the poll log, and a feed that is never polled writes nothing to that log, so it records no truncated poll and the coverage read comes back clean -- identical to a healthy monitor. `stream_liveness` reads a different source (the polling registry plus the per-feed last-successful-poll stamp), neither of which a poll that never ran can produce. Its `status` is `live` (every feed checked within three times its own interval), `degraded` (at least one is not: see `streams[]` for `never_polled`, `stalled` or `unregistered` per feed), or `unknown` (could not be established, including `streams_awaiting_first_poll` on a monitor created moments ago, which clears itself). `coverage_24h` can never read `complete` while this is anything but `live`. Do NOT report a monitor as healthy unless `stream_liveness.status` is `live`, and do not read a zero delivery count on a `never_polled` feed as a quiet subreddit: nothing was checked, so nothing could match. `gaps[]` IS A SAMPLE, NOT THE WHOLE LIST: it carries the most recent gaps only, `gaps_returned` says how many are in it, `gaps_truncated` says whether more exist, and `gap_events_24h` is always the true total. Count gaps from `gap_events_24h` and never from the length of `gaps[]`. FINALLY, `cadence` ANSWERS 'AM I BEING CHECKED AS OFTEN AS I PAY TO BE', which none of the fields above can. Cadence is a priced feature, so this is the field that says whether the monitor is being served the interval its plan sells. `promised_cadence_s` is the floor the account's CURRENT plan includes and `requested_cadence_s` is what this monitor is actually set to; `meets_entitlement` false means the monitor is set slower than the plan allows, which happens because a plan upgrade does NOT re-cadence monitors that already exist -- the fix is to set `cadence_s` on the monitor, and a deliberately slower cadence is also a legitimate choice. `last_checked_s_ago`, `freshness_ratio` and `within_margin` describe the slowest feed feeding this monitor, named in `slowest_stream`. READ `freshness_reading` BEFORE QUOTING ANY OF THEM: it is ONE INSTANTANEOUS SAMPLE, not an average and not a sustained verdict, so a single reading past the margin is not by itself proof of under-service. Every one of these is TRI-STATE and null NEVER means fine: a null `within_margin` or `meets_entitlement` means the question could not be answered, and `unknown_reason` says why. Do not report a monitor as on-cadence on a null.",
    shape: { ...MONITOR_ID },
  },
  {
    name: "reddit_monitor_deliveries",
    path: "/api/reddit/monitor/deliveries",
    description:
      "Delivery history: the actual Reddit posts a monitor's webhook has received (or attempted), newest first, including the real post content (title, subreddit, permalink, author). Answers 'what did I actually get sent', not just 'how many' (see reddit_monitor_health for counts). Omit `id` to aggregate history across every monitor you own.",
    shape: {
      id: z.string().optional().describe("Narrow to one monitor's history. Omit to aggregate across every monitor you own."),
      status: z.enum(["pending", "delivered", "failed", "dead", "suppressed"]).optional().describe(
        "Filter to one delivery status. 'dead' = retries exhausted, gave up. 'suppressed' = matched but deliberately not sent, and `payload.suppressed.reason` says which of the two reasons applied: 'delivery_ceiling' (the monitor's daily cap) or 'stale_item' (the item was already older than the freshness window when we first saw it, so it was withheld rather than delivered as if it were new). A 'stale_item' row is NOT a fault and was NOT rejected by any plan limit, and retrying cannot recover it; `payload.suppressed` carries the age and the threshold. Omit for all statuses.",
      ),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows to return, 1 to 200. Default 50."),
      before: z.string().optional().describe("ISO 8601 timestamp cursor for pagination -- pass the `created_at` of the oldest row from the previous page to fetch older deliveries."),
    },
  },
  {
    name: "reddit_monitor_webhook_create",
    path: "/api/reddit/monitor/webhook/create",
    method: "POST",
    write: true,
    description:
      "Register a delivery target for monitors to send matches to. Requires an active monitoring plan (a webhook with no plan could never receive anything). Returns the webhook with its signing `secret` SHOWN ONCE -- store it immediately, it is never returned again by reddit_monitor_webhook_list. HTTPS only; the URL is re-validated (including a fresh DNS check) at every delivery, not just at creation.",
    shape: {
      url: z.string().url().describe("HTTPS URL to deliver matches to. Must be publicly reachable HTTPS, no embedded credentials, no loopback/private/link-local address."),
      kind: z.enum(["webhook", "slack", "discord", "email"]).optional().describe(
        "Payload shape to send. PREFER OMITTING THIS: for a hooks.slack.com or discord.com/api/webhooks URL the kind is inferred from the host, and the response reports what it inferred in `kind_inferred_from`. 'slack'/'discord' format as native incoming-webhook messages; 'webhook' sends redditapis' generic signed JSON envelope and is the fallback only for a host we do not recognise; 'email' is not yet a real delivery transport. Passing 'webhook' for a Slack or Discord URL does NOT force the generic envelope (that combination can never deliver -- Slack answers 400 invalid_payload); the host wins and `kind_corrected_from` says so. Passing one SPECIFIC kind for a different platform's host (e.g. 'discord' with a hooks.slack.com URL) is refused with `webhook_kind_mismatch` (400) rather than stored.",
      ),
    },
  },
  {
    name: "reddit_monitor_webhook_list",
    path: "/api/reddit/monitor/webhook/list",
    description: "List every webhook registered on the caller's account. Never returns the signing secret (shown once, at creation, by reddit_monitor_webhook_create).",
    shape: {},
  },
  {
    name: "reddit_monitor_webhook_test",
    path: "/api/reddit/monitor/webhook/test",
    method: "POST",
    write: true,
    description:
      "Send a one-off test delivery to a registered webhook (rate-limited to 10/min) so you can confirm it's wired up correctly before waiting for a real match. Uses the webhook's `kind` to format the test payload the same way a real delivery would. On failure the response carries `reason` and `status` plus TWO fields that say what to actually do: `hint`, our sentence naming the fix (most often that the target's `kind` does not match its host, which no test can succeed through), and `detail`, a bounded, sanitised copy of what the destination itself replied. Report `hint` to the user rather than the bare `reason` -- `http_error` with a 400 names no field, no value and no remedy. Returns 404 `webhook_not_found` if the id does not exist or is not yours, or `webhook_url_rejected` if the URL fails re-validation (e.g. now resolves to a private address).",
    shape: { ...WEBHOOK_ID },
  },
  {
    name: "reddit_monitor_webhook_delete",
    path: "/api/reddit/monitor/webhook/delete",
    method: "POST",
    write: true,
    destructive: true,
    description:
      "Permanently delete a webhook. Any monitor still pointing at it will fail to deliver until repointed at a different webhook -- this does NOT cascade-delete or pause the monitors using it. Cannot be undone. Returns 404 `webhook_not_found` if the id does not exist or is not yours.",
    shape: { ...WEBHOOK_ID },
  },
];

// Turn tool args into a URL query string. Skips undefined/null/empty values.
export function buildQuery(args) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && String(v).length > 0) qs.set(k, String(v));
  }
  return qs.toString();
}

// Interpolate {param} path placeholders from args; return the resolved path and
// the remaining args (which become the query string). A missing path param is
// left empty (the endpoint then 404s, surfaced to the caller) rather than
// throwing, so one bad call never crashes the server.
export function buildPath(template, args) {
  const used = new Set();
  const path = String(template).replace(/\{(\w+)\}/g, (_, k) => {
    used.add(k);
    const v = args?.[k];
    return encodeURIComponent(v == null ? "" : String(v));
  });
  const rest = {};
  for (const [k, v] of Object.entries(args || {})) if (!used.has(k)) rest[k] = v;
  return { path, rest };
}

// Turn a POST tool's args into the JSON body the REST endpoint expects. A field
// named in `tool.filterSpecFields` nests under `filter_spec`; everything else
// stays top-level (id, cadence_s, active, url, kind, ...). Skips undefined so
// an omitted optional arg is genuinely absent from the body, never sent as
// `null` -- monitor-handlers.js tells "field not provided" apart from "field
// explicitly cleared" (e.g. updateMonitor only replaces filter_spec when at
// least one filter field is present at all).
export function buildBody(tool, args) {
  const filterFields = new Set(tool.filterSpecFields || []);
  const body = {};
  let filterSpec = null;
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue;
    if (filterFields.has(k)) {
      filterSpec = filterSpec || {};
      filterSpec[k] = v;
    } else {
      body[k] = v;
    }
  }
  if (filterSpec) body.filter_spec = filterSpec;
  return body;
}
