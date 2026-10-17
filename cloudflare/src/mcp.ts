import * as privacy from "./privacy";
/**
 * The assistant's tools (SPEC §4). Every tool goes through content.ts and
 * approvals.ts; none of them can publish (S1).
 */
import { EMBED_ADVICE, EMBED_SYNTAX } from "./embed-url";
import { embedNotes } from "./embeds";
import { McpServer } from "@modelcontextprotocol/server";
import { toolProps } from "./tool-context";
import { env } from "cloudflare:workers";
import { z } from "zod";
import * as analytics from "./analytics";
import { PHOTO_ADVICE } from "./photo-advice";
import { imageAdd } from "./image-add";
import { checkSite, checkSiteDeep } from "./check";
import * as approvals from "./approvals";
import * as alerts from "./alerts";
import * as content from "./content";
import type { Env } from "./env";
import { HOME, RELEASE } from "./home";
import * as media from "./media";
import * as requests from "./requests";
import { proposedView } from "./site";
import * as themes from "./themes";
import * as update from "./update";
import * as uploads from "./uploads";
import { ApiError } from "./errors";
import { fieldGuide, KIND_GUIDE, KINDS } from "./models";

export const INSTRUCTIONS = `You keep this person's website up to date. The site is theirs:
nothing you write is public until they approve it, and the site enforces that.
Workflow: site_state (see what exists, each item's version and field guide) ->
item_create / item_update / item_remove (images: an https link, or
photo_upload_link for a photo your person sent you) -> approval_request (only the ids you
changed for this request; site_check first) -> give the owner the review_url -> approval_status.
Finish the whole job first and send it as one request, then tell your person at once:
your drafts are invisible to them until you do.
On a new site, if site_state lists no site item, call item_create with kind: "site" and the site fields (including theme); use item_update only after that item exists.
Never put passwords, keys, tokens or private addresses in content; the site refuses them.
The look: theme_list (built-in looks are ready to use; the catalog has previews) ->
set the site item's theme -> theme_needs (the art and words that theme wants, and which
are missing) -> fill them -> one approval_request. Use theme_install only for a
catalog look missing from installed, or to update one.
Cards have a visibility: a private card is never shown and its name may not appear in
anything public (the site refuses it); a mention card shows its name and description only,
and an entry names it at most once in its summary and once in its body.
site_stats: who reads the site.`;

const NEW_SITE_ADVICE = 'A brand-new site has no site item: create it with item_create kind "site", then use item_update for later changes.';

function actor(): string {
  const props = toolProps() as { client?: string };
  return `assistant:${props?.client ?? "unknown"}`;
}

const ok = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v) }],
  structuredContent: v as Record<string, unknown>,
});

async function run(fn: () => Promise<unknown>) {
  try {
    const v = await fn();
    return ok(Array.isArray(v) ? { items: v } : v);
  } catch (e) {
    if (e instanceof ApiError) {
      return { content: [{ type: "text" as const, text: JSON.stringify(e.toJSON()) }], isError: true };
    }
    throw e;
  }
}

/** One item shape for every tool: data plus where it stands. */
async function describe(db: D1Database, items: content.Item[]) {
  const live = new Map(
    (await db.prepare("SELECT item_id, version FROM live").all<{ item_id: string; version: number }>()).results.map((r) => [r.item_id, r.version]),
  );
  const waiting = new Map<string, string>();
  const lastSeen = new Map<string, { id: string; status: string; note: string }>();
  // Newest first, so the first time an item appears is its latest request.
  for (const a of await approvals.list(db)) {
    for (const i of a.items) {
      if (i.status === "pending" && !waiting.has(i.id)) waiting.set(i.id, a.id);
      if (!lastSeen.has(i.id)) lastSeen.set(i.id, { id: a.id, status: i.status, note: i.note });
    }
  }
  return items.map((i) => {
    const lv = live.get(i.id) ?? null;
    const state = i.deleted ? (lv !== null ? "removal staged" : "removed") : lv === null ? "new" : lv === i.version ? "live" : "changed";
    return {
      ...i,
      state,
      live_version: lv,
      pending_approval: waiting.get(i.id) ?? null,
      last_approval: lastSeen.get(i.id) ?? null,
    };
  });
}

