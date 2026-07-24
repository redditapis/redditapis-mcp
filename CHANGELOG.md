# Changelog

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
