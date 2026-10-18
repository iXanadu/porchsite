"""Fixed OAuth protocol CORS; paired with the Worker fixture and matrix."""
import json
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from unittest.mock import AsyncMock
from starlette.responses import Response
from server.app import oauth,oauth_cors
from .web import signed_in,MCP_HEADERS
from .test_web_oauth import pkce,authorize_url,consent,REDIRECT

FIXTURE = json.loads((Path(__file__).resolve().parents[3]/"spec/fixtures/oauth-cors.json").read_text())

def cors(response):
    headers = dict(response.headers)
    assert {k:v for k,v in headers.items() if k.startswith("access-control-")} == {k.lower():v for k,v in FIXTURE["headers"].items()}
    assert all(v.strip().lower() != "origin" for v in headers.get("vary","").split(","))


def test_oauth_cors_identity_body_status_cache_and_vary():
    assert oauth_cors.CORS == FIXTURE["headers"]
    for row in FIXTURE["vary"]:
        for status in (200,400):
            headers = {"Content-Type":"text/plain","Cache-Control":"no-store","ETag":"unchanged","X-Other":"kept","Access-Control-Allow-Origin":"https://other.example","Access-Control-Allow-Credentials":"true","Access-Control-Allow-Private-Network":"true"}
            if row["value"] is not None:headers["Vary"] = row["value"]
            body = "unchanged body \n ©".encode()
            response = oauth_cors.apply("/oauth/token",Response(body,status_code=status,headers=headers))
            cors(response)
            assert response.status_code == status and response.body == body
            assert response.headers.get("Vary") == row["expected"]
            for name in ("Content-Type","Cache-Control","ETag","X-Other"):
                assert response.headers[name] == headers[name]
    for path in ("/authorize","/mcp","/review/","/","/oauth/register/","/.well-known/oauth-protected-resource/other"):
        response = Response("unchanged",headers={"Access-Control-Allow-Origin":"original","Vary":"Origin"})
        assert oauth_cors.apply(path,response) is response
    response = Response("kept")
    response.raw_headers.extend([(b"vary",b"Origin, Accept"),(b"vary",b"Authorization")])
    oauth_cors.apply("/oauth/token",response)
    assert response.headers["vary"] == "Accept, Authorization"


async def test_oauth_cors_identity_all_paths_methods_and_origin_forms(http):
    for path in FIXTURE["paths"]:
        for method in ("GET","HEAD","OPTIONS","POST"):
            baseline = None
            for origin in (None,"https://site.example","https://other.example","null","","invalid origin","https://one.example, https://two.example"):
                headers = {} if origin is None else {"Origin":origin}
                response = await http.request(method,path,headers=headers,**({"json":{}} if method == "POST" else {}))
                cors(response)
                snapshot = (response.status_code,response.content,{k:v for k,v in response.headers.items() if not k.startswith("access-control-")})
                if baseline is not None:assert snapshot == baseline,(path,method,origin)
                else:baseline = snapshot
                if method == "OPTIONS":
                    assert response.status_code == 204 and "content-length" not in response.headers
                elif path.startswith("/.well-known/") and method in ("GET","HEAD"):
                    assert response.status_code == 200
                else:assert response.status_code >= 400
    for path in FIXTURE["paths"]:
        response = await http.options(path,headers=[("Origin","https://one.example"),("Origin","https://two.example")])
        cors(response)
        assert response.status_code == 204


async def test_oauth_cors_identity_preflight_no_storage_or_fetch(app,http,monkeypatch):
    class NoStorage:
        def __getattr__(self,name):raise AssertionError("preflight storage lookup")
    monkeypatch.setattr(app,"_pool",NoStorage())
    fetch = AsyncMock(side_effect=AssertionError("unexpected metadata fetch"))
    monkeypatch.setattr(oauth,"capped_public_fetch",fetch)
    for path in FIXTURE["paths"]:
        for origin in (None,"","https://site.example","null","https://other.example","invalid origin"):
            headers = {"Authorization":"Bearer prk_invalid"}
            if origin is not None:headers["Origin"] = origin
            response = await http.options(path,headers=headers)
            cors(response)
            assert response.status_code == 204 and response.content == b"" and "content-length" not in response.headers
    fetch.assert_not_awaited()


async def test_oauth_cors_identity_valid_flow_keeps_mcp_authority(db,http):
    origin = {"Origin":"https://other.example"}
    registered = await http.post("/oauth/register",headers=origin,json={"client_name":"CORS test","redirect_uris":[REDIRECT],"token_endpoint_auth_method":"none"})
    cors(registered)
    assert registered.status_code == 201
    client = registered.json()
    verifier,challenge = pkce()
    _,done = await consent(http,await signed_in(db),authorize_url(client["client_id"],challenge),label="CORS test")
    assert done.status_code == 302
    code = parse_qs(urlsplit(done.headers["location"]).query)["code"][0]
    fields = {"grant_type":"authorization_code","code":code,"redirect_uri":REDIRECT,"client_id":client["client_id"],"code_verifier":verifier}
    token = await http.post("/oauth/token",headers=origin,data=fields)
    cors(token)
    assert token.status_code == 200 and "no-store" in token.headers["cache-control"]
    replay = await http.post("/oauth/token",headers=origin,data=fields)
    cors(replay)
    assert replay.status_code >= 400
    refused = await http.post("/mcp",headers={**MCP_HEADERS,**origin,"Authorization":"Bearer "+token.json()["access_token"]},json={"jsonrpc":"2.0","id":1,"method":"tools/list"})
    assert refused.status_code == 403
    assert refused.headers["access-control-allow-methods"] == "GET, POST, OPTIONS"