/** Keep full item metadata available while making the default read small. */
async function stateItems(db: D1Database, full?: boolean, ids?: string[]) {
  let items = await content.allItems(db);
  if (ids !== undefined) {
    const selected = new Set(ids);
    const known = new Set(items.map((i) => i.id));
    for (const id of selected) if (!known.has(id)) throw new ApiError(404, "no_such_item", `No item ${id}.`);
    items = items.filter((i) => selected.has(i.id));
  }
  const described = await describe(db, items);
  if (full || ids !== undefined) return described;
  return described.map((i) => ({ id: i.id, kind: i.kind, title: String(i.data.title ?? i.data.name ?? i.data.text ?? ""), state: i.state, version: i.version }));
}

const NEXT = "When your changes are ready, call site_check, then approval_request with the ids you changed.";
const IMAGE_ADD_DESCRIPTION = "For picture files you hold: give exactly one of data (one base64 picture, existing image/width/height response) or images (1 to 8 base64 pictures, response images:[{image,width,height},...] in input order). JPEG, PNG or WebP, at most 8 MB each and 8 MB decoded total. Every file is sniffed and stored by hash; all succeed or none are stored. Duplicates repeat in the answer and are stored once. Nothing shows publicly until the owner approves an item that uses it. Put each image path in an image field with an alt description. photo_upload_link still takes one file." + " " + PHOTO_ADVICE;
const CHECK_DESCRIPTION = "Check proposed changes before approval. Default: ok, broken internal links and empty_sections, without rendering pages. Unapproved embed sources appear as non-failing embed_notes. Send deep: true once before approval on a new site or look change. It also checks rendered reachability (unreachable). A stop at 200 addresses or 10000 links returns crawl, ok: false and unreachable: []. Deep is heavy and can exceed Cloudflare Free CPU limits on big sites.";
const STATES = {
  live: "published, and the current version is what visitors see",
  changed: "published, with a newer version that isn't approved yet",
  new: "never published",
  "removal staged": "published, and removed here; the removal waits for approval",
  removed: "removed and not published",
};

