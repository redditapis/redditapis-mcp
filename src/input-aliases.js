// Input-name aliases (feedback 85f3f21b, 2026-11-19).
//
// The tools take one canonical name per input: `name` for a user (and a
// subreddit), `q` for a search query, `id` for a post. Callers reasonably send
// `username`, `query` or `post_id` instead, and a strict schema refused those
// calls with a validation error naming a field the caller never used. Each
// alias below is accepted on exactly the tools where it means the canonical
// input, is moved onto the canonical name before the request is built, and is
// never sent to the API. The canonical name stays the documented one.
//
// Sending both with different values is refused (it is ambiguous); sending
// neither for a required input is refused with both names in the message,
// because the canonical input becomes optional in the published schema so the
// alias alone can satisfy it.

// alias -> canonical, and where the alias applies. 0.22.0 widened the set to the rest of the catalog: a subreddit
// is `name` on the /sub/{name} tools and `subreddit` elsewhere, so each accepts the other; a comment id, a post id on
// the comment-tree tool, a DM recipient and the typeahead's subreddit take the name callers send for them.
const pathHas = (tool, part) => typeof tool.path === "string" && tool.path.includes(part);
const shapeHas = (tool, key) => Boolean(tool.shape && tool.shape[key]);
export const INPUT_ALIASES = [
  { alias: "username", canonical: "name", applies: (tool) => pathHas(tool, "/user/{name}") },
  { alias: "query", canonical: "q", applies: (tool) => shapeHas(tool, "q") },
  { alias: "post_id", canonical: "id", applies: (tool) => pathHas(tool, "/post/{id}") },
  { alias: "subreddit", canonical: "name", applies: (tool) => pathHas(tool, "/sub/{name}") },
  // Only where `subreddit` is the one required subreddit (a listing or a submit), never an optional search filter.
  { alias: "name", canonical: "subreddit", applies: (tool) => shapeHas(tool, "subreddit") && !tool.shape.subreddit.isOptional() && tool.shape.subreddit._def?.typeName !== "ZodArray" },
  { alias: "comment_id", canonical: "id", applies: (tool) => pathHas(tool, "/comment/{id}") },
  { alias: "id", canonical: "post_id", applies: (tool) => shapeHas(tool, "post_id") },
  { alias: "username", canonical: "to_username", applies: (tool) => shapeHas(tool, "to_username") },
  { alias: "subreddit", canonical: "sub", applies: (tool) => shapeHas(tool, "sub") },
];

/** The aliases one tool accepts: [{ alias, canonical, required }]. */
export function aliasesFor(tool) {
  const shape = (tool && tool.shape) || {};
  return INPUT_ALIASES.filter((a) => shape[a.canonical] && !shape[a.alias] && a.applies(tool)).map((a) => ({
    alias: a.alias,
    canonical: a.canonical,
    required: !shape[a.canonical].isOptional(),
  }));
}

/** The schema to publish: the tool's own, plus each alias (same type), with an aliased canonical input made optional. */
export function aliasedShape(tool) {
  const list = aliasesFor(tool);
  if (!list.length) return tool.shape;
  const shape = { ...tool.shape };
  for (const { alias, canonical, required } of list) {
    const base = tool.shape[canonical];
    if (required) shape[canonical] = base.optional().describe(`${base.description || ""} Required: send \`${canonical}\` or its alias \`${alias}\`.`.trim());
    shape[alias] = base.optional().describe(`Alias of \`${canonical}\`; send one of them. \`${canonical}\` is the canonical name.`);
  }
  return shape;
}

/**
 * Move each alias onto its canonical name. Returns { args } or { error } (a message for the caller).
 * A tool with no aliases gets its args back untouched.
 */
export function normalizeArgs(tool, args) {
  const list = aliasesFor(tool);
  if (!list.length || !args || typeof args !== "object") return { args };
  const out = { ...args };
  for (const { alias, canonical, required } of list) {
    const has = (k) => out[k] !== undefined && out[k] !== null && out[k] !== "";
    if (has(alias)) {
      if (has(canonical) && out[canonical] !== out[alias]) {
        return { error: `${tool.name}: \`${canonical}\` and its alias \`${alias}\` were both sent with different values; send only \`${canonical}\`.` };
      }
      out[canonical] = out[alias];
    }
    delete out[alias];
    if (required && !has(canonical)) return { error: `${tool.name}: \`${canonical}\` is required (or its alias \`${alias}\`).` };
  }
  return { args: out };
}
