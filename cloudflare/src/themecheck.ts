/**
 * The template rules (TEMPLATES.md §2) as far as a machine can check them.
 * Shared by the developer kit (npm run theme:check) and the site itself
 * (theme_create), so an assistant's own look meets the same bar as a
 * reviewed one. Assistant-made looks may not carry scripts at all.
 */
import Mustache from "mustache";
import { paletteProblems } from "./blocks";
import { MODELS } from "./models";
import * as site from "./site";
import * as theme from "./theme";
import type { Theme } from "./themes";

const PAGES = ["home", "entry", "archive", "tag", "not_found"];
const ALLOWED_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
/** An X handle, without the @: X's own rule (1 to 15 letters, digits or underscores). */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** Credit is an X handle and nothing else: no names, emails or links. */
const OTHER_AUTHOR = /^(author|creator|contact|e-?mail|homepage|website|url|twitter)(_|$)/i;

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/** Problems with a theme's files, or [] when it's sound. */
export function rules(name: string, t: Theme, opts: { scripts: boolean }): string[] {
  const problems: string[] = [];
  const m = t.manifest ?? {};
  const need = (ok: unknown, msg: string) => !ok && problems.push(msg);
  need(m.name === name, `template.json name is "${m.name}", not "${name}"`);
  need(/^[a-z][a-z0-9-]{0,39}$/.test(name), "name: lowercase letters, digits and dashes");
  need(typeof m.title === "string" && m.title, "template.json needs a title");
  need(/^\d+\.\d+\.\d+$/.test(String(m.version)), "version must look like 1.0.0");
  need(/^[a-z][a-z0-9-]{1,29}$/.test(String(m.type ?? "")), "type: what the site is for, e.g. personal, product, business");
  need(typeof m.description === "string" && m.description.length >= 20, "description: a sentence or two for people choosing a look");
  need(m.art && m.art.ask && m.art.style && Array.isArray(m.art.steps) && m.art.steps.length, "art: ask, style and steps are required");
  if ("author_x" in m) need(typeof m.author_x === "string" && X_HANDLE.test(m.author_x), "author_x: an X handle without the @ (1 to 15 letters, digits or underscores)");
  for (const k of Object.keys(m)) if (k !== "author_x" && OTHER_AUTHOR.test(k)) problems.push(`${k}: credit is an X handle in author_x and nothing else (no names, emails or links)`);
  for (const s of m.slots?.images ?? []) {
    need(Array.isArray(s.size) && s.size.length === 2 && s.size.every((n: number) => n > 0), `image slot ${s.field}: size [width, height]`);
    need(["required", "recommended", "optional"].includes(s.need), `image slot ${s.field}: need is required, recommended or optional`);
    need(s.purpose, `image slot ${s.field}: say what it's for`);
  }
  problems.push(...paletteProblems(m.palettes));
  for (const p of PAGES) need(typeof t.pages?.[p] === "string", `missing ${p}.mustache`);
  need(typeof t.static?.["site.css"] === "string", "missing static/site.css");
  for (const f of Object.keys(t.static ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(f)) problems.push(`static/${f}: file names are lowercase letters, digits, dots and dashes`);
    else if (!opts.scripts && !f.endsWith(".css")) problems.push(`static/${f}: only stylesheets (.css); a look made by an assistant carries no scripts`);
  }
  const sources: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.pages ?? {})) sources[`${k}.mustache`] = v;
  for (const [k, v] of Object.entries(t.partials ?? {})) sources[`partials/${k}.mustache`] = v;
  for (const [file, src] of Object.entries(sources)) {
    try {
      Mustache.parse(src);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
    if (/\{\{=/.test(src)) problems.push(`${file}: delimiter changes aren't allowed`);
    for (const tri of src.match(/\{\{\{[^}]*\}\}\}/g) ?? []) if (!/_html\s*\}\}\}$/.test(tri)) problems.push(`${file}: triple braces only for *_html values (${tri})`);
    if (/\{\{&/.test(src)) problems.push(`${file}: {{& }} (unescaped) isn't allowed`);
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(src)) problems.push(`${file}: inline <script>; load scripts from static/ with src`);
    // The site's own scripts (kit.*_url) are fine anywhere; a look made by an assistant brings none of its own.
    if (!opts.scripts) {
      for (const tag of src.match(/<script\b[^>]*>/gi) ?? []) {
        if (!/\bsrc="\{\{kit\.[a-z_]+_url\}\}"/.test(tag)) problems.push(`${file}: scripts only from the site's kit ({{kit.*_url}}); a look made by an assistant carries none of its own`);
      }
    }
    if (/\son[a-z]+\s*=/i.test(src)) problems.push(`${file}: inline event handlers (onclick=…) aren't allowed`);
    if (/<(iframe|object|embed|form)\b/i.test(src)) problems.push(`${file}: no iframes, objects, embeds or forms`);
    for (const img of src.match(/<img\b[^>]*>/gi) ?? []) if (!/\balt="/.test(img)) problems.push(`${file}: <img> without alt from the view`);
    for (const u of src.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) if (!ALLOWED_HOSTS.includes(host(u))) problems.push(`${file}: outside address ${u}`);
    const text = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/\{\{[\s\S]*?\}\}/g, " ");
    const words = text.match(/[A-Za-z]{2,}/g);
    if (words) problems.push(`${file}: fixed words (${[...new Set(words)].slice(0, 6).join(", ")}); take them from the view`);
  }
  for (const [f, css] of Object.entries(t.static ?? {})) {
    for (const u of css.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) if (!ALLOWED_HOSTS.includes(host(u))) problems.push(`static/${f}: outside address ${u}`);
    if (f.endsWith(".css") && /@import\s+(?!url\(\s*["']?https:\/\/fonts\.googleapis\.com)/i.test(css)) problems.push(`static/${f}: @import only for Google Fonts`);
    if (f.endsWith(".css") && /expression\(|javascript:|(?<![-\w])behavior\s*:/i.test(css)) problems.push(`static/${f}: no CSS expressions or javascript: URLs`);
  }
  return problems;
}

type Sample = { site: Record<string, unknown>; items: { kind: string; slug?: string; data: Record<string, unknown> }[] };

/** A sample site's view, as the site itself would build it. */
export function sampleView(t: Theme, sample: Sample, now?: Date) {
  const name = String(t.manifest.name);
  const s = (MODELS as any).site.parse({ ...sample.site, theme: name });
  const rows = sample.items.map((it, i) => ({ id: `i${i}`, kind: it.kind, slug: it.slug ?? `item-${i}`, data: (MODELS as any)[it.kind].parse(it.data) }));
  const v = site.view(s, rows);
  v.updated = "Oct 10, 9:00 AM CT";
  if (now) v.now = now;
  return v;
}

/** Every page of a sample site: home, each entry, each stream's archive and tag pages, the 404. */
export function renderSample(t: Theme, sample: Sample, o = "https://example.com", now?: Date): Record<string, string> {
  const v = sampleView(t, sample, now);
  const out: Record<string, string> = { "index.html": theme.render(t, "home", theme.homeView(v, "1", o)) };
  for (const e of v.entries.filter((x) => !x.external_url)) out[`${String(e.page).slice(1)}index.html`] = theme.render(t, "entry", theme.entryView(v, e, "1", o));
  for (const st of theme.streams(v.site)) {
    const path = String(st.archive_url).replace(/^\/|\/$/g, "");
    const av = theme.archiveView(v, path, "1", o);
    if (av) out[`${path}/index.html`] = theme.render(t, "archive", av);
    const tags = new Set(v.entries.filter((e) => e.stream === st.id).flatMap((e) => (e.tags ?? []) as string[]));
    for (const tag of tags) out[`${path}/tags/${tag}/index.html`] = theme.render(t, "tag", theme.archiveView(v, path, "1", o, tag)!);
  }
  out["404.html"] = theme.render(t, "not_found", theme.notFoundView(v, "1", o));
  return out;
}

/** The rules, then the sample rendered: every page must come out whole. */
export function check(name: string, t: Theme, sample: unknown, opts: { scripts: boolean }): string[] {
  const problems = rules(name, t, opts);
  if (!sample || typeof sample !== "object") problems.push("sample.json: generic sample content (no real person) for previews");
  if (problems.length) return problems;
  try {
    for (const [p, html] of Object.entries(renderSample(t, sample as any))) if (html.includes("{{")) problems.push(`${p}: unrendered {{ in output`);
  } catch (e) {
    problems.push(`the sample site doesn't render: ${(e as Error).message}`);
  }
  return problems;
}
