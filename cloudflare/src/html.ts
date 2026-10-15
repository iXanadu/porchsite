/** HTML helpers shared by the public site and the owner pages. */

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A tagged template whose interpolations are escaped unless wrapped in raw(). */
export class Raw {
  constructor(readonly html: string) {}
  toString() {
    return this.html;
  }
}
export const raw = (html: string) => new Raw(html);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.html : esc(x))).join("") : v instanceof Raw ? v.html : esc(v);
    out += part + strings[i + 1];
  });
  return new Raw(out);
}

export function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * Markdown, safe and deliberately small (spec/SPEC.md, "Markdown"). Raw HTML
 * is escaped, never passed through; links go only to http(s), mailto, "/" and
 * "#" addresses; images only to /media/. The server edition's
 * server/spec/html.py is a line-for-line port: both must give the same bytes
 * (spec/markdown-cases.json).
 */
export function markdown(src: string, block?: (line: string) => string | null, headingIds = false): Raw {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  return raw(mdBlocks(lines, 0, false, block, headingIds ? new Set<string>() : undefined).blocks.map((b) => b.html).join("\n"));
}

/** Slugs use the visible inline text, not link targets or Markdown punctuation. */
function headingId(inner: string, used: Set<string>): string {
  const text = inner.replace(/<[^>]*>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  const base = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
  let id = base, count = 2;
  while (used.has(id)) id = `${base}-${count++}`;
  used.add(id);
  return id;
}

type MdBlock = { html: string; para?: string };
type MdItem = { kind: "ul" | "ol"; start: number; k: number; w: number; first: string };

const MD_MAX_DEPTH = 16;
const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isBlank = (line: string) => line.trim() === "";
const isWord = (c: string | undefined) => {
  if (c === undefined) return false;
  const n = c.charCodeAt(0);
  return /[A-Za-z0-9]/.test(c) || (n > 127 && !isWs(c) && !(n >= 0x2000 && n <= 0x206f));
};
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const OPENS_QUOTE = "([{<-*_\"'/";
/** Where a bare web address in text ends (it gets no smart punctuation). */
const URL_STOP = "\"'<>()[]`*";

function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col += 1;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Drops up to n columns of leading spaces and tabs. */
function stripCols(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === " " ? 1 : 4 - (col % 4);
    i++;
  }
  return line.slice(i);
}

const stripLeft = (s: string) => s.replace(/^[ \t]+/, "");

function mdFence(line: string): { ch: string; len: number; indent: number; lang: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const info = line.slice(m[0].length);
  if (m[2][0] === "`" && info.includes("`")) return null;
  const t = info.trim();
  let j = 0;
  while (j < t.length && !isWs(t[j])) j++;
  return { ch: m[2][0], len: m[2].length, indent: m[1].length, lang: t.slice(0, j) };
}

function mdFenceClose(line: string, ch: string, len: number): boolean {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!m && m[1][0] === ch && m[1].length >= len;
}

function mdHeading(line: string): { n: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})[ \t]+/.exec(line);
  if (!m) return null;
  const text = line.slice(m[0].length).trim();
  return text ? { n: m[1].length, text } : null;
}

const mdHr = (line: string) => indentOf(line) < 4 && /^([-*_])(?:[ \t]*\1){2,}$/.test(line.trim());
const mdQuote = (line: string) => /^ {0,3}>/.exec(line);

function mdItem(line: string): MdItem | null {
  const m = /^([ \t]*)([-*+]|[0-9]{1,9}[.)])[ \t]/.exec(line);
  if (!m) return null;
  const k = indentOf(m[1]);
  const mark = m[2];
  const rest = line.slice(m[1].length + mark.length);
  let n = 0;
  while (n < rest.length && (rest[n] === " " || rest[n] === "\t")) n++;
  const kind = mark.length === 1 && "-*+".includes(mark) ? "ul" : "ol";
  const start = kind === "ol" ? parseInt(mark.slice(0, -1), 10) : 1;
  if (isBlank(rest)) return { kind, start, k, w: k + mark.length + 1, first: "" };
  if (n > 4) return { kind, start, k, w: k + mark.length + 1, first: rest.slice(1) };
  return { kind, start, k, w: k + mark.length + n, first: rest.slice(n) };
}

