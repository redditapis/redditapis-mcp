# redditapis-mcp

[![npm version](https://img.shields.io/npm/v/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![npm downloads](https://img.shields.io/npm/dm/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![license](https://img.shields.io/npm/l/redditapis-mcp)](./LICENSE)

Official **Model Context Protocol** server for [redditapis.com](https://www.redditapis.com), the Reddit API as native tools for Claude, Cursor, Windsurf, and any MCP client. It turns Reddit reads (search, subreddit listings, comment trees, user profiles, community metadata) into typed tools your agent can call directly, plus (since 0.2.0) managing your own redditapis.com monitors and webhooks.

Ask your agent to search Reddit for a topic, read a community's top posts of the week, pull a user's comment history, surface the redditors talking about a product, or read a subreddit's rules before you engage, and it calls the API for you. It can also set up a monitor that watches a subreddit for new posts matching a filter and delivers them to a webhook, then check what it's actually delivered. Every tool maps to a REST endpoint at `https://api.redditapis.com`; the server holds no state and forwards your API key on each call.

## Quick start

No install needed. Run with `npx`. You need one thing: an API key from **[redditapis.com](https://www.redditapis.com)**. Reads work with just that key, so there is no account login or session step to set up. Monitor/webhook management additionally requires an active monitoring plan (monitoring has no free tier).

## Setup

### Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Restart Claude Desktop. The `reddit_*` tools appear in the tool picker.

### Claude Code

```bash
claude mcp add reddit --env REDDITAPIS_KEY=YOUR_API_KEY -- npx -y redditapis-mcp@latest
```

### Cursor

`~/.cursor/mcp.json` (or Settings > MCP > Add New Server):

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### VS Code (Copilot / agent mode)

`.vscode/mcp.json` in your workspace, or the user-level MCP settings:

```json
{
  "servers": {
    "reddit": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `REDDITAPIS_KEY` | Yes | (none) | API key from [redditapis.com](https://www.redditapis.com). `REDDIT_APIS_KEY` is accepted as an alias. |
| `REDDITAPIS_BASE_URL` | No | `https://api.redditapis.com` | Override the API host. |
| `REDDITAPIS_TIMEOUT_MS` | No | `30000` | Per-request timeout in milliseconds. |

Authentication is a Bearer token: the server sends `Authorization: Bearer <REDDITAPIS_KEY>` on every request.

## Tools

32 tools: 22 reads plus 10 monitor/webhook management tools. Reddit writes (posting, commenting, voting, DMs) remain a separate authenticated surface and are intentionally out of scope here -- monitor/webhook tools configure your OWN redditapis.com account (an alerting subscription), never Reddit itself. Every read works with just your API key; the 6 monitor/webhook writes additionally need an active monitoring plan (see Monitoring below).

A few conventions across the catalog:

- Subreddit names go in **without** the `r/` prefix, and usernames **without** the `u/` prefix. `reddit_subreddit_posts` takes its community as `subreddit`; the `/sub/{name}/...` tools take it as `name`.
- Listing and search tools return an `after` cursor. Pass it back as `after` to fetch the next page, exactly as it was returned. `limit` accepts 1 to 100 (the API clamps out-of-range values).
- When `after` comes back `null` there is no next page to ask for. That does not always mean you have every item: Reddit often stops serving a busy listing long before it runs out. The final response also carries `listing_status`, which reads `complete`, `truncated` or `unknown`. Only `complete` means nothing is missing. Treat the other two as a partial answer and widen across sorts, timeframes or search terms rather than paging deeper.
- `t` (`hour`, `day`, `week`, `month`, `year`, `all`) sets the time window; on subreddit listings it applies to the `top` and `controversial` sorts, and on search it bounds the whole result set.

### Search and discovery

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_search` | `GET /api/reddit/search` | Search posts across all of Reddit or within one subreddit (`subreddit`). |
| `reddit_search_comments` | `GET /api/reddit/search/comments` | Search by comment text; returns the parent posts, since Reddit's comment search does not hand back the matching comment itself. |
| `reddit_deep_comment_search` | `GET /api/reddit/search/comments/deep` | Genuine comment search: returns the actual matching comment bodies (score, author, comment-deep permalink, parent post). `limit` sets how many parent posts to expand; `group_by="author"` switches to research mode (the distinct people talking about your query). Premium call. |
| `reddit_search_media` | `GET /api/reddit/search/media` | Search posts filtered to media, narrowed by `kind` (`image`, `video`, `gif`, `all`). |
| `reddit_search_communities` | `GET /api/reddit/search/communities` | Find subreddits by name or topic (title, subscribers, description, NSFW flag). |
| `reddit_search_users` | `GET /api/reddit/search/users` | Find redditors by name or keyword (username, karma, account age). |

### Subreddits

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_subreddit_posts` | `GET /api/reddit/posts` | List a subreddit's posts by `sort` (`new`, `hot`, `top`, `rising`, `controversial`, `best`). |
| `reddit_subreddit_top` | `GET /api/reddit/sub/{name}/top` | Top posts of a subreddit for a time window (`t`). |
| `reddit_subreddit_comments` | `GET /api/reddit/sub/{name}/comments` | Stream the newest comments across an entire subreddit (not one post's thread). |
| `reddit_subreddit_about` | `GET /api/reddit/sub/{name}/about` | A subreddit's public metadata: title, description, subscriber and active-user counts, type, NSFW flag. |
| `reddit_subreddit_rules` | `GET /api/reddit/sub/{name}/rules` | A subreddit's posting rules plus Reddit's site-wide rules. |
| `reddit_subreddit_moderators` | `GET /api/reddit/sub/{name}/moderators` | A subreddit's moderator team, each with permissions, flair, and when they joined. |
| `reddit_subreddit_wiki` | `GET /api/reddit/sub/{name}/wiki/{page}` | A subreddit's wiki page by name and `page` (markdown + HTML, revision metadata). |

### Posts and comments

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_post` | `GET /api/reddit/post/{id}` | A single post by its base-36 `id` (no `t3_` prefix): title, author, score, text, permalink, subreddit, url. |
| `reddit_post_comments` | `GET /api/reddit/comments` | A post plus its full threaded comment tree, fetched by `permalink`. |
| `reddit_by_id` | `GET /api/reddit/by_id/{fullnames}` | Bulk-hydrate up to 100 posts in one call from a comma-separated list of `t3_` fullnames. |

### Users

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_user_profile` | `GET /api/reddit/user/{name}` | A user's public profile: karma, account age, verified/employee flags, avatar. |
| `reddit_user_comments` | `GET /api/reddit/user/{name}/comments` | A user's recent comments (body, score, subreddit, parent link, timestamp). |
| `reddit_user_submitted` | `GET /api/reddit/user/{name}/submitted` | A user's submitted posts (the sibling of `reddit_user_comments`). |

### Community browse (no keyword)

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_subreddits_popular` | `GET /api/reddit/subreddits/popular` | Browse the most-subscribed, trending subreddits right now. |
| `reddit_subreddits_new` | `GET /api/reddit/subreddits/new` | Browse the newest subreddits, most recently created first. |
| `reddit_subreddits_default` | `GET /api/reddit/subreddits/default` | Browse Reddit's default front-page set of subreddits. |

### Monitoring: manage your own monitors and webhooks

v1 monitors are **subreddit-scoped, posts-only** (no all-of-Reddit keyword watch, no comment monitoring yet). Creating or updating a monitor or webhook needs an active plan; reading your own list/health/deliveries never does.

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_monitor_add` | `POST /api/reddit/monitor/add` | Create a monitor: subreddits to watch plus an optional filter (keyword, author, domain, include/exclude terms, min score, NSFW). Forward-looking only from creation (or from `baseline_item_id`). |
| `reddit_monitor_list` | `GET /api/reddit/monitor/list` | List every monitor on your account, plus `slots` ({used, total, tier}). |
| `reddit_monitor_update` | `POST /api/reddit/monitor/update` | Pause/resume (`active`), re-cadence, or replace a monitor's filter. Passing any filter field REPLACES the whole filter -- resupply everything you want kept. |
| `reddit_monitor_remove` | `POST /api/reddit/monitor/remove` | Permanently delete a monitor. Cannot be undone. |
| `reddit_monitor_health` | `GET /api/reddit/monitor/health` | Per-monitor delivered/failed/suppressed counts (last 24h), `suppressed_breakdown` splitting those suppressions into `ceiling` and `stale` reasons, and whether the delivery ceiling specifically has been hit. |
| `reddit_monitor_deliveries` | `GET /api/reddit/monitor/deliveries` | The actual posts delivered (or attempted), newest first, with real content -- not just counts. Omit `id` to aggregate across every monitor you own. |
| `reddit_monitor_webhook_create` | `POST /api/reddit/monitor/webhook/create` | Register a delivery target (`webhook`/`slack`/`discord`). Returns a signing secret shown ONCE. |
| `reddit_monitor_webhook_list` | `GET /api/reddit/monitor/webhook/list` | List your webhooks. Never returns the secret. |
| `reddit_monitor_webhook_test` | `POST /api/reddit/monitor/webhook/test` | Send a one-off test delivery to confirm a webhook is wired up correctly. |
| `reddit_monitor_webhook_delete` | `POST /api/reddit/monitor/webhook/delete` | Permanently delete a webhook. Does not cascade-pause monitors still pointing at it. |

## Usage examples

### Research a topic across Reddit

> "What are people saying about the Rust borrow checker this month?"

The agent calls `reddit_search` with:

```
q: "borrow checker"
sort: "top"
t: "month"
```

### Read a community's top posts of the week

> "Show me the top posts in r/programming this week."

The agent calls `reddit_subreddit_top` with:

```
name: "programming"
t: "week"
```

To page further, pass the `after` cursor from the response back on the next call: `{ name: "programming", t: "week", after: "<after from response>" }`.

### Find who is talking about a product

> "Which redditors are recommending mechanical keyboards, and what do they say?"

The agent calls `reddit_deep_comment_search` with:

```
q: "mechanical keyboard"
group_by: "author"
sort: "top"
```

Research mode returns the distinct people who mentioned the query, ranked by how many of their comments matched, each with their top comment and the subreddits they matched in.

### Vet a subreddit, then read a thread

> "Find a discussion about API rate limiting in r/webdev, check the sub's rules, and read the full thread."

The agent calls `reddit_search` scoped to the community:

```
q: "rate limiting"
subreddit: "webdev"
sort: "relevance"
t: "year"
```

Then `reddit_subreddit_rules` with `{ name: "webdev" }`, and finally `reddit_post_comments` with the `permalink` from a search result, for example `{ permalink: "/r/webdev/comments/abc123/some_title/" }`, to pull the post and its comment tree.

### Set up brand monitoring and check what came in

> "Watch r/SaaS and r/startups for mentions of my product, send matches to my Slack, and show me what's come in so far."

The agent calls `reddit_monitor_webhook_create` with:

```
url: "https://hooks.slack.com/services/..."
kind: "slack"
```

Then `reddit_monitor_add` with:

```
subreddit: ["SaaS", "startups"]
q: "my product name"
```

Later, `reddit_monitor_deliveries` with `{ id: "<monitor id from the add response>" }` returns the actual matching posts sent so far, or `reddit_monitor_health` for just the counts.

## No session needed for reads; monitor/webhook writes need an active plan

Reads need nothing but your API key -- no account linking, login, or cookie step. Reddit write actions (posting, commenting, voting, sending DMs) are handled by a separate authenticated surface outside this package and remain deliberately not exposed here, so an agent using this server can never post, vote, or DM as you on Reddit. Monitor/webhook management tools are a different kind of write: they configure your OWN redditapis.com account (an alerting subscription) and require an active monitoring plan for anything that creates or changes state (`reddit_monitor_add`/`update`/`remove`, `reddit_monitor_webhook_create`/`test`/`delete`); reading your own list, health, or delivery history never does.

## Troubleshooting

**`HTTP 401 (invalid or missing API key)`** Check that `REDDITAPIS_KEY` is set correctly in your MCP client config and matches the key from [redditapis.com](https://www.redditapis.com).

**`HTTP 402 (insufficient credits)`** Top up your account at [redditapis.com](https://www.redditapis.com). For a monitor/webhook write specifically, a 402 body of `subscription_required` means there is no active monitoring plan (monitoring has no free tier); `monitor_slots_exhausted` means the plan's monitor slot limit is already in use -- `reddit_monitor_list`'s `slots` field shows used vs total.

**`HTTP 403 (access forbidden)`** The subreddit or user may be private, banned, or quarantined, or your plan may not include this endpoint.

**`HTTP 404 (not found)`** The subreddit, post id, user, or permalink may be wrong or the content may have been deleted or removed.

**`HTTP 429 (rate limited)`** Wait a few seconds and retry, or reduce request frequency. For bulk work, space out calls and raise `REDDITAPIS_TIMEOUT_MS`.

**`Request failed: timed out after 30000ms`** The default timeout is 30 seconds. For large `reddit_deep_comment_search` or paginated fetches, set `REDDITAPIS_TIMEOUT_MS` higher (for example `60000`).

**Tools do not appear in Claude / Cursor** Ensure `npx` is on your PATH and Node.js 18+ is installed (`node --version`). Check your MCP client logs for startup errors.

## Development

```bash
npm install
npm run check   # syntax-check both source files
npm test        # unit-test the tool catalog + query/path builders (no network)
npm start       # run the stdio server (needs REDDITAPIS_KEY)
```

## Links

- Site and API keys: [redditapis.com](https://www.redditapis.com)
- REST API base URL (call it directly, without MCP): `https://api.redditapis.com`

## FAQ

**Do I need a Reddit developer account?** No. Get an API key at [redditapis.com](https://www.redditapis.com); there is no application or approval step.

**Can it post, comment, or vote?** No. All 22 Reddit-facing tools read Reddit; posting, commenting, voting, and DMs are a separate authenticated surface and are not exposed here. The other 10 tools manage your OWN redditapis.com monitors/webhooks, which is a write, but never a write to Reddit itself.

**Which clients are supported?** Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code (Copilot agent mode), or any Model Context Protocol client.

**Does it store my key or data?** No. The server holds no state and forwards your API key on each call.

## License

MIT
