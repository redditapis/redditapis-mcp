# redditapis-mcp

Official [Model Context Protocol](https://modelcontextprotocol.io) server for
**[redditapis.com](https://www.redditapis.com)** — the Reddit API as native tools
for Claude, Cursor, and any MCP client.

It exposes Reddit reads as typed tools: subreddit listings, post / comment /
community / user / media search, a post's full comment tree, subreddit top posts,
and user profile + comments. Each tool is a thin, stateless wrapper over a REST
endpoint at `https://api.redditapis.com`; your API key is forwarded on every call.

## Setup

Get an API key at [redditapis.com](https://www.redditapis.com), then add the
server to your MCP client. It runs over stdio via `npx` (no install needed):

### Claude Desktop / Claude Code / Cursor (`mcp.json`)

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "your_api_key_here" }
    }
  }
}
```

## Configuration (env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REDDITAPIS_KEY` | yes | — | Your key. `REDDIT_APIS_KEY` is accepted as an alias. |
| `REDDITAPIS_BASE_URL` | no | `https://api.redditapis.com` | Override the API base. |
| `REDDITAPIS_TIMEOUT_MS` | no | `30000` | Per-request timeout in ms. |

## Tools

All tools are **read-only**. Reddit writes (comment / vote / DM) are a separate
authenticated surface and are intentionally not exposed here.

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_subreddit_posts` | `GET /api/reddit/posts` | List a subreddit's posts by sort (hot/new/top/rising/…) |
| `reddit_search` | `GET /api/reddit/search` | Search posts across Reddit or one subreddit |
| `reddit_post_comments` | `GET /api/reddit/comments` | A post + its comment tree, by permalink |
| `reddit_search_communities` | `GET /api/reddit/search/communities` | Find subreddits by name/topic |
| `reddit_search_comments` | `GET /api/reddit/search/comments` | Search comments (not posts) |
| `reddit_search_media` | `GET /api/reddit/search/media` | Search image/video/gif posts |
| `reddit_search_users` | `GET /api/reddit/search/users` | Find redditors by name |
| `reddit_subreddit_top` | `GET /api/reddit/sub/{name}/top` | Top posts of a subreddit for a time window |
| `reddit_post` | `GET /api/reddit/post/{id}` | A single post by id |
| `reddit_user_profile` | `GET /api/reddit/user/{name}` | A user's public profile |
| `reddit_user_comments` | `GET /api/reddit/user/{name}/comments` | A user's recent comments |

## Development

```bash
npm install
npm run check   # syntax check both source files
npm test        # unit-test the tool catalog + query/path builders (no network)
npm start       # run the stdio server (needs REDDITAPIS_KEY)
```

## License

MIT
