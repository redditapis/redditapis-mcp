// Tool catalog + pure query/path builders for redditapis-mcp.
// Kept separate from the server wiring (index.js) so it can be unit-tested
// without spawning the stdio transport.
//
// Each tool maps 1:1 to a REST endpoint at https://api.redditapis.com/api/reddit.
// Tool arg names map 1:1 to endpoint query params, EXCEPT path params written as
// {name}/{id} in a tool's `path` (e.g. /api/reddit/sub/{name}/top), which are
// interpolated into the URL and removed from the query string. Every tool here
// is a READ (GET); reddit writes (comment/vote/DM) are a separate authenticated
// surface and are intentionally out of scope for this reads MCP.
import { z } from "zod";

// Shared Zod input-schema fragments.
const LIMIT = {
  limit: z.number().int().min(1).max(100).optional().describe(
    "Max items to return (1 to 100). The API clamps out-of-range values; endpoint default applies if omitted.",
  ),
};
const AFTER = {
  after: z.string().optional().describe(
    "Opaque Reddit pagination cursor from the previous response's `after` field (a fullname like `t3_abc123`). Omit on the first call; pass it to fetch the next page.",
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

// The tool catalog. All reads (GET). Path params are {name}/{id} placeholders.
export const TOOLS = [
  {
    name: "reddit_subreddit_posts",
    path: "/api/reddit/posts",
    description:
      "List posts from a subreddit by sort order. Use this to read a community's feed: newest, hot/trending, top-of-week, rising, etc. Returns post title, author, score, comment count, permalink, flair, and media, plus an `after` cursor for paging. Example: subreddit='programming' sort='top' t='week'.",
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
      "Search Reddit posts across all of Reddit or within one subreddit. Returns matching posts with author, score, comments, permalink, and an `after` cursor. Use for topic/keyword research, brand monitoring, or finding discussions. Scope to a community with `subreddit`. Example: q='rust vs go' sort='top' t='year'.",
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
      "Search Reddit COMMENTS (not posts) by keyword across Reddit. Returns matching comments with author, body, score, subreddit, and the parent post link. Use to find first-hand opinions/answers buried in threads. Example: q='best mechanical keyboard' sort='top'.",
    shape: { ...QUERY, ...SORT_SEARCH, ...TIME_SEARCH, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_search_media",
    path: "/api/reddit/search/media",
    description:
      "Search Reddit posts filtered to media (images, video, gifs). Returns media posts with the media URL/type, author, score, and permalink. Use `kind` to narrow to a media type. Example: q='aurora borealis' kind='image'.",
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
      "Fetch a single Reddit post by its id. Returns the full post object (title, author, score, body/selftext, media, permalink, subreddit). Use when you already have a post id and want its details. Example: id='abc123' (the base-36 id, no t3_ prefix).",
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
