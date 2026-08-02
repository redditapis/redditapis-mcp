# redditapis-mcp

[![npm version](https://img.shields.io/npm/v/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![npm downloads](https://img.shields.io/npm/dm/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![license](https://img.shields.io/npm/l/redditapis-mcp)](./LICENSE)

Official **Model Context Protocol** server for [redditapis.com](https://www.redditapis.com), the Reddit API as native tools for Claude, Cursor, Windsurf, and any MCP client. It turns Reddit reads (search, subreddit listings, comment trees, user profiles, community metadata) into typed tools your agent can call directly.

Ask your agent to search Reddit for a topic, read a community's top posts of the week, pull a user's comment history, surface the redditors talking about a product, or read a subreddit's rules before you engage, and it calls the API for you. Every tool maps to a REST endpoint at `https://api.redditapis.com`; the server holds no state and forwards your API key on each call.

## Quick start

No install needed. Run with `npx`. You need one thing: an API key from **[redditapis.com](https://www.redditapis.com)**. Reads work with just that key, so there is no account login or session step to set up.

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

22 tools, all reads. This server is **read-only** by design. Reddit writes (posting, commenting, voting, DMs) are a separate authenticated surface and are intentionally out of scope here, so every tool below works with just your API key, with no account login or session step.

A few conventions across the catalog:

- Subreddit names go in **without** the `r/` prefix, and usernames **without** the `u/` prefix. `reddit_subreddit_posts` takes its community as `subreddit`; the `/sub/{name}/...` tools take it as `name`.
- Listing and search tools return an `after` cursor. Pass it back as `after` to fetch the next page. `limit` accepts 1 to 100 (the API clamps out-of-range values).
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

## Reads only, no session needed

Because this server exposes reads and nothing that writes, there is no account linking, login, or cookie step: your API key alone authorizes every call. Reddit write actions (posting, commenting, voting, sending DMs) are handled by a separate authenticated surface outside this package and are deliberately not exposed here, so an agent using this server cannot take an action on any account.

## Troubleshooting

**`HTTP 401 (invalid or missing API key)`** Check that `REDDITAPIS_KEY` is set correctly in your MCP client config and matches the key from [redditapis.com](https://www.redditapis.com).

**`HTTP 402 (insufficient credits)`** Top up your account at [redditapis.com](https://www.redditapis.com).

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

**Can it post, comment, or vote?** No. This server is read-only. All 22 tools read Reddit; writes are a separate authenticated surface and are not exposed here.

**Which clients are supported?** Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code (Copilot agent mode), or any Model Context Protocol client.

**Does it store my key or data?** No. The server holds no state and forwards your API key on each call.

## License

MIT