/** A line that ends a lazy continuation (list item or quote). */
const mdStartsBlock = (line: string) =>
  indentOf(line) < 4 && (!!mdFence(line) || !!mdHeading(line) || mdHr(line) || !!mdQuote(line) || !!mdItem(line));

/** A line that ends a paragraph. In a list item any number starts a nested list; elsewhere only 1. does. */
function mdInterrupts(line: string, inItem: boolean): boolean {
  if (indentOf(line) >= 4) return false;
  if (mdFence(line) || mdHeading(line) || mdHr(line) || mdQuote(line)) return true;
  const it = mdItem(line);
  return !!it && it.first.trim() !== "" && (it.kind === "ul" || it.start === 1 || inItem);
}

function mdBlocks(lines: string[], depth: number, inItem = false, block?: (line: string) => string | null, ids?: Set<string>): { blocks: MdBlock[]; gap: boolean } {
  const out: MdBlock[] = [];
  let gap = false;
  let blankBefore = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      blankBefore = true;
      i++;
      continue;
    }
    if (blankBefore && out.length) gap = true;
    blankBefore = false;
    if (indentOf(line) >= 4) {
      const code: string[] = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) code.push(stripCols(lines[i++], 4));
      while (isBlank(code[code.length - 1])) {
        code.pop();
        blankBefore = true;
      }
      out.push({ html: `<pre><code>${esc(code.join("\n") + "\n")}</code></pre>` });
      continue;
    }
    const f = mdFence(line);
    if (f) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !mdFenceClose(lines[i], f.ch, f.len)) {
        let l = lines[i++];
        for (let s = 0; s < f.indent && l[0] === " "; s++) l = l.slice(1);
        code.push(l);
      }
      if (i < lines.length) i++;
      const cls = f.lang ? ` class="language-${esc(f.lang)}"` : "";
      out.push({ html: `<pre><code${cls}>${esc(code.length ? code.join("\n") + "\n" : "")}</code></pre>` });
      continue;
    }
    const special = depth === 0 && block ? block(line) : null;
    if (special !== null) { out.push({ html: special }); i++; continue; }
    const h = mdHeading(line);
    if (h) {
      const inner = mdInline(h.text);
      const id = ids ? ` id="${headingId(inner, ids)}"` : "";
      out.push({ html: `<h${h.n}${id}>${inner}</h${h.n}>` });
      i++;
      continue;
    }
    if (mdHr(line)) {
      out.push({ html: "<hr>" });
      i++;
      continue;
    }
    const q = depth < MD_MAX_DEPTH ? mdQuote(line) : null;
    if (q) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = mdQuote(l);
        if (m) {
          const rest = l.slice(m[0].length);
          inner.push(rest[0] === " " || rest[0] === "\t" ? rest.slice(1) : rest);
        } else if (!isBlank(l) && !isBlank(inner[inner.length - 1]) && !mdStartsBlock(l)) {
          inner.push(stripLeft(l));
        } else break;
        i++;
      }
      out.push({ html: `<blockquote>${mdBlocks(inner, depth + 1, false, undefined, ids).blocks.map((b) => b.html).join("")}</blockquote>` });
      continue;
    }
    const first = depth < MD_MAX_DEPTH ? mdItem(line) : null;
    if (first) {
      let cur = first;
      let loose = false;
      const items: MdBlock[][] = [];
      for (;;) {
        const content = [cur.first];
        let prevBlank = false;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            content.push("");
            prevBlank = true;
          } else {
            const ind = indentOf(l);
            if (ind >= cur.w) content.push(stripCols(l, cur.w));
            else if (ind >= cur.k + 2 && mdItem(l)) content.push(stripCols(l, ind));
            else if (!prevBlank && !mdStartsBlock(l)) content.push(stripLeft(l));
            else break;
            prevBlank = false;
          }
          i++;
        }
        let trailing = 0;
        while (content.length && isBlank(content[content.length - 1])) {
          content.pop();
          trailing++;
        }
        const r = mdBlocks(content, depth + 1, true, undefined, ids);
        if (r.gap) loose = true;
        items.push(r.blocks);
        const next = i < lines.length ? mdItem(lines[i]) : null;
        if (next && next.kind === first.kind && indentOf(lines[i]) < 4) {
          if (trailing) loose = true;
          cur = next;
          continue;
        }
        blankBefore = trailing > 0;
        break;
      }
      const lis = items
        .map((bs) => `<li>${bs.map((b) => (!loose && b.para !== undefined ? b.para : b.html)).join("")}</li>`)
        .join("");
      const open = first.kind === "ul" ? "<ul>" : first.start !== 1 ? `<ol start="${first.start}">` : "<ol>";
      out.push({ html: `${open}${lis}</${first.kind}>` });
      continue;
    }
    const para = [stripLeft(line)];
    i++;
    let spans: [number, number][] | undefined;
    let offset = para[0].length + 1;
    while (i < lines.length && !isBlank(lines[i]) && !mdInterrupts(lines[i], inItem)) {
      if (depth === 0 && block && lines[i].startsWith("!embed[")) {
        if (!para.some(p => p.includes("`"))) break;
        if (spans === undefined) {
          // Ask the ordinary inline parser: only spans in its chosen output
          // count, including multiline spans and escaped/backtracking cases.
          const rest: string[] = [];
          for (let j = i; j < lines.length && !isBlank(lines[j]) && !mdInterrupts(lines[j], inItem); j++) rest.push(stripLeft(lines[j]));
          const probe = mdInline([...para, ...rest].join("\n").replace(/[ \t]+$/, ""), true);
          spans = [...probe.matchAll(/<code data-md-code="(\d+):(\d+)">/g)].map(m => [Number(m[1]), Number(m[2])]);
        }
        if (!spans.some(([start, end]) => start <= offset && offset < end)) break;
      }
      const next = stripLeft(lines[i++]); para.push(next); offset += next.length + 1;
    }
    const text = mdInline(para.join("\n").replace(/[ \t]+$/, ""));
    out.push({ html: `<p>${text}</p>`, para: text });
  }
  return { blocks: out, gap };
}

