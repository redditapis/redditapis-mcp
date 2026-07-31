# Changelog

## 0.1.7
- Three new read tools (all $0.002, one upstream read each):
  - **`reddit_user_submitted`** (`GET /api/reddit/user/{name}/submitted`) — a
    user's submitted POSTS, the sibling of `reddit_user_comments`. Same post
    shape as the subreddit listings.
  - **`reddit_subreddit_comments`** (`GET /api/reddit/sub/{name}/comments`) — the
    subreddit NEW-COMMENT stream (every new comment across a community, not one
    post's thread). Same comment shape as `reddit_user_comments`.
  - **`reddit_subreddit_about`** (`GET /api/reddit/sub/{name}/about`) — a
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