/** Share only immutable schemas; servers, callbacks and auth stay per request. */
function toolSchema<T extends z.ZodType>(schema: T): T {
  const standard = schema["~standard"];
  const cached = <F extends (...args: any[]) => any>(convert: F): F => {
    const values = new Map<string, ReturnType<F>>();
    return ((...args: Parameters<F>) => {
      const key = JSON.stringify(args);
      if (!values.has(key)) values.set(key, convert(...args));
      return values.get(key)!;
    }) as F;
  };
  const input = cached(standard.jsonSchema.input);
  // The pinned MCP SDK requests this target. Prepare it during module startup,
  // while retaining normal conversion for any other options it may request.
  input({ target: "draft-2020-12" });
  Object.defineProperty(schema, "~standard", { value: { ...standard, jsonSchema: {
    input, output: cached(standard.jsonSchema.output),
  } } });
  return schema;
}
const INPUT_SCHEMAS = {
  site_state: toolSchema(z.object({ full: z.boolean().optional(), ids: z.array(z.string()).optional() })),
  item_create: toolSchema(z.object({
        kind: z.enum(KINDS as [string, ...string[]]),
        data: z.record(z.string(), z.unknown()),
        idempotency_key: z
          .string()
          .max(100)
          .optional()
          .describe("Optional. Resending the same key returns the item already created (with replayed: true) instead of a duplicate. Use a new key for a different item."),
      })),
  item_update: toolSchema(z.object({
        id: z.string(),
        version: z.number().int(),
        data: z.record(z.string(), z.unknown()),
        reason: z.string().max(300).optional(),
      })),
  item_remove: toolSchema(z.object({ id: z.string(), version: z.number().int(), reason: z.string().max(300).optional() })),
  item_history: toolSchema(z.object({ id: z.string() })),
  item_rollback: toolSchema(z.object({ id: z.string(), to_version: z.number().int(), version: z.number().int(), reason: z.string().max(300).optional() })),
  photo_upload_link: toolSchema(z.object({
        purpose: z.string().max(200).default("").describe("shown on the upload page, e.g. the cover for your trip post"),
      })),
  image_add: toolSchema(z.object({
        data: z.string().optional().describe("one picture's bytes, base64 (standard or URL-safe alphabet); give data or images"),
        images: z.array(z.string()).min(1).max(8).optional().describe("1 to 8 base64 pictures, at most 8 MB each and 8 MB decoded in total; give images or data"),
      })),
  photo_upload_status: toolSchema(z.object({ id: z.string() })),
  theme_list: toolSchema(z.object({})),
  theme_request: toolSchema(z.object({
        type: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/).describe("what the site is for, one word or two with a dash: business, club, event, portfolio, family"),
        title: z.string().min(3).max(80).describe("a short name for the look, e.g. Small business with opening hours"),
        description: z.string().min(10).max(600).describe("what the site needs that no theme has, e.g. opening hours, a booking button, a weekly specials list"),
        examples: z.array(z.string().url()).max(3).default([]).describe("up to 3 https links to sites your person likes the look of"),
      })),
  theme_install: toolSchema(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) })),
  theme_create: toolSchema(z.object({
        manifest: z.record(z.string(), z.any()),
        sample: z.record(z.string(), z.any()),
        pages: z.record(z.string(), z.string()),
        partials: z.record(z.string(), z.string()).default({}),
        css: z.string(),
      })),
  theme_submit: toolSchema(z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        note: z.string().min(10).max(600),
        author_x: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).optional().describe("the maker's X handle without the @, to credit them in the catalog once verified"),
      })),
  theme_needs: toolSchema(z.object({ name: z.string().optional() })),
  approval_request: toolSchema(z.object({ ids: z.array(z.string()).min(1).max(50), note: z.string().max(1000).default("") })),
  approval_status: toolSchema(z.object({ approval_id: z.string().optional() })),
  site_check: toolSchema(z.object({ deep: z.boolean().optional().describe("Optional. Also crawl rendered links; this is a heavy check.") })),
  site_stats: toolSchema(z.object({
        days: z.number().int().min(1).max(90).default(7).describe("the last N days, today included, 1 to 90"),
        content_id: z.string().optional().describe("only visits that read this item (an entry's id)"),
        src: z.string().optional().describe("only visits that came from links tagged ?src=<this>"),
        post: z.string().optional().describe("only visits that came from links tagged ?p=<this>"),
        include_test: z.boolean().default(false).describe("also count test visits (your own checks, automated browsers)"),
      }))
};

