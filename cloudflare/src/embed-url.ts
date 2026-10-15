/** Canonical HTTPS authority shared by source validation and player rendering. */
export const EMBED_ADVICE = "An embed shows a video or tour from another site on your page. Each new source needs your approval; once approved, pages can show anything from that source.";
export const EMBED_SYNTAX = "Put it on its own line in the body: !embed[Title](https://example.com/player).";
const invalid = () => new Error("Use a public https:// origin, without a path, login, query or fragment.");
const forbidden = /[\s\u0000-\u001f\u007f\u0085\ud800-\udfff\\]/u;
const hostForbidden = /[*\u3002\uff0e\uff61]/u;

function publicHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b,c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (host.startsWith("[")) {
    const h = host.slice(1,-1), parts = h.split("::"), left = parts[0] ? parts[0].split(":") : [], right = parts[1] ? parts[1].split(":") : [];
    const words = parts.length === 2 ? [...left, ...Array(8-left.length-right.length).fill("0"), ...right] : left;
    const n = words.reduce((n,w) => (n << 16n) + BigInt(`0x${w}`), 0n);
    if ((n >> 32n) === 0xffffn) {
      const v = Number(n & 0xffffffffn); return publicHost([v>>>24,(v>>>16)&255,(v>>>8)&255,v&255].join("."));
    }
    return (n >> 125n) === 1n && (n >> 105n) !== (0x20010000n >> 9n)
      && !h.startsWith("2001:db8:") && !h.startsWith("2002:");
  }
  return true;
}

export function embedURL(value: string, source = false): URL {
  if (value.length > 2000 || !/^https:\/\//i.test(value) || forbidden.test(value)) throw invalid();
  const authority = value.slice(8).split(/[/?#]/,1)[0];
  let decoded: string;
  try { decoded = decodeURIComponent(authority); } catch { throw invalid(); }
  if (!authority || hostForbidden.test(decoded) || /[;,]/.test(decoded) || forbidden.test(decoded) || /[@/?#]/.test(decoded) || decoded.endsWith(".")) throw invalid();
  let u: URL;
  try { u = new URL(value); } catch { throw invalid(); }
  if (u.protocol !== "https:" || u.username || u.password || !publicHost(u.hostname)) throw invalid();
  if (source && ((u.pathname !== "/" && u.pathname !== "") || value.slice(8+authority.length).replace(/^\/$/, "") !== "")) throw invalid();
  if (!source && !u.port) {
    const youtube = ["youtube.com","www.youtube.com","m.youtube.com","youtu.be","www.youtube-nocookie.com"].includes(u.hostname);
    let id: string | null = null;
    if (youtube) {
      if (u.pathname === "/watch") { const ids = u.searchParams.getAll("v"); if (ids.length > 1) throw invalid(); id = ids[0] ?? null; }
      else if (u.hostname === "youtu.be") id = /^\/([^/]+)\/?$/.exec(u.pathname)?.[1] ?? null;
      else id = /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(u.pathname)?.[1] ?? null;
      if (id !== null) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid(); return new URL(`https://www.youtube-nocookie.com/embed/${id}`); }
    }
    if (u.hostname === "my.matterport.com" && ["/show", "/show/"].includes(u.pathname)) {
      const ids = u.searchParams.getAll("m"); if (ids.length > 1) throw invalid();
      if (ids.length) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(ids[0])) throw invalid(); return new URL(`https://my.matterport.com/show/?m=${ids[0]}`); }
    }
  }
  return u;
}

export function embedSources(values: string[]): string[] {
  if (values.length > 20) throw invalid();
  const out = values.map(v => embedURL(v, true).origin);
  if (new Set(out).size !== out.length) throw new Error("Each embed source may appear only once.");
  return out;
}

/** Display only: RFC 3492 decoding never grants authority. */
export function unicodeHost(host: string): string {
  return host.split(".").map(label => {
    if (!label.startsWith("xn--")) return label;
    try {
      const input = label.slice(4), cut = input.lastIndexOf("-");
      const out = cut < 0 ? [] : [...input.slice(0,cut)].map(c=>c.codePointAt(0)!);
      let at = cut < 0 ? 0 : cut+1, n = 128, i = 0, bias = 72;
      while (at < input.length) {
        const old = i; let w = 1;
        for (let k=36;;k+=36) {
          if (at >= input.length) throw invalid();
          const code=input.charCodeAt(at++), d=code>=97?code-97:code>=65?code-65:code-22;
          if (d<0 || d>=36) throw invalid();
          i+=d*w; const t=k<=bias?1:k>=bias+26?26:k-bias;
          if(d<t) break; w*=36-t; if(!Number.isSafeInteger(w+i)) throw invalid();
        }
        let delta=Math.floor((i-old)/(old===0?700:2)); delta+=Math.floor(delta/(out.length+1)); let k=0;
        while(delta>455){delta=Math.floor(delta/35);k+=36;}
        bias=k+Math.floor(36*delta/(delta+38)); n+=Math.floor(i/(out.length+1)); i%=out.length+1;
        out.splice(i++,0,n);
      }
      return String.fromCodePoint(...out);
    } catch { return label; }
  }).join(".");
}

export function requestOrigin(origin:string):string { try { return new URL(origin).origin; } catch { return ""; } }