/** Inline Markdown for one paragraph or heading: code, images, links, emphasis, breaks, smart punctuation. */
function mdInline(s: string, positions = false): string {
  // Lookup tables keep the scan near-linear however the text is built.
  const n = s.length;
  const runEnd = new Int32Array(n + 1); // end of the run of equal characters at i
  const nextClose = new Int32Array(n + 1); // next "]" at or after i, else -1
  const nextStop = new Int32Array(n + 1); // next whitespace or ")" at or after i, else n
  const nextQuote = new Int32Array(n + 1); // next '"' at or after i, else -1
  const nextText = new Int32Array(n + 1); // next non-whitespace at or after i, else n
  runEnd[n] = nextStop[n] = nextText[n] = n;
  nextClose[n] = nextQuote[n] = -1;
  for (let i = n - 1; i >= 0; i--) {
    runEnd[i] = s[i + 1] === s[i] ? runEnd[i + 1] : i + 1;
    nextClose[i] = s[i] === "]" ? i : nextClose[i + 1];
    nextStop[i] = isWs(s[i]) || s[i] === ")" ? i : nextStop[i + 1];
    nextQuote[i] = s[i] === '"' ? i : nextQuote[i + 1];
    nextText[i] = isWs(s[i]) ? nextText[i + 1] : i;
  }
  const match = new Int32Array(n).fill(-1); // "[" -> its "]", backslash escapes skipped
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") stack.push(i);
    else if (s[i] === "]" && stack.length) match[stack.pop() as number] = i;
  }
  const ticks = new Map<number, number[]>(); // backtick run length -> where such runs start
  for (let i = 0; i < n; i++) {
    if (s[i] !== "`") continue;
    const at = ticks.get(runEnd[i] - i);
    if (at) at.push(i);
    else ticks.set(runEnd[i] - i, [i]);
    i = runEnd[i] - 1;
  }
  /** The first backtick run of exactly len that starts at or after i, else -1. */
  const tickRun = (i: number, len: number) => {
    const at = ticks.get(len) ?? [];
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo < at.length ? at[lo] : -1;
  };
  const run = (i: number, end: number) => Math.min(runEnd[i], end) - i;
  const memo = new Map<string, { html: string; pos: number } | null>();
  // Where a failed emphasis scan went: another scan for the same closer that reaches one of these fails too.
  const dead = new Map<string, Set<number>>();

  /** A link may go to http(s), mailto, "/..." or "#...": the address s[at, at + len). */
  const linkDest = (at: number, len: number) =>
    ((s.startsWith("http://", at) || s.startsWith("mailto:", at)) && len > 7) ||
    (s.startsWith("https://", at) && len > 8) ||
    ((s[at] === "/" || s[at] === "#") && len > 0);
  const MEDIA = /\/media\/[A-Za-z0-9._-]+\)/y;

  function parse(
    start: number,
    end: number,
    close: string,
    need: number,
    noLinks: boolean,
    depth: number,
  ): { html: string; pos: number } | null {
    const key = `${start}|${end}|${close}|${need}|${noLinks}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let out = "";
    let i = start;
    let res: { html: string; pos: number } | null = null;
    const deadKey = `${end}|${close}|${need}|${noLinks}`;
    const gone = dead.get(deadKey) ?? new Set<number>();
    dead.set(deadKey, gone);
    const seen: number[] = [];
    while (i < end) {
      if (close) {
        if (i > start && gone.has(i)) break;
        seen.push(i);
      }
      const c = s[i];
      if (c === "*" || c === "_") {
        const r = run(i, end);
        const after = i + r < end ? s[i + r] : undefined;
        if (c === close && i > start && !isWs(s[i - 1]) && r >= need && (c === "*" || !isWord(after))) {
          res = { html: out, pos: i + need };
          break;
        }
        const canOpen = after !== undefined && !isWs(after) && (c === "*" || !isWord(s[i - 1]));
        if (canOpen && depth < MD_MAX_DEPTH) {
          let done = false;
          for (const w of r >= 2 ? [2, 1] : [1]) {
            const inner = parse(i + w, end, c, w, noLinks, depth + 1);
            if (inner) {
              const tag = w === 2 ? "strong" : "em";
              out += `<${tag}>${inner.html}</${tag}>`;
              i = inner.pos;
              done = true;
              break;
            }
          }
          if (done) continue;
        }
        out += c;
        i++;
        continue;
      }
      if (s.startsWith("!embed[", i) || s.startsWith("\\!embed[", i)) {
        const start = c === "\\" ? i + 1 : i;
        const stop = s.indexOf(")", start);
        const to = stop < 0 || stop >= end ? end : stop + 1;
        out += esc(s.slice(start, to)); i = to; continue;
      }
      if (c === "\\") {
        const nx = i + 1 < end ? s[i + 1] : "";
        if (nx === "\n") {
          out += "<br>";
          i += 2;
        } else if (nx && ASCII_PUNCT.includes(nx)) {
          out += esc(nx);
          i += 2;
        } else {
          out += "\\";
          i++;
        }
        continue;
      }
      if (c === "`") {
        const t = run(i, end);
        const found = tickRun(i + t, t);
        if (found < 0 || found >= end) {
          out += "`".repeat(t);
          i += t;
          continue;
        }
        let code = s.slice(i + t, found).replace(/\n/g, " ");
        if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && code.trim() !== "") code = code.slice(1, -1);
        out += `<code${positions ? ` data-md-code="${i}:${found + t}"` : ""}>${esc(code)}</code>`;
        i = found + t;
        continue;
      }
      if (c === "!" && s[i + 1] === "[" && i + 1 < end) {
        const k = nextClose[i + 2];
        if (k >= 0 && k < end && s[k + 1] === "(") {
          MEDIA.lastIndex = k + 2;
          const m = MEDIA.exec(s);
          if (m && k + 2 + m[0].length <= end) {
            const alt = s.slice(i + 2, k).replace(/\n/g, " ");
            out += `<img alt="${esc(alt)}" src="${m[0].slice(0, -1)}">`;
            i = k + 2 + m[0].length;
            continue;
          }
        }
        out += "!";
        i++;
        continue;
      }
      if (c === "[" && !noLinks && depth < MD_MAX_DEPTH) {
        const k = match[i];
        if (k >= 0 && k < end && k > i + 1 && s[k + 1] === "(") {
          const at = Math.min(k + 2, end);
          const stop = Math.min(nextStop[at], end);
          let p = Math.min(nextText[stop], end);
          let title = -1; // where the title's closing quote is
          if (p < end && s[p] === '"') {
            const q = nextQuote[p + 1];
            if (q >= 0 && q < end) {
              title = q;
              p = Math.min(nextText[q + 1], end);
            } else p = end;
          }
          if (p < end && s[p] === ")" && linkDest(at, stop - at)) {
            const text = parse(i + 1, k, "", 0, true, depth + 1);
            if (text) {
              const t = title >= 0 ? ` title="${esc(s.slice(nextText[stop] + 1, title).replace(/\n/g, " "))}"` : "";
              out += `<a href="${esc(s.slice(at, stop))}"${t}>${text.html}</a>`;
              i = p + 1;
              continue;
            }
          }
        }
        out += "[";
        i++;
        continue;
      }
      if (c === "h" && (s.startsWith("http://", i) || s.startsWith("https://", i)) && !isWord(s[i - 1])) {
        let j = i;
        while (j < end && !isWs(s[j]) && !URL_STOP.includes(s[j])) j++;
        out += esc(s.slice(i, j));
        i = j;
        continue;
      }
      if (c === "-") {
        let d = run(i, end);
        i += d;
        if (d === 1) out += "-";
        else {
          while (d >= 3) {
            out += "\u2014";
            d -= 3;
          }
          out += d === 2 ? "\u2013" : d === 1 ? "-" : "";
        }
        continue;
      }
      if (c === "." && s.startsWith("...", i) && i + 3 <= end) {
        out += "\u2026";
        i += 3;
        continue;
      }
      if (c === "'" || c === '"') {
        const prev = i > 0 ? s[i - 1] : undefined;
        const next = s[i + 1];
        const opens = (prev === undefined || isWs(prev) || OPENS_QUOTE.includes(prev)) && next !== undefined && !isWs(next);
        out += c === "'" ? (opens ? "\u2018" : "\u2019") : opens ? "\u201c" : "\u201d";
        i++;
        continue;
      }
      if (c === " ") {
        const sp = run(i, end);
        if (i + sp < end && s[i + sp] === "\n") {
          out += sp >= 2 ? "<br>" : " ";
          i += sp + 1;
        } else {
          out += " ".repeat(sp);
          i += sp;
        }
        continue;
      }
      if (c === "\n") {
        out += " ";
        i++;
        continue;
      }
      out += esc(c);
      i++;
    }
    if (!res && !close) res = { html: out, pos: i };
    if (!res) for (const v of seen) if (v > start) gone.add(v);
    memo.set(key, res);
    return res;
  }

  return parse(0, s.length, "", 0, false, 0)?.html ?? "";
}

export function respond(body: Raw | string, init: ResponseInit & { csp?: string } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (init.csp) headers.set("Content-Security-Policy", init.csp);
  return new Response(String(body), { status: init.status ?? 200, headers });
}