export const TOOL_DEFINITIONS = {
  site_state: {
      description: "Start here. By default, `items` summarizes every item as id, kind, title, state (see `states`) and version (send it with item_update / item_remove / item_rollback). Title is the item's title, a card's name or a note's text. Send full: true for the complete item shape, including data, slug, deleted, created_at, updated_at, live_version, pending_approval and last_approval. Send ids: [...] for full items only for those ids, in normal item order; ids takes precedence over full; [] returns no items; an unknown id refuses the call with no_such_item. pending_approval is the approval it is waiting in now or null; last_approval is its most recent request and how it ended or null; an item whose last request was denied or superseded and that the owner did not ask about again is best left alone. All top-level fields stay present: `states`, `kinds`, `fields`, `site_defaults`, `release` and `update`. `update` says whether a newer release is published (available; when true also latest, security, changes, migrations, reconnect, how): tell your person in plain words and update only when they say so, following `how`. Then change items, approval_request the ids you changed, give the owner the review_url.",
      inputSchema: INPUT_SCHEMAS.site_state,
      annotations: { readOnlyHint: true },
    },
  item_create: {
      description: `Create an item; nothing is public until the owner approves. Kinds: ${Object.entries(KIND_GUIDE)
        .map(([k, v]) => `${k}: ${v}`)
        .join(". ")}. data holds that kind's fields (see \`fields\` in site_state). ${NEW_SITE_ADVICE} ${EMBED_ADVICE} ${EMBED_SYNTAX}`,
      inputSchema: INPUT_SCHEMAS.item_create,
    },
  item_update: {
      description: "Change some fields of an item; send only the fields that change. version: the item's current version (from site_state or your last write); on version_conflict, re-read and redo." + " " + NEW_SITE_ADVICE + " " + EMBED_ADVICE + " " + EMBED_SYNTAX,
      inputSchema: INPUT_SCHEMAS.item_update,
    },
  item_remove: {
      description: "Remove an item (recoverable with item_rollback). Takes effect on the site once approved.",
      inputSchema: INPUT_SCHEMAS.item_remove,
    },
  item_history: {
      description: "Every version of an item, newest first, with who changed it and why; address_change {from, to} marks a version that changed an entry's slug (the old address redirects to the new one).",
      inputSchema: INPUT_SCHEMAS.item_history,
      annotations: { readOnlyHint: true },
    },
  item_rollback: {
      description: "Stage an earlier version of an item as a new version. Then ask for approval.",
      inputSchema: INPUT_SCHEMAS.item_rollback,
    },
  photo_upload_link: {
      description:
        "For a photo file: one your person sent you, or one you have yourself (an image with a public https link can go straight into an image field instead). Returns url, which works once, for 30 minutes. Send the file to it yourself: POST multipart/form-data with fields `photo` (the file: JPEG, PNG or WebP, up to 8 MB) and `alt` (what it shows, in a few words), with header Accept: application/json; the answer has `image` (a /media path) and `alt`. If you can't send files, give the url to your person instead: they open it, pick the photo and describe it, and photo_upload_status tells you when it's done. Put `image` in an image field (hero, cover, a card's image, or ![alt](image) in a body) and `alt` in its description field. Nothing shows publicly until the owner approves an item that uses it." + " " + PHOTO_ADVICE,
      inputSchema: INPUT_SCHEMAS.photo_upload_link,
    },
  image_add: {
      description: IMAGE_ADD_DESCRIPTION,
      inputSchema: INPUT_SCHEMAS.image_add,
    },
  photo_upload_status: {
      description: "How a photo_upload_link is going: status waiting (not sent yet), done (image and alt are ready to use) or expired (ask for a new link).",
      inputSchema: INPUT_SCHEMAS.photo_upload_status,
      annotations: { readOnlyHint: true },
    },
  theme_list: {
      description:
        "The site's look. Returns `my_requests` (themes this site asked the community for, each open, answered with the theme that answers it, or closed: tell your person when one is answered), `my_submissions` (looks this site shared: status, the curator's note, and, when the look claimed credit, credit: waiting, credited or not credited), `current` (the theme the site uses now, and the one waiting for approval if it differs), `installed` (themes this site has: built-in ones and ones installed from the catalog), and `catalog` (every theme you can install: name, title, type such as personal or product, description, previews to show your person, version, and author_x: the X handle of the look's maker, when the look is credited). Looks marked source: built-in are ready to use without installing. Set the site theme, then call theme_needs. Use theme_install only for a catalog look missing from installed, or to update one. Ask your person what the site is for, show them the catalog themes of that type with their previews, and let them pick.",
      inputSchema: INPUT_SCHEMAS.theme_list,
      annotations: { readOnlyHint: true },
    },
  theme_request: {
      description:
        "When no catalog theme fits what your person's site is for, ask the Porchsite community for one. Sent privately from this site to a queue a curator reads; nothing your person says is published. Describe the site and what it needs, in your own words, without names, addresses or anything personal. Then build with the closest theme meanwhile; theme_list's my_requests shows when it's answered. A site can file 3 a day.",
      inputSchema: INPUT_SCHEMAS.theme_request,
    },
  theme_install: {
      description:
        "Install (or update) a theme from the Porchsite catalog, by name. Only catalog themes can be installed, and the download is checked against the catalog. Installing changes nothing visitors see: to use it, set the site item's theme field and ask for approval. Then call theme_needs.",
      inputSchema: INPUT_SCHEMAS.theme_install,
    },
  theme_create: {
      description:
        `Make a look of your own for this site only (nobody else sees it), when no catalog theme fits and your person wants one now. Read ${HOME}/authoring.md first. Send the whole look: manifest (template.json's fields: name, title, type, version, description, slots, art), sample (generic sample content, no real person), pages (home, entry, archive, tag, not_found as Mustache), partials (optional) and css (the stylesheet). No scripts. The site checks it against the template rules and refuses with the list of problems, or stores it. Sending the same name again replaces it (bump version). Then set the site item's theme to its name and ask for approval; your person sees it on the preview first.`,
      inputSchema: INPUT_SCHEMAS.theme_create,
    },
  theme_submit: {
      description:
        "Share a look this site made (theme_create) with everyone, ONLY when your person has said yes to sharing it. It goes privately to the Porchsite review queue from this site's server; the checks run again there, a curator reviews it, and the Porchsite owner decides whether it joins the public catalog. theme_list's my_submissions shows where it stands. In note: who the look is for and what it does that no catalog theme does. To credit the maker, pass author_x: their X handle (credit is an X handle and nothing else; never send a name, email or link), only if they want it; the answer's credit.instructions say what they post on X to prove it. A site can share 3 a day.",
      inputSchema: INPUT_SCHEMAS.theme_submit,
    },
  theme_needs: {
      description:
        "What a theme wants from this site, checked against the site as it stands now (your unapproved changes included). `images`: each picture slot with field, size (width x height; the shape matters), need (required, recommended, optional), purpose, alt_hint, prompt (a starting point if you make the image) and status (filled, missing, wrong shape, too small). `content`: the words and settings it reads, with what it does with each. `art`: how to make the pictures, as a designer would brief you: what to ask your person (the subject), the style, a prompt_prefix, and the steps, including the checks to run before you use any of it. Follow it. Your person may change the style. Omit name for the site's theme.",
      inputSchema: INPUT_SCHEMAS.theme_needs,
      annotations: { readOnlyHint: true },
    },
  approval_request: {
      description:
        "Ask the owner to approve items you created, changed or removed (state new, changed, removed or removal staged in site_state). List only the ids for this request; an id with no unapproved change is refused. A newer request for an item replaces it in any older request. Returns id and review_url: give the review_url to the owner (it opens only for them, after they sign in; there is no preview link for you). Nothing goes live until they approve.",
      inputSchema: INPUT_SCHEMAS.approval_request,
    },
  approval_status: {
      description:
        "Look up one approval by approval_id, or omit it for the 10 most recent. Each has review_url, status (pending: something still waits for the owner | decided) and per item: status (pending | published | changes_requested: make the edit in its note, then ask again | denied | superseded: the item changed after you asked, ask again) and note, plus the owner's decision_note.",
      inputSchema: INPUT_SCHEMAS.approval_status,
      annotations: { readOnlyHint: true },
    },
  site_check: {
      description: CHECK_DESCRIPTION,
      inputSchema: INPUT_SCHEMAS.site_check,
      annotations: { readOnlyHint: true },
    },
  site_stats: {
      description:
        "Who reads the site: first-party visitor numbers, nothing that identifies a person; visitor statistics exclude the owner, bots and test runs. Also returns agent_traffic: site-wide daily anonymous public request counts and totals by estimated agent kind, with coverage and classification limits; content and campaign filters do not apply to these counts. Returns `totals` (visits: one visitor on one day; views; engaged time; the typical visit; bounce_rate; multi_page_rate), `daily`, `pages` (per address: readers, typical and mean engaged time, how far down they read, landings, bounce_rate, exits), `sources` and `referring_domains`, and `tagged` (links you shared with ?src=<where>&p=<post> on the end), and `earlier` (past 90 days only the counts are kept: visits and views by month, newest first; the whole site only). Narrow to the visits that read one item with content_id, or that came from one tagged link with src and post.",
      inputSchema: INPUT_SCHEMAS.site_stats,
      annotations: { readOnlyHint: true },
    }
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "porchsite", version: "0.0.1" }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

