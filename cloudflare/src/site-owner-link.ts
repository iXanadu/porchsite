/** Owner navigation belongs to the engine, never to a look. */
import * as owner from "./owner";
import * as privacy from "./privacy";
export const OWNER_SITE_LINK = "<a class=\"sk-owner-link\" href=\"/review\" aria-label=\"Review changes and manage alerts\" style=\"position:fixed;right:12px;bottom:12px;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 12px;background:#fff;color:#111;border:2px solid #111;border-radius:8px;font:600 16px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px #0006;z-index:2147483647\">Review</a>";
export async function ownerSitePage(db: D1Database, req: Request, response: Response): Promise<Response> {
  if (![200, 404].includes(response.status) ||
      response.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase() !== "text/html" ||
      !await owner.signedIn(db, req)) return response;
  const body = await response.text();
  const closing = /<\/body\s*>/i;
  const html = closing.test(body) ? body.replace(closing, OWNER_SITE_LINK + "$&") : body + OWNER_SITE_LINK;
  const out = privacy.noStore(new Response(html, response));
  out.headers.delete("Content-Length");
  const vary = out.headers.get("Vary") || "";
  if (!vary.split(",").some(x => ["cookie", "*"].includes(x.trim().toLowerCase())))
    out.headers.set("Vary", vary ? vary + ", Cookie" : "Cookie");
  return out;
}
