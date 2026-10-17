"""Owner navigation belongs to the engine, never to a look."""
import re

from . import owner, privacy

OWNER_SITE_LINK = '<a class="sk-owner-link" href="/review" aria-label="Review changes and manage alerts" style="position:fixed;right:12px;bottom:12px;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 12px;background:#fff;color:#111;border:2px solid #111;border-radius:8px;font:600 16px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px #0006;z-index:2147483647">Review</a>'


async def owner_site_page(db, req, response):
    if (
        response.status_code not in (200, 404)
        or response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "text/html"
        or not await owner.signed_in(db, req)
    ):
        return response
    body = response.body.decode("utf-8")
    closing = re.compile(r"</body\s*>", re.I)
    body = closing.sub(lambda m: OWNER_SITE_LINK + m[0], body, count=1) if closing.search(body) else body + OWNER_SITE_LINK
    response.body = body.encode("utf-8")
    response = privacy.no_store(response)
    response.headers["Content-Length"] = str(len(response.body))
    vary = response.headers.get("Vary", "")
    if not any(x.strip().lower() in ("cookie", "*") for x in vary.split(",")):
        response.headers["Vary"] = vary + ", Cookie" if vary else "Cookie"
    return response
