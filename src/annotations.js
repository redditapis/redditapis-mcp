// Human-readable titles and MCP tool annotations (spec 2025-06-18,
// ToolAnnotations) for every tool in src/tools.js.
//
// A host uses these before it calls anything: `title` is the name it shows a
// person, and the four hints tell it which calls only read, which change
// state, which cannot be undone and which reach past this service. They are
// hints, never a security boundary; the API enforces what a key may do.
//
// The rules the table follows:
//   - A read of Reddit data: readOnlyHint true, openWorldHint true (it reaches
//     Reddit), idempotentHint true, destructiveHint false.
//   - A read of this account's own state (balance, payments, monitors,
//     webhooks, delivery history, feedback status, the local provenance
//     ledger): readOnlyHint true, openWorldHint false.
//   - A write: readOnlyHint false. destructiveHint true when it deletes,
//     discards or overwrites (a monitor update REPLACES the whole filter;
//     feedback_send's "discard" action drops drafts), false for an additive
//     write. idempotentHint true only when repeating the same call has no
//     further effect (an update to fixed values, a delete of one id).
//     openWorldHint true when the call itself reaches an endpoint outside this
//     service (a webhook test delivery, a watch that test-fires its target).
//
// readOnlyHint is not a second source of truth: it is derived from the
// catalog's own `write` flag, and test/annotations.test.mjs fails if the table
// and the catalog disagree in either direction (a tool with no row, or a row
// with no tool).

const READ_REDDIT = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
const READ_OWN = { readOnly: true, destructive: false, idempotent: true, openWorld: false };

export const TOOL_ANNOTATIONS = {
  // Reads of Reddit data.
  reddit_subreddit_posts: { title: "List Subreddit Posts", ...READ_REDDIT },
  reddit_verify_comments: { title: "Verify Comments Still Exist", ...READ_REDDIT },
  reddit_home_feed: { title: "Home Feed", ...READ_REDDIT },
  reddit_search: { title: "Search Posts", ...READ_REDDIT },
  reddit_post_visibility: { title: "Post Visibility", ...READ_REDDIT },
  reddit_post_comments: { title: "Get Post Comments", ...READ_REDDIT },
  reddit_search_communities: { title: "Search Communities", ...READ_REDDIT },
  reddit_search_comments: { title: "Search Posts by Comment", ...READ_REDDIT },
  reddit_deep_comment_search: { title: "Deep Comment Search", ...READ_REDDIT },
  reddit_search_media: { title: "Search Media Posts", ...READ_REDDIT },
  reddit_search_users: { title: "Search Users", ...READ_REDDIT },
  reddit_subreddit_top: { title: "Top Subreddit Posts", ...READ_REDDIT },
  reddit_post: { title: "Get Post", ...READ_REDDIT },
  reddit_user_profile: { title: "Get User Profile", ...READ_REDDIT },
  reddit_user_achievements: { title: "Get User Achievements", ...READ_REDDIT },
  reddit_user_comments: { title: "List User Comments", ...READ_REDDIT },
  reddit_user_submitted: { title: "List User Posts", ...READ_REDDIT },
  reddit_user_upvoted: { title: "List Upvoted Posts", ...READ_REDDIT },
  reddit_user_saved: { title: "List Saved Items", ...READ_REDDIT },
  reddit_user_hidden: { title: "List Hidden Posts", ...READ_REDDIT },
  reddit_user_gilded: { title: "List Gilded Items", ...READ_REDDIT },
  reddit_subreddit_comments: { title: "List Subreddit Comments", ...READ_REDDIT },
  reddit_subreddit_about: { title: "Get Subreddit Info", ...READ_REDDIT },
  reddit_subreddit_rules: { title: "Get Subreddit Rules", ...READ_REDDIT },
  reddit_subreddit_moderators: { title: "List Subreddit Moderators", ...READ_REDDIT },
  reddit_subreddit_wiki: { title: "Subreddit Wiki Page", ...READ_REDDIT },
  reddit_by_id: { title: "Get Posts by ID", ...READ_REDDIT },
  reddit_subreddits_popular: { title: "List Popular Subreddits", ...READ_REDDIT },
  reddit_subreddits_new: { title: "List New Subreddits", ...READ_REDDIT },
  reddit_subreddits_default: { title: "List Default Subreddits", ...READ_REDDIT },

  // Reads of this account's own state.
  reddit_monitor_list: { title: "List Monitors", ...READ_OWN },
  reddit_monitor_health: { title: "Monitor Health", ...READ_OWN },
  reddit_monitor_deliveries: { title: "List Monitor Deliveries", ...READ_OWN },
  reddit_monitor_webhook_list: { title: "List Webhooks", ...READ_OWN },
  reddit_feedback_list: { title: "List Feedback Reports", ...READ_OWN },
  reddit_feedback_get: { title: "Get Feedback Report", ...READ_OWN },
  reddit_account_me: { title: "Get Account Balance", ...READ_OWN },
  reddit_account_payments: { title: "List Account Payments", ...READ_OWN },
  reddit_explain: { title: "Explain Fetched Rows", ...READ_OWN },

  // Writes.
  reddit_monitor_add: { title: "Create Monitor", readOnly: false, destructive: false, idempotent: false, openWorld: false },
  reddit_monitor_update: { title: "Update Monitor", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  reddit_monitor_remove: { title: "Delete Monitor", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  reddit_monitor_webhook_create: { title: "Create Webhook", readOnly: false, destructive: false, idempotent: false, openWorld: false },
  reddit_monitor_webhook_test: { title: "Send Webhook Test", readOnly: false, destructive: false, idempotent: false, openWorld: true },
  reddit_monitor_webhook_delete: { title: "Delete Webhook", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  reddit_feedback_send: { title: "Send Feedback Report", readOnly: false, destructive: true, idempotent: false, openWorld: false },
  reddit_set_watch: { title: "Create Watch", readOnly: false, destructive: false, idempotent: false, openWorld: true },

  // Writes AS the customer's own Reddit account through the stored session (#16). openWorld:
  // each reaches Reddit itself. comment, submit and dm add content and are not idempotent;
  // vote sets a state (idempotent); connect overwrites and disconnect deletes the stored
  // credential, so both are destructive.
  reddit_connect: { title: "Connect Reddit Account", readOnly: false, destructive: true, idempotent: true, openWorld: true },
  reddit_session_status: { title: "Reddit Connection Status", ...READ_OWN },
  reddit_disconnect: { title: "Disconnect Reddit Account", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  reddit_comment: { title: "Post Comment", readOnly: false, destructive: false, idempotent: false, openWorld: true },
  reddit_submit: { title: "Submit Post", readOnly: false, destructive: false, idempotent: false, openWorld: true },
  reddit_vote: { title: "Vote", readOnly: false, destructive: false, idempotent: true, openWorld: true },
  reddit_dm: { title: "Send Direct Message", readOnly: false, destructive: false, idempotent: false, openWorld: true },
};

/**
 * The title and MCP annotations for one catalog tool. Throws for a tool with
 * no row, so a new tool cannot register without its title and hints.
 */
export function toolAnnotations(tool) {
  const row = TOOL_ANNOTATIONS[tool.name];
  if (!row) throw new Error(`[reddit-mcp] tool ${tool.name} has no row in src/annotations.js`);
  return {
    title: row.title,
    annotations: {
      title: row.title,
      readOnlyHint: !tool.write,
      destructiveHint: row.destructive,
      idempotentHint: row.idempotent,
      openWorldHint: row.openWorld,
    },
  };
}