export function createToolHandlers() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  registerTools({ registerTool: ((name: string, _definition: unknown, handler: (args: any) => Promise<any>) => {
    handlers.set(name, handler);
    return {};
  }) as McpServer["registerTool"] });
  return handlers;
}

function registerTools(server: Pick<McpServer, "registerTool">) {
  const db = (env as unknown as Env).DB;
  const origin = () => (toolProps() as { origin?: string }).origin ?? "";

  server.registerTool(
    "site_state",
    TOOL_DEFINITIONS.site_state,
    async ({ full, ids }) =>
      run(async () => ({
        items: await stateItems(db, full, ids),
        states: STATES,
        kinds: KIND_GUIDE,
        fields: fieldGuide(),
        site_defaults: content.validate("site", {}),
        release: RELEASE,
        update: await privacy.withRollback(db,RELEASE,await update.check((env as unknown as Env).OAUTH_KV)),
      })),
  );

  server.registerTool(
    "item_create",
    TOOL_DEFINITIONS.item_create,
    async ({ kind, data, idempotency_key }) =>
      run(async () => {
        const item = await content.createItem(db, actor(), kind, data, idempotency_key);
        const [shown] = await describe(db, [await content.getItem(db, item.id)]);
        return { ...shown, ...(item.replayed ? { replayed: true } : {}), next: NEXT };
      }),
  );

  server.registerTool(
    "item_update",
    TOOL_DEFINITIONS.item_update,
    async ({ id, version, data, reason }) => run(async () => ({ ...(await describe(db, [await content.updateItem(db, actor(), id, version, data, reason)]))[0], next: NEXT })),
  );

  server.registerTool(
    "item_remove",
    TOOL_DEFINITIONS.item_remove,
    async ({ id, version, reason }) => run(async () => ({ ...(await describe(db, [await content.removeItem(db, actor(), id, version, reason)]))[0], next: NEXT })),
  );

  server.registerTool(
    "item_history",
    TOOL_DEFINITIONS.item_history,
    async ({ id }) => run(async () => ({ versions: await content.history(db, id) })),
  );

  server.registerTool(
    "item_rollback",
    TOOL_DEFINITIONS.item_rollback,
    async ({ id, to_version, version, reason }) => run(async () => ({ ...(await describe(db, [await content.rollback(db, actor(), id, to_version, version, reason)]))[0], next: NEXT })),
  );

  server.registerTool(
    "photo_upload_link",
    TOOL_DEFINITIONS.photo_upload_link,
    async ({ purpose }) =>
      run(async () => {
        const { path, ...u } = await uploads.create(db, actor(), purpose);
        return { ...u, url: `${origin()}${path}`, next: "Send the url to your person, then check photo_upload_status with this id." };
      }),
  );

  server.registerTool(
    "image_add",
    TOOL_DEFINITIONS.image_add,
    async ({ data, images }) => run(() => imageAdd(db, actor(), data, images)),
  );

  server.registerTool(
    "photo_upload_status",
    TOOL_DEFINITIONS.photo_upload_status,
    async ({ id }) => run(async () => uploads.get(db, id)),
  );

  server.registerTool(
    "theme_list",
    TOOL_DEFINITIONS.theme_list,
    async () =>
      run(async () => {
        const live = String((await content.siteData(db, true)).theme);
        const staged = String((await content.siteData(db, false)).theme);
        let catalog: Record<string, unknown>[] = [];
        let catalog_error = "";
        try {
          catalog = themes.listing(await themes.catalog());
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          catalog_error = e.message;
        }
        return {
          current: { live, waiting: staged !== live ? staged : null },
          installed: await themes.installed(db),
          next: "Looks marked built-in are ready to use: set the site theme, then run theme_needs. Use theme_install only for a catalog look missing from installed or to update one.",
          catalog,
          ...(catalog_error ? { catalog_error } : {}),
          my_requests: await requests.mine(db),
          my_submissions: await requests.mySubmissions(db),
        };
      }),
  );

  server.registerTool(
    "theme_request",
    TOOL_DEFINITIONS.theme_request,
    async (input) => run(async () => ({ ...(await requests.file(db, origin(), actor(), input)), next: "Tell your person you've asked; build with the closest theme meanwhile." })),
  );

  server.registerTool(
    "theme_install",
    TOOL_DEFINITIONS.theme_install,
    async ({ name }) =>
      run(async () => ({
        ...(await themes.install(db, name, actor())),
        next: "If site_state lists no site item, use item_create with kind site and theme set to this name; otherwise use item_update to set its theme. Then call theme_needs to see what it wants, fill that in, then approval_request.",
      })),
  );

  server.registerTool(
    "theme_create",
    TOOL_DEFINITIONS.theme_create,
    async (made) =>
      run(async () => ({
        ...(await themes.create(db, made, actor())),
        source: "private",
        next: "If site_state lists no site item, use item_create with kind site and theme set to this name; otherwise use item_update to set its theme. Then call theme_needs, fill what it lists, then approval_request; your person checks the preview before approving.",
      })),
  );

  server.registerTool(
    "theme_submit",
    TOOL_DEFINITIONS.theme_submit,
    async ({ name, note, author_x }) =>
      run(async () => {
        const r = await requests.submit(db, origin(), actor(), name, note, undefined, author_x);
        return {
          ...r,
          next: r.credit
            ? "Tell your person it's been sent for review, and give them credit.instructions word for word: the look is credited only after that post. You'll see its status in theme_list."
            : "Tell your person it's been sent for review; you'll see its status in theme_list.",
        };
      }),
  );

  server.registerTool(
    "theme_needs",
    TOOL_DEFINITIONS.theme_needs,
    async ({ name }) =>
      run(async () => {
        const want = name ?? String((await content.siteData(db, false)).theme);
        const t = await themes.load(db, want);
        if (!t) throw new ApiError(404, "no_such_theme", `This site doesn't have a theme called ${want}. theme_list shows what it has; theme_install adds one from the catalog.`);
        return themes.needs(db, t);
      }),
  );

  server.registerTool(
    "approval_request",
    TOOL_DEFINITIONS.approval_request,
    async ({ ids, note }) =>
      run(async () => {
        const a = await approvals.request(db, actor(), ids, note);
        alerts.schedule(db,a.id);
        return {
          ...a,
          review_url: `${origin()}/review/${a.id}`,
          next: "Send the review_url to the owner; they sign in with their passkey to decide. Check approval_status before changing these items again.",
        };
      }),
  );

  server.registerTool(
    "approval_status",
    TOOL_DEFINITIONS.approval_status,
    async ({ approval_id }) =>
      run(async () => {
        const withUrl = (a: approvals.Approval) => ({ ...a, review_url: `${origin()}/review/${a.id}` });
        return approval_id ? withUrl(await approvals.get(db, approval_id)) : { approvals: (await approvals.list(db)).slice(0, 10).map(withUrl) };
      }),
  );

  server.registerTool(
    "site_check",
    TOOL_DEFINITIONS.site_check,
    async ({ deep }) =>
      run(async () => {
        const changes = (await content.staged(db)).map((i) => ({ id: i.id, version: i.version }));
        const v = await proposedView(db, changes);
        const { results } = await db.prepare("SELECT name FROM media").all<{ name: string }>();
        const names = new Set(results.map((r) => r.name));
        const result = deep ? await checkSiteDeep(v, names, await themes.load(db, String(v.site.theme)), origin()) : checkSite(v, names);
        const notes = v.entries.some(e => String(e.body ?? "").includes("!embed[")) ? embedNotes(v.entries, (await content.siteData(db, true)).embed_sources, origin()) : [];
        return {...result, ...(notes.length ? {embed_notes: notes} : {})};
      }),
  );

  server.registerTool(
    "site_stats",
    TOOL_DEFINITIONS.site_stats,
    async ({ days, content_id, src, post, include_test }) => run(async () => analytics.stats(db, { days, content_id, src, post, include_test })),
  );

  return server;
}
