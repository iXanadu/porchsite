// Theme developer kit. Run through scripts/theme.mjs:
//   npm run theme:preview <name>   render the sample site and open it
//   npm run theme:check <name>     check the rules, render every page, take previews
//   node scripts/theme.mjs raw <name> <themes> <outdir> [now]   the sample's pages, unmodified
import { structuredBlock } from '../src/structured-data';
import { markdownDocument } from '../src/agent-markdown';
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {sitemap, robots} from "../src/sitemap";
import {sampleView} from "../src/themecheck";
import { paletteCss } from "../src/blocks";
import { check, renderSample } from "../src/themecheck";

type Theme = { manifest: Record<string, any>; pages: Record<string, string>; partials: Record<string, string>; static: Record<string, string> };
const ROOT = resolve(process.argv[4] ?? "../themes");

function read(dir: string, ext: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => !ext || f.endsWith(ext)).map((f) => [ext ? f.slice(0, -ext.length) : f, readFileSync(join(dir, f), "utf8")]));
}

export function loadTheme(name: string): Theme {
  const dir = join(ROOT, name);
  return { manifest: JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), pages: read(dir, ".mustache"), partials: read(join(dir, "partials"), ".mustache"), static: read(join(dir, "static"), "") };
}

function writeSite(pages: Record<string, string>, t: Theme, dir: string, palette = "", sampleMedia = ""): void {
  for (const [p, html] of Object.entries(pages)) {
    const depth = p.split("/").length - 1;
    const up = "../".repeat(depth);
    const local = html
      .replace(/(href|src)="\/media\/([a-f0-9]{32}\.(?:jpg|png|webp))"/g, `$1="${up}media/$2"`)
      .replace(/(href|src)="\/static\/([^"?]+)[^"]*"/g, `$1="${up}static/$2"`)
      .replace(/href="\/([^"]*)"/g, (_m, q) => {
        const hash = q.indexOf("#"), path = hash < 0 ? q : q.slice(0, hash), anchor = hash < 0 ? "" : q.slice(hash);
        return `href="${up}${path}${path === "" || path.endsWith("/") ? "index.html" : ""}${anchor}"`;
      });
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), local);
  }
  if (sampleMedia && existsSync(sampleMedia)) {
    mkdirSync(join(dir, "media"), { recursive: true });
    for (const name of readdirSync(sampleMedia)) {
      const source = join(sampleMedia, name);
      if (/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(name) && statSync(source).isFile()) copyFileSync(source, join(dir, "media", name));
    }
  }
  mkdirSync(join(dir, "static"), { recursive: true });
  // The site's palette goes after the theme's stylesheet, as the site serves it.
  for (const [f, body] of Object.entries(t.static)) writeFileSync(join(dir, "static", f), f === "site.css" ? body + paletteCss(t.manifest.palettes, palette) : body);
}

function main() {
  const [cmd, name] = process.argv.slice(2);
  const names = name ? [name] : readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, "template.json")));
  if (cmd === "check") {
    let bad = 0;
    for (const n of names) {
      const sample = existsSync(join(ROOT, n, "sample.json")) ? JSON.parse(readFileSync(join(ROOT, n, "sample.json"), "utf8")) : null;
      // Built-in themes may carry their own scripts; looks made by assistants may not.
      const problems = check(n, loadTheme(n) as any, sample, { scripts: true });
      bad += problems.length;
      console.log(problems.length ? `✗ ${n}\n${problems.map((p) => `  - ${p}`).join("\n")}` : `✓ ${n}`);
    }
    process.exit(bad ? 1 : 0);
  }
  if (cmd === "render" || cmd === "preview") {
    if (!name) throw new Error("which theme? e.g. npm run theme:preview product-page");
    const t = loadTheme(name);
    const dir = resolve(process.argv[5] ?? join("theme-preview", name));
    const sample = JSON.parse(readFileSync(join(ROOT, name, "sample.json"), "utf8"));
    writeSite(renderSample(t as any, sample), t, dir, String(sample.site?.palette ?? ""), join(ROOT, name, "sample-media"));
    console.log(`rendered ${join(dir, "index.html")}`);
    if (cmd === "preview") execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [join(dir, "index.html")]);
    return;
  }
  if (cmd === "raw") {
    // The rendered pages exactly as the site serves them (no relative links,
    // no static files), at a fixed clock: what scripts/parity.sh compares.
    if (!name) throw new Error("which theme? e.g. theme raw product-page ../themes out 2026-10-15T15:30:00Z");
    const dir = resolve(process.argv[5] ?? join("theme-raw", name));
    const now = new Date(process.argv[6] ?? "2026-10-15T15:30:00Z");
    if (Number.isNaN(now.getTime())) throw new Error(`not a time: ${process.argv[6]}`);
    const pages = renderSample(loadTheme(name) as any, JSON.parse(readFileSync(join(ROOT, name, "sample.json"), "utf8")), "https://example.com", now);
    const v=sampleView(loadTheme(name) as any, JSON.parse(readFileSync(join(ROOT, name, "sample.json"), "utf8")), now);
    v.approved_at=Object.fromEntries(['site',...v.entries.map(e=>String(e.id)),...v.cards.map(e=>String(e.id)),...v.notes.map(e=>String(e.id))].map((id,i)=>[id,new Date(now.getTime()-i*86400000).toISOString()]));
    pages['sitemap.xml']=sitemap(v,'https://example.com');pages['robots.txt']=robots('https://example.com');
    for(const [p,html] of Object.entries(pages))if(p.endsWith('index.html')) {
      const canonical='https://example.com/'+p.slice(0,-10);
      pages[p]=html.replace('</head>',structuredBlock(html,canonical)+'</head>');
      pages[p.slice(0,-10)+'index.md']=markdownDocument(html,canonical).markdown;
    }
    for (const [p, html] of Object.entries(pages)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), html);
    }
    return;
  }
  console.log("usage: theme check [name] | theme preview <name> | theme raw <name> <themes> <outdir> [now]");
  process.exit(2);
}
main();
